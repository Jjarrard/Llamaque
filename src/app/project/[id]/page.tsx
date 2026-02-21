"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import styles from "./project.module.css";

type Task = {
  id: number;
  projectId: number;
  parentId: number | null;
  description: string;
  status: string;
  depth: number;
  sortOrder: number;
  filePath: string | null;
  output: string | null;
  qAReason: string | null;
  stuckReason: string | null;
  retryCount: number;
  editRetryCount: number;
  parseRetryCount: number;
};

type Project = {
  id: number;
  name: string;
  description: string;
  status: string;
  primaryModel: string;
};

type LogEntry = {
  id: number;
  agent: string;
  message: string;
  taskId: number | null;
  createdAt: string;
  hasRaw?: boolean;
};

type LogDetail = {
  rawPrompt: string | null;
  rawResponse: string | null;
};

const DEPTH_LABELS: Record<number, string> = {
  1: "Epic",
  2: "Feature",
};

const DEPTH_LABEL_CLASS: Record<number, string> = {
  1: styles.depthLabelEpic,
  2: styles.depthLabelFeature,
};

const statusDotClass: Record<string, string> = {
  awaiting_approval: styles.statusAwaitingApproval,
  pending: styles.statusPending,
  decomposing: styles.statusDecomposing,
  ready: styles.statusReady,
  executing: styles.statusExecuting,
  qa_check: styles.statusQaCheck,
  editing: styles.statusEditing,
  done: styles.statusDone,
  stuck: styles.statusStuck,
};

const agentClass: Record<string, string> = {
  PM: styles.logAgentPM,
  MGR: styles.logAgentMGR,
  DEV: styles.logAgentDEV,
  QA: styles.logAgentQA,
  EDT: styles.logAgentEDT,
  SYS: styles.logAgentSYS,
};

const badgeClass: Record<string, string> = {
  pending: styles.badgePending,
  running: styles.badgeRunning,
  paused: styles.badgePaused,
  done: styles.badgeDone,
};

/** Build a tree from flat task list */
function buildTree(tasks: Task[]) {
  const byParent = new Map<number | null, Task[]>();
  for (const t of tasks) {
    const list = byParent.get(t.parentId) || [];
    list.push(t);
    byParent.set(t.parentId, list);
  }
  return byParent;
}

