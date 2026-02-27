"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
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
  completedStages: string;
  fileManifest: string | null;
};

function getPrimaryFile(manifestJson: string | null | undefined): string {
  if (!manifestJson) return "output.txt";
  try {
    const files = JSON.parse(manifestJson) as { path: string }[];
    return files[0]?.path || "output.txt";
  } catch {
    return "output.txt";
  }
}

type ManifestEntry = {
  path: string;
  type?: string;
  language?: string;
  description?: string;
};

/** Generate human-readable run instructions based on the file manifest */
function generateRunInstructions(
  manifest: ManifestEntry[],
  projectName: string,
): string {
  if (!manifest || manifest.length === 0) return "No output files yet.";

  const extensions = manifest.map((f) =>
    f.path.split(".").pop()?.toLowerCase() || "",
  );
  const hasReact = extensions.some((e) => ["tsx", "jsx"].includes(e));
  const hasHTML = extensions.some((e) => ["html", "htm"].includes(e));
  const hasPython = extensions.some((e) => e === "py");
  const hasNode = extensions.some((e) => ["js", "ts"].includes(e)) && !hasReact;
  const hasMarkdown = extensions.some((e) => ["md", "markdown"].includes(e));

  const lines: string[] = [`# How to run: ${projectName}\n`];
  lines.push(`Download the project files using the ⬇ Download button above.\n`);

  if (hasReact) {
    lines.push(`## React (TSX/JSX)\n`);
    lines.push(`You can preview TSX files directly in the browser using the **Preview** button.\n`);
    lines.push(`To run locally:\n`);
    lines.push(`\`\`\`bash`);
    lines.push(`# Create a new React project`);
    lines.push(`npx create-react-app my-app --template typescript`);
    lines.push(`cd my-app`);
    lines.push(`# Copy the generated .tsx files into src/`);
    lines.push(`# Then run:`);
    lines.push(`npm start`);
    lines.push(`\`\`\`\n`);
    lines.push(`Or use Vite:\n`);
    lines.push(`\`\`\`bash`);
    lines.push(`npm create vite@latest my-app -- --template react-ts`);
    lines.push(`cd my-app`);
    lines.push(`# Copy .tsx files into src/`);
    lines.push(`npm install && npm run dev`);
    lines.push(`\`\`\``);
  }

  if (hasHTML) {
    lines.push(`## HTML\n`);
    lines.push(`Open the .html file directly in a browser, or use a local server:\n`);
    lines.push(`\`\`\`bash`);
    lines.push(`npx serve .`);
    lines.push(`# or`);
    lines.push(`python3 -m http.server 8000`);
    lines.push(`\`\`\``);
  }

  if (hasPython) {
    lines.push(`## Python\n`);
    lines.push(`\`\`\`bash`);
    lines.push(`python3 ${manifest.find((f) => f.path.endsWith(".py"))?.path || "main.py"}`);
    lines.push(`\`\`\``);
    lines.push(`\nInstall dependencies if needed: \`pip install -r requirements.txt\``);
  }

  if (hasNode) {
    lines.push(`## Node.js\n`);
    lines.push(`\`\`\`bash`);
    lines.push(`node ${manifest.find((f) => f.path.endsWith(".js") || f.path.endsWith(".ts"))?.path || "index.js"}`);
    lines.push(`\`\`\``);
    lines.push(`\nFor TypeScript: \`npx tsx ${manifest.find((f) => f.path.endsWith(".ts"))?.path || "index.ts"}\``);
  }

  if (hasMarkdown && !hasReact && !hasHTML && !hasPython && !hasNode) {
    lines.push(`## Markdown\n`);
    lines.push(`Open the .md files in any Markdown viewer or editor.`);
  }

  lines.push(`\n## Files included\n`);
  for (const f of manifest) {
    lines.push(`- **${f.path}** — ${f.description || f.type || "output file"}`);
  }

  return lines.join("\n");
}

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
  RECOVER: styles.logAgentRECOVER,
};

const badgeClass: Record<string, string> = {
  pending: styles.badgePending,
  running: styles.badgeRunning,
  paused: styles.badgePaused,
  review: styles.badgeReview,
  done: styles.badgeDone,
};

