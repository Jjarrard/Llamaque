"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import styles from "./project.module.css";
import type { LogEntry, ManifestEntry, Project, Task } from "./types";
import TaskTree from "./TaskTree";
import LogPanel, { agentClass } from "./LogPanel";
import StageTracker from "./StageTracker";
import FileStatusPanel, { type FileStatus } from "./FileStatusPanel";
import FeedbackLedgerPanel from "./FeedbackLedgerPanel";
import OutputFilesPanel from "./OutputFilesPanel";
import ConfirmDialog from "./ConfirmDialog";
import {
  formatElapsed,
  getPrimaryFile,
} from "./helpers";
import {
  deriveCurrentStatus,
  deriveStageStates,
  PIPELINE_STAGES,
  deriveIsRunning,
} from "@/lib/status";












const badgeClass: Record<string, string> = {
  pending: styles.badgePending,
  running: styles.badgeRunning,
  paused: styles.badgePaused,
  review: styles.badgeReview,
  done: styles.badgeDone,
};



export default function ProjectPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.id as string;

  const [project, setProject] = useState<Project | null>(null);
  const [taskList, setTaskList] = useState<Task[]>([]);
  const [logEntries, setLogEntries] = useState<LogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  // Optimistic running: set true immediately when user clicks Run so the UI
  // shows "running" before the first DB poll confirms it. Expires after 8s.
  const [optimisticRunning, setOptimisticRunning] = useState(false);
  const optimisticStartRef = useRef(0);
  const effectiveRunning = running || optimisticRunning;
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [resetStage, setResetStage] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [previewKey, setPreviewKey] = useState(0);
  const [feedbackText, setFeedbackText] = useState("");
  const [showFeedbackInput, setShowFeedbackInput] = useState(false);
  const [showOutput, setShowOutput] = useState(false);
  const [outputFiles, setOutputFiles] = useState<
    { path: string; content: string }[]
  >([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [editingNameValue, setEditingNameValue] = useState("");
  const [editingDescValue, setEditingDescValue] = useState("");
  const [editingDesc, setEditingDesc] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);
  const [runStartTime, setRunStartTime] = useState<Date | null>(null);
  // Wall-clock time, refreshed every second while running, so render can show
  // elapsed times without reading the clock itself.
  const [nowMs, setNowMs] = useState(0);
  const [streamOutput, setStreamOutput] = useState<string>("");
  const streamOutputRef = useRef<HTMLPreElement>(null);





  const fetchProject = useCallback(async () => {
    const res = await fetch(`/api/projects/${projectId}`);
    if (res.ok) {
      const data = await res.json();
      setProject(data.project);
      setTaskList(data.tasks);
      const isNowRunning = deriveIsRunning(data.project.status, data.tasks);
      setRunning(isNowRunning);
      // Once the DB confirms running, optimistic flag is no longer needed.
      // If not running and the 8s grace window has passed, expire optimistic.
      if (isNowRunning) {
        setOptimisticRunning(false);
      } else if (Date.now() - optimisticStartRef.current > 8000) {
        setOptimisticRunning(false);
      }
    }
  }, [projectId]);

  useEffect(() => {
    // fetchProject only sets state after awaiting the request
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchProject();
  }, [fetchProject]);

  // Fetch available models from Ollama
  useEffect(() => {
    fetch("/api/models")
      .then((res) => (res.ok ? res.json() : []))
      .then((models: string[]) => setAvailableModels(models))
      .catch(() => {});
  }, []);

  const handleSaveName = async () => {
    const trimmed = editingNameValue.trim();
    if (!trimmed || trimmed === project?.name) {
      setEditingName(false);
      return;
    }
    await fetch(`/api/projects/${projectId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "update_meta", name: trimmed }),
    });
    setProject((p) => (p ? { ...p, name: trimmed } : p));
    setEditingName(false);
  };

  const handleSaveDesc = async () => {
    if (editingDescValue === project?.description) {
      setEditingDesc(false);
      return;
    }
    await fetch(`/api/projects/${projectId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "update_meta",
        description: editingDescValue,
      }),
    });
    setProject((p) => (p ? { ...p, description: editingDescValue } : p));
    setEditingDesc(false);
  };

  const handleModelChange = async (newModel: string) => {
    if (!project || newModel === project.primaryModel) return;
    const res = await fetch(`/api/projects/${projectId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "set_model", model: newModel }),
    });
    if (res.ok) {
      setProject({ ...project, primaryModel: newModel });
    }
  };

  const handleThreadProfileChange = async (
    threadProfile: "low" | "med" | "high",
  ) => {
    if (!project || threadProfile === project.threadProfile) return;
    const res = await fetch(`/api/projects/${projectId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "set_thread_profile", threadProfile }),
    });
    if (res.ok) {
      setProject({ ...project, threadProfile });
    }
  };

  // SSE for live logs + fallback HTTP polling
  useEffect(() => {
    let lastSeenLogId = 0;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;

    // Debounced project refresh — coalesces rapid SSE messages into one fetch
    const scheduleRefresh = () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        fetchProject();
      }, 500);
    };

    // Track highest log ID we've seen
    const addEntries = (entries: LogEntry[]) => {
      setLogEntries((prev) => {
        const existingIds = new Set(prev.map((l) => l.id));
        const newOnes = entries.filter((e) => !existingIds.has(e.id));
        if (newOnes.length === 0) return prev;
        const merged = [...prev, ...newOnes].sort((a, b) => a.id - b.id);
        lastSeenLogId = merged[merged.length - 1].id;
        return merged;
      });
    };

    // SSE connection
    const es = new EventSource(`/api/projects/${projectId}/stream`);
    eventSourceRef.current = es;

    es.onmessage = (event) => {
      try {
        const entry: LogEntry = JSON.parse(event.data);
        addEntries([entry]);
        // Refresh task data on every log (debounced)
        scheduleRefresh();
      } catch {
        // Ignore parse errors
      }
    };

    // Fallback: poll for logs via HTTP every 3s in case SSE drops
    const pollLogs = async () => {
      try {
        const res = await fetch(
          `/api/projects/${projectId}/stream/poll?after=${lastSeenLogId}`,
        );
        if (res.ok) {
          const data = await res.json();
          if (data.logs && data.logs.length > 0) {
            addEntries(data.logs);
            scheduleRefresh();
          }
        }
      } catch {
        // Ignore
      }
    };

    const pollInterval = setInterval(pollLogs, 3000);

    return () => {
      es.close();
      clearInterval(pollInterval);
      if (refreshTimer) clearTimeout(refreshTimer);
    };
  }, [projectId, fetchProject]);


  // Poll task status while running — use a faster 2s interval
  // and do a final fetch when running transitions to false
  const prevRunningRef = useRef(false);

  // Tick the clock while the pipeline is running. A run started elsewhere
  // (another tab, or found by polling) is timed from when we first saw it.
  useEffect(() => {
    if (!effectiveRunning) return;
    const interval = setInterval(() => {
      const now = Date.now();
      setRunStartTime((prev) => prev ?? new Date(now));
      setNowMs(now);
    }, 1000);
    return () => clearInterval(interval);
  }, [effectiveRunning]);
  const elapsedSeconds =
    effectiveRunning && runStartTime && nowMs > 0
      ? Math.max(0, Math.floor((nowMs - runStartTime.getTime()) / 1000))
      : 0;

  // Poll for live streaming token output while running
  useEffect(() => {
    if (!effectiveRunning) return;
    let cancelled = false;
    const poll = async () => {
      if (cancelled) return;
      try {
        const res = await fetch(`/api/projects/${projectId}/stream/current`);
        if (res.status === 204) {
          // No active stream — model between calls
          if (!cancelled) setStreamOutput("");
        } else if (res.ok) {
          const data = await res.json();
          if (!cancelled) {
            setStreamOutput(data.text ?? "");
            // Auto-scroll stream output panel
            if (streamOutputRef.current) {
              streamOutputRef.current.scrollTop =
                streamOutputRef.current.scrollHeight;
            }
          }
        }
      } catch {
        // Ignore
      }
      if (!cancelled) {
        setTimeout(poll, 400);
      }
    };
    poll();
    return () => {
      cancelled = true;
    };
  }, [effectiveRunning, projectId]);

  useEffect(() => {
    if (effectiveRunning) {
      prevRunningRef.current = true;
      const interval = setInterval(fetchProject, 2000);
      return () => clearInterval(interval);
    } else if (prevRunningRef.current) {
      // Pipeline just stopped — do a final fetch to pick up latest state
      prevRunningRef.current = false;
      // fetchProject only sets state after awaiting the request
      // eslint-disable-next-line react-hooks/set-state-in-effect
      fetchProject();
    }
  }, [effectiveRunning, fetchProject]);

  const markRunStarted = () => {
    const now = new Date();
    optimisticStartRef.current = now.getTime();
    setOptimisticRunning(true);
    setRunStartTime(now);
    setNowMs(now.getTime());
    setStreamOutput("");
  };

  const handleRun = async (stage: string = "all", breakdownDepth?: number) => {
    setError(null);
    const body: Record<string, unknown> = { stage };
    if (breakdownDepth !== undefined) body.breakdownDepth = breakdownDepth;
    const res = await fetch(`/api/projects/${projectId}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      markRunStarted();
    } else {
      const data = await res.json();
      setError(data.error || "Failed to start pipeline");
    }
  };

  const handleStop = async () => {
    await fetch(`/api/projects/${projectId}/run`, { method: "DELETE" });
    setOptimisticRunning(false);
    setRunning(false);
    setRunStartTime(null);
    fetchProject();
  };

  const handleApprove = async (taskId: number) => {
    await fetch(`/api/tasks/${taskId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "approve" }),
    });
    fetchProject();
  };

  const handleReject = async (taskId: number) => {
    await fetch(`/api/tasks/${taskId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "reject" }),
    });
    fetchProject();
  };

  const handleApproveAll = async () => {
    await fetch(`/api/projects/${projectId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "approve_all" }),
    });
    fetchProject();
  };

  const handleStuckAction = async (
    taskId: number,
    action: "retry" | "skip",
  ) => {
    await fetch(`/api/tasks/${taskId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    fetchProject();
  };

  const handleDeleteProject = async () => {
    await fetch(`/api/projects/${projectId}`, { method: "DELETE" });
    router.push("/");
  };

  const handleResetStage = async (stage: string) => {
    setResetStage(null);
    setError(null);
    const res = await fetch(`/api/projects/${projectId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "reset_stage", stage }),
    });
    if (res.ok) {
      setLogEntries([]);
      fetchProject();
    } else {
      const data = await res.json();
      setError(data.error || "Failed to reset stage");
    }
  };



  const handleRunQA = async () => {
    setError(null);
    const res = await fetch(`/api/projects/${projectId}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stage: "qa" }),
    });
    if (res.ok) {
      markRunStarted();
    } else {
      const data = await res.json();
      setError(data.error || "Failed to start QA pass");
    }
  };

  const handleSubmitFeedback = async () => {
    if (!feedbackText.trim() || effectiveRunning) return;
    setError(null);
    const res = await fetch(`/api/projects/${projectId}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        stage: "feedback",
        feedback: feedbackText.trim(),
      }),
    });
    if (res.ok) {
      markRunStarted();
      setFeedbackText("");
    } else {
      const data = await res.json();
      setError(data.error || "Failed to start feedback pass");
    }
  };

  // Fetch all output files for the project
  const fileManifestJson = project?.fileManifest;
  const fetchOutputFiles = useCallback(async () => {
    if (!fileManifestJson) return;
    try {
      const manifest: ManifestEntry[] = JSON.parse(fileManifestJson);
      const files: { path: string; content: string }[] = [];
      for (const f of manifest) {
        try {
          const res = await fetch(
            `/api/projects/${projectId}/output?file=${encodeURIComponent(f.path)}&raw=1`,
          );
          if (res.ok) {
            const content = await res.text();
            files.push({ path: f.path, content });
          }
        } catch {
          // Skip file
        }
      }
      setOutputFiles(files);
      if (files.length > 0) {
        setSelectedFile((prev) => prev || files[0].path);
      }
    } catch {
      // Invalid manifest
    }
  }, [fileManifestJson, projectId]);

  const handleToggleOutput = () => {
    if (!showOutput) {
      fetchOutputFiles();
    }
    setShowOutput((v) => !v);
  };

  // Compute what's available for stage buttons
  const hasAwaitingApproval = taskList.some(
    (t) => t.status === "awaiting_approval",
  );
  // Leaf tasks (depth >= 2) that have been executed to completion
  const hasExecutedLeafTasks = taskList.some(
    (t) => t.depth >= 2 && t.status === "done",
  );
  // Any tasks that still need processing (pending breakdown or ready for execution)
  const completedStages: string[] = project
    ? JSON.parse(project.completedStages || "[]")
    : [];

  // Determine which stage is currently running from the most recent STAGE log
  // in the CURRENT run only (ignore logs from previous runs).
  // activeStage comes directly from the DB field project.currentStage —
  // written by the pipeline at stage start, cleared at stage end.
  // No log inference needed.
  const activeStage: string | null = effectiveRunning
    ? (project?.currentStage ?? null)
    : null;

  const currentStatus = project
    ? deriveCurrentStatus(
        taskList,
        project.status,
        effectiveRunning,
        activeStage,
      )
    : {
        label: "Loading…",
        phase: "idle",
        color: "muted" as const,
        progressPct: 0,
      };

  const stageStates = deriveStageStates(
    taskList,
    completedStages,
    effectiveRunning,
    activeStage,
  );

  const statusColorClass: Record<string, string> = {
    muted: styles.statusBarMuted,
    accent: styles.statusBarAccent,
    success: styles.statusBarSuccess,
    warning: styles.statusBarWarning,
    danger: styles.statusBarDanger,
  };


  // Check if output exists (leaf tasks executed means output files have content)
  const hasOutputFiles = hasExecutedLeafTasks;

  // Check if there are remaining stages to run (for Run All button)
  const hasRemainingStages = PIPELINE_STAGES.some(
    (s) => s.key !== "feedback" && stageStates[s.key] === "pending",
  );
  const canRunAll =
    !effectiveRunning &&
    project?.status !== "done" &&
    !hasAwaitingApproval &&
    hasRemainingStages;

  // Filtered log entries (STAGE entries are internal - hide from log panel)
  const visibleLogs = logEntries.filter((e) => e.agent !== "STAGE");


  // Last activity for "Now Doing" banner — prefer DB-backed currentActivity
  // (set by pipeline in real-time) over log polling.
  const lastActivity =
    visibleLogs.length > 0 ? visibleLogs[visibleLogs.length - 1] : null;

  // Parse "[AGENT] message" out of the DB activity field
  const liveActivity = (() => {
    const raw = project?.currentActivity;
    if (!raw) return null;
    const m = raw.match(/^\[([^\]]+)\]\s*(.*)$/);
    if (m) return { agent: m[1], message: m[2] };
    return { agent: "SYS", message: raw };
  })();

  // File status derived from manifest + task list
  const manifestFiles: ManifestEntry[] = (() => {
    if (!project?.fileManifest) return [];
    try {
      return JSON.parse(project.fileManifest);
    } catch {
      return [];
    }
  })();
  const fileStatusMap: Record<string, FileStatus> = {};
  for (const f of manifestFiles) {
    const fileTasks = taskList.filter((t) => t.filePath === f.path);
    if (fileTasks.length === 0) {
      // Files no feature was assigned to are written from a default spec
      // during Execute, without tasks of their own.
      fileStatusMap[f.path] = completedStages.includes("execute")
        ? "done"
        : "pending";
    } else if (fileTasks.some((t) => t.status === "executing")) {
      fileStatusMap[f.path] = "writing";
    } else if (fileTasks.every((t) => t.status === "done")) {
      fileStatusMap[f.path] = "done";
    } else {
      fileStatusMap[f.path] = "pending";
    }
  }



  if (!project) {
    return (
      <div className={styles.container}>
        <p className={styles.emptyTasks}>Loading...</p>
      </div>
    );
  }


  return (
    <div className={styles.container}>
      <div className={styles.topBar}>
        <Link href="/" className={styles.backLink}>
          &larr; All Projects
        </Link>
        <div className={styles.topBarActions}>
          {availableModels.length > 0 && (
            <select
              className={styles.modelSelect}
              value={project.primaryModel}
              onChange={(e) => handleModelChange(e.target.value)}
              disabled={running}
              title="Change model"
            >
              {availableModels.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
              {!availableModels.includes(project.primaryModel) && (
                <option value={project.primaryModel}>
                  {project.primaryModel}
                </option>
              )}
            </select>
          )}
          <div className={styles.threadPicker}>
            <button
              type="button"
              className={`${styles.threadBtn} ${project.threadProfile === "low" ? styles.threadBtnActive : ""}`}
              onClick={() => handleThreadProfileChange("low")}
              disabled={running}
            >
              Low
            </button>
            <button
              type="button"
              className={`${styles.threadBtn} ${project.threadProfile === "med" ? styles.threadBtnActive : ""}`}
              onClick={() => handleThreadProfileChange("med")}
              disabled={running}
            >
              Med
            </button>
            <button
              type="button"
              className={`${styles.threadBtn} ${project.threadProfile === "high" ? styles.threadBtnActive : ""}`}
              onClick={() => handleThreadProfileChange("high")}
              disabled={running}
            >
              High
            </button>
          </div>
          <button
            className={styles.deleteBtn}
            onClick={() => setShowDeleteConfirm(true)}
            title="Delete project"
          >
            Delete
          </button>
        </div>
      </div>
      {project.threadProfile === "high" && (
        <p className={styles.highThreadWarning}>
          Warning: High uses all CPU cores and may make your machine sluggish.
        </p>
      )}

      {/* ── Project header: editable title + description ── */}
      <div className={styles.projectHeader}>
        <div className={styles.projectHeaderTop}>
          {editingName ? (
            <input
              className={styles.projectNameInput}
              value={editingNameValue}
              autoFocus
              onChange={(e) => setEditingNameValue(e.target.value)}
              onBlur={handleSaveName}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSaveName();
                if (e.key === "Escape") setEditingName(false);
              }}
            />
          ) : (
            <h1
              className={styles.projectNameDisplay}
              onClick={() => {
                setEditingNameValue(project.name);
                setEditingName(true);
              }}
              title="Click to edit name"
            >
              {project.name}
            </h1>
          )}
          <span
            className={
              badgeClass[effectiveRunning ? "running" : project.status] ||
              styles.badgePending
            }
          >
            {effectiveRunning ? "running" : project.status}
          </span>
        </div>
        {editingDesc ? (
          <textarea
            className={styles.projectDescInput}
            value={editingDescValue}
            autoFocus
            rows={3}
            onChange={(e) => setEditingDescValue(e.target.value)}
            onBlur={handleSaveDesc}
            onKeyDown={(e) => {
              if (e.key === "Escape") setEditingDesc(false);
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey))
                handleSaveDesc();
            }}
          />
        ) : (
          <p
            className={styles.projectDescDisplay}
            onClick={() => {
              setEditingDescValue(project.description);
              setEditingDesc(true);
            }}
            title="Click to edit description"
          >
            {project.description || (
              <span className={styles.projectDescPlaceholder}>
                Add a description…
              </span>
            )}
          </p>
        )}
      </div>

      {/* ── Action Bar: status + stage tracker + actions ── */}
      <div
        className={`${styles.actionBar} ${statusColorClass[currentStatus.color] || styles.statusBarMuted} ${effectiveRunning ? styles.actionBarRunning : ""}`}
      >
        {/* Left: status label */}
        <div className={styles.actionBarStatus}>
          {effectiveRunning ? (
            <span className={styles.runningDot} />
          ) : currentStatus.color === "accent" ? (
            <span className={styles.statusBarPulse}>●</span>
          ) : null}
          <span
            className={`${styles.actionBarLabel} ${effectiveRunning ? styles.actionBarLabelRunning : ""}`}
          >
            {effectiveRunning
              ? activeStage
                ? `Running · ${activeStage.toUpperCase()}`
                : "Running…"
              : currentStatus.label}
          </span>
          {effectiveRunning && elapsedSeconds > 0 && (
            <span className={styles.elapsedBadge}>
              {formatElapsed(elapsedSeconds)}
            </span>
          )}
        </div>

        {/* Right: utility + stop/run-all */}
        <div className={styles.actionBarButtons}>
          {hasOutputFiles && (
            <>
              <button
                className={styles.actionUtility}
                onClick={() => {
                  setPreviewKey((k) => k + 1);
                  setShowPreview((p) => !p);
                }}
                title={showPreview ? "Hide preview" : "Show preview"}
              >
                {showPreview ? "✕ Preview" : "Preview"}
              </button>
              <button
                className={styles.actionUtility}
                onClick={handleToggleOutput}
                title={
                  showOutput
                    ? "Hide files"
                    : "View generated files & run instructions"
                }
              >
                {showOutput ? "✕ Files" : "📁 Files"}
              </button>
              <a
                className={styles.actionUtility}
                href={`/api/projects/${projectId}/download`}
                title="Download project as ZIP"
              >
                ⬇ Download
              </a>
              <a
                className={styles.actionUtility}
                href={`/api/projects/${projectId}/output?file=${getPrimaryFile(project?.fileManifest)}`}
                target="_blank"
                rel="noopener noreferrer"
                title="Open in new tab"
              >
                ↗ Open
              </a>
            </>
          )}
          {effectiveRunning ? (
            <button className={styles.stopBtn} onClick={handleStop}>
              <span className={styles.stopIcon} />
              Stop
            </button>
          ) : (
            <>
              {canRunAll && (
                <button
                  className={styles.actionRunAll}
                  onClick={() => handleRun("all")}
                >
                  ▶▶ Run All
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {/* ── Stage Pipeline Tracker ── */}
      <StageTracker
        stageStates={stageStates}
        effectiveRunning={effectiveRunning}
        handleRun={handleRun}
        handleRunQA={handleRunQA}
        handleApproveAll={handleApproveAll}
        setResetStage={setResetStage}
        setShowFeedbackInput={setShowFeedbackInput}
      />

      {/* ── Activity Banner — live "what is happening right now" ── */}
      {effectiveRunning && (liveActivity || lastActivity) && (
        <div className={styles.activityBanner}>
          <span className={styles.activityPulse} />
          <span
            className={`${styles.activityAgent} ${agentClass[liveActivity?.agent || lastActivity?.agent || "SYS"] || ""}`}
          >
            [{liveActivity?.agent || lastActivity?.agent}]
          </span>
          <span className={styles.activityMessage}>
            {liveActivity?.message || lastActivity?.message}
          </span>
          {activeStage && (
            <span className={styles.activityStage}>
              {activeStage.toUpperCase()}
              {project?.stageStartedAt && nowMs > 0
                ? ` · ${formatElapsed(Math.max(0, Math.floor((nowMs - project.stageStartedAt) / 1000)))}`
                : ""}
              {project && project.activityCounter > 0
                ? ` · ${project.activityCounter} updates`
                : ""}
            </span>
          )}
        </div>
      )}

      {/* ── File Status Panel — live file manifest with status dots ── */}
      {manifestFiles.length > 0 && (
        <FileStatusPanel
          manifestFiles={manifestFiles}
          fileStatusMap={fileStatusMap}
        />
      )}

      {/* ── Live Model Output — streaming token view ── */}
      {effectiveRunning && (
        <div className={styles.streamPanel}>
          <div className={styles.streamPanelHeader}>
            <span className={styles.streamPanelTitle}>
              {streamOutput ? (
                <>
                  <span className={styles.streamPanelDot} />
                  Model Output
                </>
              ) : (
                <>
                  <span className={styles.streamPanelWaiting} />
                  Waiting for model…
                </>
              )}
            </span>
            {streamOutput && (
              <span className={styles.streamPanelChars}>
                {streamOutput.length} chars
              </span>
            )}
          </div>
          <pre
            ref={streamOutputRef}
            className={`${styles.streamPanelOutput} ${!streamOutput ? styles.streamPanelEmpty : ""}`}
          >
            {streamOutput || "Ollama is thinking…"}
            {streamOutput && <span className={styles.streamCursor} />}
          </pre>
        </div>
      )}

      {/* ── Feedback Progress Ledger (Done / Now / Next) ── */}
      <FeedbackLedgerPanel ledgerJson={project.feedbackLedger} />

      {/* ── Feedback Input Panel ── */}
      {showFeedbackInput && (
        <div className={styles.feedbackPanel}>
          <div className={styles.feedbackHeader}>
            <span className={styles.feedbackTitle}>✎ Feedback</span>
            {!running && (
              <button
                className={styles.feedbackCloseBtn}
                onClick={() => setShowFeedbackInput(false)}
                title="Close"
              >
                ✕
              </button>
            )}
          </div>
          {effectiveRunning && activeStage === "feedback" ? (
            <div className={styles.feedbackRunning}>
              <span className={styles.stageSpinner} />
              Running feedback pass...
            </div>
          ) : (
            <>
              <textarea
                className={styles.feedbackTextarea}
                value={feedbackText}
                onChange={(e) => setFeedbackText(e.target.value)}
                placeholder="Describe what you'd like to change, fix, or improve..."
                rows={4}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleSubmitFeedback();
                  }
                }}
              />
              <div className={styles.feedbackActions}>
                <span className={styles.feedbackHint}>
                  Enter to submit · Shift+Enter for new line
                </span>
                <button
                  className={styles.feedbackSubmitBtn}
                  onClick={handleSubmitFeedback}
                  disabled={!feedbackText.trim()}
                >
                  Submit Feedback
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* ── Progress Bar ── */}
      {taskList.length > 0 && (
        <div className={styles.progressBarContainer}>
          <div
            className={styles.progressBarFill}
            style={{
              width: `${currentStatus.progressPct}%`,
              background:
                currentStatus.progressPct >= 100
                  ? "var(--success)"
                  : "var(--accent)",
            }}
          />
          <span className={styles.progressBarLabel}>
            {currentStatus.progressPct}%
          </span>
        </div>
      )}

      {/* ── Preview Iframe ── */}
      {showPreview && hasOutputFiles && (
        <div className={styles.previewContainer}>
          <iframe
            key={previewKey}
            className={styles.previewIframe}
            src={`/api/projects/${projectId}/output?file=${getPrimaryFile(project?.fileManifest)}`}
            title="Project Preview"
            sandbox="allow-scripts allow-same-origin"
          />
        </div>
      )}

      {/* ── Files & Output Panel ── */}
      {showOutput && (
        <OutputFilesPanel
          project={project}
          outputFiles={outputFiles}
          selectedFile={selectedFile}
          setSelectedFile={setSelectedFile}
          onClose={() => setShowOutput(false)}
        />
      )}

      {/* Confirm reset dialog */}
      {resetStage && (
        <ConfirmDialog
          confirmLabel="Yes, re-run"
          onConfirm={() => handleResetStage(resetStage)}
          onCancel={() => setResetStage(null)}
        >
          Re-run <strong>{resetStage}</strong> stage? This will delete
          generated data from this stage onward and re-run it.
        </ConfirmDialog>
      )}

      {/* Confirm delete dialog */}
      {showDeleteConfirm && (
        <ConfirmDialog
          confirmLabel="Delete permanently"
          danger
          onConfirm={handleDeleteProject}
          onCancel={() => setShowDeleteConfirm(false)}
        >
          Delete <strong>{project.name}</strong>? This will permanently
          remove the project, all tasks, logs, and output files.
        </ConfirmDialog>
      )}

      {error && <div className={styles.error}>{error}</div>}

      <div className={styles.layout}>
        <TaskTree
          taskList={taskList}
          running={running}
          handleApprove={handleApprove}
          handleReject={handleReject}
          handleStuckAction={handleStuckAction}
          onTaskEdited={fetchProject}
        />

        <LogPanel logEntries={logEntries} effectiveRunning={effectiveRunning} />
      </div>
    </div>
  );
}