export default function ProjectPage() {
  const params = useParams();
  const projectId = params.id as string;

  const [project, setProject] = useState<Project | null>(null);
  const [taskList, setTaskList] = useState<Task[]>([]);
  const [logEntries, setLogEntries] = useState<LogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [expandedLogs, setExpandedLogs] = useState<
    Record<number, LogDetail | null>
  >({});
  const [openAccordions, setOpenAccordions] = useState<Set<number>>(new Set());
  const logEndRef = useRef<HTMLDivElement>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  const toggleAccordion = (taskId: number) => {
    setOpenAccordions((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  };

  const toggleLogDetail = async (logId: number) => {
    if (expandedLogs[logId] !== undefined) {
      setExpandedLogs((prev) => {
        const next = { ...prev };
        delete next[logId];
        return next;
      });
      return;
    }
    setExpandedLogs((prev) => ({ ...prev, [logId]: null }));
    try {
      const res = await fetch(`/api/logs/${logId}`);
      if (res.ok) {
        const data = await res.json();
        setExpandedLogs((prev) => ({
          ...prev,
          [logId]: { rawPrompt: data.rawPrompt, rawResponse: data.rawResponse },
        }));
      }
    } catch {
      // Ignore
    }
  };

  const fetchProject = useCallback(async () => {
    const res = await fetch(`/api/projects/${projectId}`);
    if (res.ok) {
      const data = await res.json();
      setProject(data.project);
      setTaskList(data.tasks);
      setRunning(data.project.status === "running");
    }
  }, [projectId]);

  useEffect(() => {
    fetchProject();
  }, [fetchProject]);

  // SSE for live logs + fallback HTTP polling
  useEffect(() => {
    let sseAlive = true;
    let lastSeenLogId = 0;

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
      sseAlive = true;
      try {
        const entry: LogEntry = JSON.parse(event.data);
        addEntries([entry]);
      } catch {
        // Ignore parse errors
      }
    };

    es.onerror = () => {
      sseAlive = false;
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
    };
  }, [projectId]);

  // NO auto-scroll — user controls their own scroll position

  // Poll task status while running
  useEffect(() => {
    if (!running) return;
    const interval = setInterval(fetchProject, 5000);
    return () => clearInterval(interval);
  }, [running, fetchProject]);

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
      setRunning(true);
      fetchProject();
    } else {
      const data = await res.json();
      setError(data.error || "Failed to start pipeline");
    }
  };

  const handleStop = async () => {
    await fetch(`/api/projects/${projectId}/run`, { method: "DELETE" });
    setRunning(false);
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

  // Compute what's available for stage buttons
  const hasAwaitingApproval = taskList.some(
    (t) => t.status === "awaiting_approval",
  );
  const hasPendingAtDepth = (d: number) =>
    taskList.some((t) => t.depth === d && t.status === "pending");
  const hasReadyTasks = taskList.some((t) =>
    ["ready", "executing", "qa_check"].includes(t.status),
  );

  const tree = buildTree(taskList);

  /** Render a task and its children recursively */
  const renderTask = (task: Task) => {
    const children = tree.get(task.id) || [];
    const depthLabel = DEPTH_LABELS[task.depth] || "Task";
    const depthLabelCls =
      DEPTH_LABEL_CLASS[task.depth] || styles.depthLabelTask;
    const isWorkParent = task.depth === 2 && children.length > 0;
    const isOpen = openAccordions.has(task.id);

    return (
      <li key={task.id} className={styles.taskItem}>
        <div className={styles.taskRow}>
          <span className={`${styles.depthLabel} ${depthLabelCls}`}>
            {depthLabel}
          </span>
          <span
            className={`${styles.taskStatus} ${statusDotClass[task.status] || styles.statusPending}`}
          />
          <span
            className={`${styles.taskDesc} ${task.status === "stuck" ? styles.taskStuck : ""}`}
            title={task.description}
          >
            {isWorkParent ? (
              <button
                className={styles.accordionToggle}
                onClick={() => toggleAccordion(task.id)}
              >
                <span className={styles.accordionIcon}>
                  {isOpen ? "▾" : "▸"}
                </span>
                {task.description}
              </button>
            ) : (
              task.description
            )}
          </span>
          <span className={styles.taskStatusLabel}>
            {task.status === "awaiting_approval"
              ? "awaiting"
              : task.status.replace("_", " ")}
          </span>
          {task.status === "awaiting_approval" && (
            <span className={styles.approvalActions}>
              <button
                className={styles.approveBtn}
                onClick={() => handleApprove(task.id)}
              >
                ✓
              </button>
              <button
                className={styles.rejectBtn}
                onClick={() => handleReject(task.id)}
              >
                ✕
              </button>
            </span>
          )}
        </div>
        {task.status === "stuck" && task.stuckReason && (
          <div className={styles.stuckInfo}>
            <span className={styles.stuckReason}>{task.stuckReason}</span>
            <div className={styles.stuckActions}>
              <button
                className={styles.stuckBtn}
                onClick={() => handleStuckAction(task.id, "retry")}
              >
                Retry
              </button>
              <button
                className={styles.stuckBtn}
                onClick={() => handleStuckAction(task.id, "skip")}
              >
                Skip
              </button>
            </div>
          </div>
        )}
        {/* Children: for work parent (depth 3), wrap in accordion */}
        {children.length > 0 && (
          <>
            {isWorkParent ? (
              isOpen && (
                <ul className={styles.workList}>
                  {children.map((c) => renderTask(c))}
                </ul>
              )
            ) : (
              <ul className={styles.childList}>
                {children.map((c) => renderTask(c))}
              </ul>
            )}
          </>
        )}
      </li>
    );
  };

  if (!project) {
    return (
      <div className={styles.container}>
        <p className={styles.emptyTasks}>Loading...</p>
      </div>
    );
  }

  const rootTasks = tree.get(null) || [];

  return (
    <div className={styles.container}>
      <div className={styles.topBar}>
        <div>
          <Link href="/" className={styles.backLink}>
            &larr; All Projects
          </Link>
          <h1 className={styles.projectTitle}>
            {project.name}
            <span className={badgeClass[project.status] || styles.badgePending}>
              {project.status}
            </span>
          </h1>
        </div>
        <div className={styles.controls}>
          {!running ? (
            <>
              {taskList.length === 0 && (
                <button
                  className={styles.runBtn}
                  onClick={() => handleRun("decompose")}
                >
                  1. Decompose
                </button>
              )}
              {hasAwaitingApproval && (
                <button
                  className={styles.approveAllBtn}
                  onClick={handleApproveAll}
                >
                  Approve All Epics
                </button>
              )}
              {hasPendingAtDepth(1) && (
                <button
                  className={styles.stageBtn}
                  onClick={() => handleRun("breakdown", 1)}
                >
                  Epics → Features
                </button>
              )}
              {hasPendingAtDepth(2) && (
                <button
                  className={styles.stageBtn}
                  onClick={() => handleRun("breakdown", 2)}
                >
                  Features → Tasks
                </button>
              )}
              {hasReadyTasks && (
                <button
                  className={styles.stageBtn}
                  onClick={() => handleRun("execute")}
                >
                  Execute Tasks
                </button>
              )}
              {taskList.length > 0 && !hasAwaitingApproval && (
                <button
                  className={styles.runBtn}
                  onClick={() => handleRun("all")}
                >
                  Run All
                </button>
              )}
            </>
          ) : (
            <button className={styles.stopBtn} onClick={handleStop}>
              Stop
            </button>
          )}
        </div>
      </div>

      {error && <div className={styles.error}>{error}</div>}

      <div className={styles.layout}>
        {/* Task Tree */}
        <div className={styles.taskPanel}>
          <h2 className={styles.taskPanelTitle}>
            Tasks ({taskList.filter((t) => t.status === "done").length}/
            {taskList.length})
          </h2>
          {taskList.length === 0 ? (
            <p className={styles.emptyTasks}>
              No tasks yet. Hit Decompose to start.
            </p>
          ) : (
            <ul className={styles.taskList}>
              {rootTasks.map((task) => renderTask(task))}
            </ul>
          )}
        </div>

        {/* Log Panel */}
        <div className={styles.logPanel}>
          <h2 className={styles.logPanelTitle}>Live Log</h2>
          <div className={styles.logList}>
            {logEntries.map((entry) => (
              <div key={entry.id} className={styles.logEntry}>
                <div
                  className={`${styles.logRow} ${entry.hasRaw ? styles.logClickable : ""}`}
                  onClick={() => entry.hasRaw && toggleLogDetail(entry.id)}
                >
                  <span
                    className={`${styles.logAgent} ${agentClass[entry.agent] || ""}`}
                  >
                    [{entry.agent}]
                  </span>
                  <span className={styles.logMessage}>{entry.message}</span>
                  {entry.hasRaw && (
                    <span className={styles.logExpandIcon}>
                      {expandedLogs[entry.id] !== undefined ? "▾" : "▸"}
                    </span>
                  )}
                </div>
                {expandedLogs[entry.id] !== undefined && (
                  <div className={styles.logDetailBox}>
                    {expandedLogs[entry.id] === null ? (
                      <p className={styles.logDetailLoading}>Loading…</p>
                    ) : (
                      <>
                        <div className={styles.logDetailSection}>
                          <span className={styles.logDetailLabel}>Prompt</span>
                          <pre className={styles.logDetailPre}>
                            {expandedLogs[entry.id]!.rawPrompt || "(none)"}
                          </pre>
                        </div>
                        <div className={styles.logDetailSection}>
                          <span className={styles.logDetailLabel}>
                            Response
                          </span>
                          <pre className={styles.logDetailPre}>
                            {expandedLogs[entry.id]!.rawResponse || "(none)"}
                          </pre>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            ))}
            <div ref={logEndRef} />
          </div>
        </div>
      </div>
    </div>
  );
}