/** Derive a single human-readable status string from task list + project state */
function deriveCurrentStatus(
  taskList: Task[],
  projectStatus: string,
  running: boolean,
  activeStage: string | null = null,
): {
  label: string;
  phase: string;
  color: "muted" | "accent" | "success" | "warning" | "danger";
  progressPct: number;
} {
  const totalTasks = taskList.length;
  const doneTasks = taskList.filter((t) => t.status === "done").length;
  const progressPct =
    totalTasks > 0 ? Math.round((doneTasks / totalTasks) * 100) : 0;

  if (projectStatus === "done") {
    return {
      label: "Complete — all tasks done",
      phase: "done",
      color: "success",
      progressPct: 100,
    };
  }

  if (projectStatus === "review" && !running) {
    return {
      label: "Stage complete — review and continue when ready",
      phase: "review",
      color: "warning",
      progressPct,
    };
  }

  if (!running && taskList.length === 0) {
    return {
      label: "Ready to start",
      phase: "idle",
      color: "muted",
      progressPct: 0,
    };
  }

  const hasAwaiting = taskList.some((t) => t.status === "awaiting_approval");
  const stuckTasks = taskList.filter((t) => t.status === "stuck");
  const executingTasks = taskList.filter((t) => t.status === "executing");
  const qaTasks = taskList.filter((t) => t.status === "qa_check");
  const editingTasks = taskList.filter((t) => t.status === "editing");
  const decomposingTasks = taskList.filter((t) => t.status === "decomposing");

  if (stuckTasks.length > 0 && !running) {
    return {
      label: `${stuckTasks.length} task${stuckTasks.length > 1 ? "s" : ""} stuck — needs attention`,
      phase: "stuck",
      color: "danger",
      progressPct,
    };
  }

  if (hasAwaiting && !running) {
    return {
      label: "Awaiting approval on epics",
      phase: "approval",
      color: "warning",
      progressPct,
    };
  }

  if (!running && totalTasks > 0) {
    if (projectStatus === "review") {
      return {
        label: `Stage complete — ${doneTasks}/${totalTasks} tasks done`,
        phase: "review",
        color: "warning",
        progressPct,
      };
    }
    return {
      label: `Paused — ${doneTasks}/${totalTasks} tasks done`,
      phase: "paused",
      color: "muted",
      progressPct,
    };
  }

  // Running states
  if (decomposingTasks.length > 0) {
    return {
      label: "Decomposing — breaking down into tasks…",
      phase: "decompose",
      color: "accent",
      progressPct,
    };
  }

  if (executingTasks.length > 0) {
    const name = executingTasks[0].description.slice(0, 50);
    return {
      label: `Executing — ${name}…`,
      phase: "execute",
      color: "accent",
      progressPct,
    };
  }

  if (qaTasks.length > 0) {
    return {
      label: `QA checking — reviewing output…`,
      phase: "qa",
      color: "accent",
      progressPct,
    };
  }

  if (editingTasks.length > 0) {
    return {
      label: `Editing — fixing QA issues…`,
      phase: "edit",
      color: "accent",
      progressPct,
    };
  }

  if (running) {
    if (activeStage) {
      const stageLabels: Record<string, string> = {
        architect: "Architect — planning file structure...",
        decompose: "Decomposing — breaking idea into epics...",
        breakdown: "Breakdown — creating tasks...",
        tdd: "TDD — writing tests...",
        execute: "Execute — writing code...",
        qa: "QA — reviewing output...",
        feedback: "Feedback — applying changes...",
      };
      if (stageLabels[activeStage]) {
        return {
          label: stageLabels[activeStage],
          phase: activeStage,
          color: "accent",
          progressPct,
        };
      }
    }
    return {
      label: `Running — ${doneTasks}/${totalTasks} tasks done`,
      phase: "running",
      color: "accent",
      progressPct,
    };
  }

  return {
    label: `${doneTasks}/${totalTasks} tasks done`,
    phase: "idle",
    color: "muted",
    progressPct,
  };
}

// ── Stage Pipeline Tracker ──

type StageKey =
  | "architect"
  | "decompose"
  | "breakdown"
  | "tdd"
  | "execute"
  | "qa"
  | "feedback";
type StageState = "pending" | "active" | "done" | "approval";

const PIPELINE_STAGES: { key: StageKey; label: string; runStage: string }[] = [
  { key: "architect", label: "Architect", runStage: "architect" },
  { key: "decompose", label: "Decompose", runStage: "decompose" },
  { key: "breakdown", label: "Breakdown", runStage: "breakdown" },
  { key: "tdd", label: "TDD", runStage: "tdd" },
  { key: "execute", label: "Execute", runStage: "execute" },
  { key: "qa", label: "QA", runStage: "qa" },
  { key: "feedback", label: "Feedback", runStage: "feedback" },
];

function deriveStageStates(
  taskList: Task[],
  completedStages: string[],
  running: boolean,
  activeStage: string | null,
): Record<StageKey, StageState> {
  const states: Record<StageKey, StageState> = {
    architect: "pending",
    decompose: "pending",
    breakdown: "pending",
    tdd: "pending",
    execute: "pending",
    qa: "pending",
    feedback: "pending",
  };

  // First pass — mark completed stages
  for (const s of PIPELINE_STAGES) {
    if (completedStages.includes(s.key)) {
      states[s.key] = "done";
    }
  }

  // Infer implied completions for stages added after projects were created:
  // architect must have run if decompose is done (tasks exist)
  if (states.decompose === "done") states.architect = "done";
  // tdd must have run if execute is done
  if (states.execute === "done") states.tdd = "done";

  // If running, mark the exact active stage (from emitted STAGE logs) or
  // fall back to the first non-done stage
  if (running) {
    const target = activeStage as StageKey | null;
    if (target && target in states && states[target] !== "done") {
      states[target] = "active";
    } else {
      for (const s of PIPELINE_STAGES) {
        if (states[s.key] !== "done") {
          states[s.key] = "active";
          break;
        }
      }
    }
  }

  // Special case: if decompose is done but epics need approval, mark breakdown as "approval"
  const hasAwaiting = taskList.some((t) => t.status === "awaiting_approval");
  if (hasAwaiting && states.breakdown !== "done" && !running) {
    states.breakdown = "approval";
  }

  return states;
}

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
  const router = useRouter();
  const projectId = params.id as string;

  const [project, setProject] = useState<Project | null>(null);
  const [taskList, setTaskList] = useState<Task[]>([]);
  const [logEntries, setLogEntries] = useState<LogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [pipelineSessionActive, setPipelineSessionActive] = useState(false);
  const consecutiveNotRunningRef = useRef(0);
  const effectiveRunning = running || pipelineSessionActive;
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [expandedLogs, setExpandedLogs] = useState<
    Record<number, LogDetail | null>
  >({});
  const [openAccordions, setOpenAccordions] = useState<Set<number>>(new Set());
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [resetStage, setResetStage] = useState<string | null>(null);
  const [logFilter, setLogFilter] = useState<string | null>(null);
  const [editingTask, setEditingTask] = useState<number | null>(null);
  const [editingDescription, setEditingDescription] = useState("");
  const [showPreview, setShowPreview] = useState(false);
  const [previewKey, setPreviewKey] = useState(0);
  const [feedbackText, setFeedbackText] = useState("");
  const [showFeedbackInput, setShowFeedbackInput] = useState(false);
  const [showOutput, setShowOutput] = useState(false);
  const [outputFiles, setOutputFiles] = useState<
    { path: string; content: string }[]
  >([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [showRunInstructions, setShowRunInstructions] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [editingNameValue, setEditingNameValue] = useState("");
  const [editingDescValue, setEditingDescValue] = useState("");
  const [editingDesc, setEditingDesc] = useState(false);
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
      // Derive running from project status OR active task statuses.
      // This handles the race where the pipeline hasn't set status=running
      // in the DB yet but tasks are already executing.
      const activeStatuses = [
        "executing",
        "decomposing",
        "qa_check",
        "editing",
      ];
      const hasActiveTasks = data.tasks.some((t: Task) =>
        activeStatuses.includes(t.status),
      );
      const isNowRunning = data.project.status === "running" || hasActiveTasks;
      setRunning(isNowRunning);
      if (isNowRunning) {
        consecutiveNotRunningRef.current = 0;
        setPipelineSessionActive(true);
      } else {
        consecutiveNotRunningRef.current += 1;
        if (consecutiveNotRunningRef.current >= 2) {
          setPipelineSessionActive(false);
        }
      }
    }
  }, [projectId]);

  useEffect(() => {
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

  // SSE for live logs + fallback HTTP polling
  useEffect(() => {
    let sseAlive = true;
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
      sseAlive = true;
      try {
        const entry: LogEntry = JSON.parse(event.data);
        addEntries([entry]);
        // Refresh task data on every log (debounced)
        scheduleRefresh();
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

  // NO auto-scroll — user controls their own scroll position

  // Auto-scroll log panel when new entries arrive
  const userScrolledUpRef = useRef(false);
  const logListRef = useRef<HTMLDivElement>(null);

  // Detect if user has scrolled up (so we don't fight them)
  const handleLogScroll = useCallback(() => {
    const el = logListRef.current;
    if (!el) return;
    // If user is within 80px of the bottom, consider them "following"
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    userScrolledUpRef.current = !atBottom;
  }, []);

  // Scroll to bottom when new log entries arrive (unless user scrolled up)
  useEffect(() => {
    const el = logListRef.current;
    if (!userScrolledUpRef.current && el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [logEntries, logFilter]);

  // Poll task status while running — use a faster 2s interval
  // and do a final fetch when running transitions to false
  const prevRunningRef = useRef(false);
  useEffect(() => {
    if (effectiveRunning) {
      prevRunningRef.current = true;
      const interval = setInterval(fetchProject, 2000);
      return () => clearInterval(interval);
    } else if (prevRunningRef.current) {
      // Pipeline just stopped — do a final fetch to pick up latest state
      prevRunningRef.current = false;
      fetchProject();
    }
  }, [effectiveRunning, fetchProject]);

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
      setPipelineSessionActive(true);
      consecutiveNotRunningRef.current = 0;
      // Don't call fetchProject() immediately — the 2s polling starts
      // now that running=true. Calling it here races with the pipeline
      // setting status to "running" in the DB and can revert running=false.
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

  const handleEditTask = async (taskId: number) => {
    if (!editingDescription.trim()) return;
    await fetch(`/api/tasks/${taskId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "edit_description",
        description: editingDescription.trim(),
      }),
    });
    setEditingTask(null);
    setEditingDescription("");
    fetchProject();
  };

  const startEditTask = (task: Task) => {
    setEditingTask(task.id);
    setEditingDescription(task.description);
  };

  const handleRunQA = async () => {
    setError(null);
    const res = await fetch(`/api/projects/${projectId}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stage: "qa" }),
    });
    if (res.ok) {
      setRunning(true);
      setPipelineSessionActive(true);
      consecutiveNotRunningRef.current = 0;
      // Same as handleRun — don't race fetchProject against pipeline startup
    } else {
      const data = await res.json();
      setError(data.error || "Failed to start QA pass");
    }
  };

  const handleSubmitFeedback = async () => {
    if (!feedbackText.trim() || running || pipelineSessionActive) return;
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
      setRunning(true);
      setPipelineSessionActive(true);
      consecutiveNotRunningRef.current = 0;
      setFeedbackText("");
      // Keep feedback panel open so the running spinner is visible
    } else {
      const data = await res.json();
      setError(data.error || "Failed to start feedback pass");
    }
  };

  // Fetch all output files for the project
  const fetchOutputFiles = useCallback(async () => {
    if (!project?.fileManifest) return;
    try {
      const manifest: ManifestEntry[] = JSON.parse(project.fileManifest);
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
      if (files.length > 0 && !selectedFile) {
        setSelectedFile(files[0].path);
      }
    } catch {
      // Invalid manifest
    }
  }, [project?.fileManifest, projectId, selectedFile]);

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
  const hasWorkRemaining = taskList.some((t) =>
    ["pending", "ready"].includes(t.status),
  );

  const completedStages: string[] = project
    ? JSON.parse(project.completedStages || "[]")
    : [];

  // Determine which stage is currently running from the most recent STAGE log
  const activeStage: string | null = effectiveRunning
    ? ([...logEntries].reverse().find((e) => e.agent === "STAGE")?.message ??
      null)
    : null;

  const currentStatus = project
    ? deriveCurrentStatus(taskList, project.status, effectiveRunning, activeStage)
    : {
        label: "Loading…",
        phase: "idle",
        color: "muted" as const,
        progressPct: 0,
      };

  const stageStates = deriveStageStates(taskList, completedStages, effectiveRunning, activeStage);

  const statusColorClass: Record<string, string> = {
    muted: styles.statusBarMuted,
    accent: styles.statusBarAccent,
    success: styles.statusBarSuccess,
    warning: styles.statusBarWarning,
    danger: styles.statusBarDanger,
  };

  const tree = buildTree(taskList);

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
  const filteredLogs = logFilter
    ? visibleLogs.filter((e) => e.agent === logFilter)
    : visibleLogs;

  // Unique agent names for filter (exclude STAGE)
  const logAgents = Array.from(new Set(visibleLogs.map((e) => e.agent)));

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
        {editingTask === task.id ? (
          <div className={styles.taskEditRow}>
            <input
              className={styles.taskEditInput}
              value={editingDescription}
              onChange={(e) => setEditingDescription(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleEditTask(task.id);
                if (e.key === "Escape") setEditingTask(null);
              }}
              autoFocus
            />
            <button
              className={styles.approveBtn}
              onClick={() => handleEditTask(task.id)}
            >
              ✓
            </button>
            <button
              className={styles.rejectBtn}
              onClick={() => setEditingTask(null)}
            >
              ✕
            </button>
          </div>
        ) : (
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
            {!running &&
              [
                "awaiting_approval",
                "pending",
                "ready",
                "stuck",
                "done",
              ].includes(task.status) && (
                <button
                  className={styles.taskEditBtn}
                  onClick={() => startEditTask(task)}
                  title="Edit description"
                >
                  ✎
                </button>
              )}
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
        )}
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
          <button
            className={styles.deleteBtn}
            onClick={() => setShowDeleteConfirm(true)}
            title="Delete project"
          >
            Delete
          </button>
        </div>
      </div>

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
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleSaveDesc();
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
            {project.description || <span className={styles.projectDescPlaceholder}>Add a description…</span>}
          </p>
        )}
      </div>

      {/* ── Action Bar: status + stage tracker + actions ── */}
      <div
        className={`${styles.actionBar} ${statusColorClass[currentStatus.color] || styles.statusBarMuted}`}
      >
        {/* Left: status label */}
        <div className={styles.actionBarStatus}>
          {currentStatus.color === "accent" && (
            <span className={styles.statusBarPulse}>●</span>
          )}
          <span className={styles.actionBarLabel}>{currentStatus.label}</span>
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
                title={showOutput ? "Hide files" : "View generated files & run instructions"}
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
      <div className={styles.stageTracker}>
        {PIPELINE_STAGES.map((stage, i) => {
          const state = stageStates[stage.key];
          const isFirst = i === 0;
          // Can run this stage if upstream is done and not currently running
          const upstreamDone =
            isFirst || stageStates[PIPELINE_STAGES[i - 1].key] === "done";
          const canRun = !effectiveRunning && state === "pending" && upstreamDone;
          const canRetry = !effectiveRunning && state === "done";
          const isApproval = state === "approval";

          return (
            <div key={stage.key} className={styles.stageItem}>
              {i > 0 && (
                <div
                  className={`${styles.stageConnector} ${
                    state === "done" || state === "active"
                      ? styles.stageConnectorActive
                      : ""
                  }`}
                />
              )}
              <div
                className={`${styles.stageChip} ${
                  state === "done"
                    ? styles.stageChipDone
                    : state === "active"
                      ? styles.stageChipActive
                      : state === "approval"
                        ? styles.stageChipApproval
                        : styles.stageChipPending
                }`}
              >
                <span className={styles.stageIcon}>
                  {state === "done" && "✓"}
                  {state === "active" && (
                    <span className={styles.stageSpinner} />
                  )}
                  {state === "pending" && "○"}
                  {state === "approval" && "⚠"}
                </span>
                <span className={styles.stageLabel}>{stage.label}</span>
                {canRun && (
                  <button
                    className={styles.stageRunBtn}
                    onClick={() => {
                      if (stage.key === "feedback") {
                        setShowFeedbackInput(true);
                      } else if (stage.key === "qa") {
                        handleRunQA();
                      } else {
                        handleRun(stage.runStage);
                      }
                    }}
                    title={
                      stage.key === "feedback"
                        ? "Add Feedback"
                        : `Run ${stage.label}`
                    }
                  >
                    {stage.key === "feedback" ? "✎" : "▶"}
                  </button>
                )}
                {canRetry && (
                  <button
                    className={styles.stageRetryBtn}
                    onClick={() => {
                      if (stage.key === "feedback") {
                        setShowFeedbackInput(true);
                      } else {
                        setResetStage(stage.runStage);
                      }
                    }}
                    title={
                      stage.key === "feedback"
                        ? "Add More Feedback"
                        : `Re-run ${stage.label}`
                    }
                  >
                    {stage.key === "feedback" ? "✎" : "↻"}
                  </button>
                )}
                {isApproval && (
                  <button
                    className={styles.stageApproveBtn}
                    onClick={handleApproveAll}
                    title="Approve all epics"
                  >
                    ✓ Approve
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

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
                <span className={styles.feedbackHint}>Enter to submit · Shift+Enter for new line</span>
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
        <div className={styles.outputPanel}>
          <div className={styles.outputHeader}>
            <div className={styles.outputTabs}>
              <button
                className={`${styles.outputTab} ${!showRunInstructions ? styles.outputTabActive : ""}`}
                onClick={() => setShowRunInstructions(false)}
              >
                📄 Files
              </button>
              <button
                className={`${styles.outputTab} ${showRunInstructions ? styles.outputTabActive : ""}`}
                onClick={() => setShowRunInstructions(true)}
              >
                🚀 How to Run
              </button>
            </div>
            <button
              className={styles.outputCloseBtn}
              onClick={() => setShowOutput(false)}
              title="Close"
            >
              ✕
            </button>
          </div>

          {showRunInstructions ? (
            <div className={styles.outputRunInstructions}>
              <pre className={styles.outputRunPre}>
                {project?.fileManifest
                  ? generateRunInstructions(
                      JSON.parse(project.fileManifest),
                      project.name,
                    )
                  : "No output files yet."}
              </pre>
            </div>
          ) : (
            <div className={styles.outputBody}>
              {/* File sidebar */}
              <div className={styles.outputFileList}>
                {outputFiles.map((f) => (
                  <button
                    key={f.path}
                    className={`${styles.outputFileItem} ${selectedFile === f.path ? styles.outputFileActive : ""}`}
                    onClick={() => setSelectedFile(f.path)}
                    title={f.path}
                  >
                    {f.path}
                  </button>
                ))}
                {outputFiles.length === 0 && (
                  <p className={styles.outputEmpty}>No files generated yet.</p>
                )}
              </div>

              {/* Code viewer */}
              <div className={styles.outputCodeViewer}>
                {selectedFile ? (
                  <pre className={styles.outputCode}>
                    <code>
                      {outputFiles.find((f) => f.path === selectedFile)
                        ?.content || ""}
                    </code>
                  </pre>
                ) : (
                  <p className={styles.outputEmpty}>
                    Select a file to view its contents.
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Confirm reset dialog */}
      {resetStage && (
        <div className={styles.confirmOverlay}>
          <div className={styles.confirmDialog}>
            <p className={styles.confirmText}>
              Re-run <strong>{resetStage}</strong> stage? This will delete
              generated data from this stage onward and re-run it.
            </p>
            <div className={styles.confirmActions}>
              <button
                className={styles.confirmYes}
                onClick={() => handleResetStage(resetStage)}
              >
                Yes, re-run
              </button>
              <button
                className={styles.confirmNo}
                onClick={() => setResetStage(null)}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirm delete dialog */}
      {showDeleteConfirm && (
        <div className={styles.confirmOverlay}>
          <div className={styles.confirmDialog}>
            <p className={styles.confirmText}>
              Delete <strong>{project.name}</strong>? This will permanently
              remove the project, all tasks, logs, and output files.
            </p>
            <div className={styles.confirmActions}>
              <button
                className={styles.confirmDanger}
                onClick={handleDeleteProject}
              >
                Delete permanently
              </button>
              <button
                className={styles.confirmNo}
                onClick={() => setShowDeleteConfirm(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

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
          <div className={styles.logPanelHeader}>
            <h2 className={styles.logPanelTitle}>Live Log</h2>
            {logAgents.length > 1 && (
              <div className={styles.logFilters}>
                <button
                  className={`${styles.logFilterBtn} ${!logFilter ? styles.logFilterActive : ""}`}
                  onClick={() => setLogFilter(null)}
                >
                  All
                </button>
                {logAgents.map((agent) => (
                  <button
                    key={agent}
                    className={`${styles.logFilterBtn} ${logFilter === agent ? styles.logFilterActive : ""} ${agentClass[agent] || ""}`}
                    onClick={() =>
                      setLogFilter(logFilter === agent ? null : agent)
                    }
                  >
                    {agent}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div
            className={styles.logList}
            ref={logListRef}
            onScroll={handleLogScroll}
          >
            {filteredLogs.map((entry) => (
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
