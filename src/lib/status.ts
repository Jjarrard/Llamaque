/**
 * Pure status-derivation functions shared between the UI and tests.
 * No React, no DB, no side effects.
 */

export type TaskLike = {
  status: string;
  description: string;
  depth: number;
  parentId: number | null;
};

export type StatusResult = {
  label: string;
  phase: string;
  color: "muted" | "accent" | "success" | "warning" | "danger";
  progressPct: number;
};

export type StageKey =
  | "architect"
  | "decompose"
  | "breakdown"
  | "tdd"
  | "execute"
  | "qa"
  | "feedback";

export type StageState = "pending" | "active" | "done" | "approval";

export const PIPELINE_STAGES: {
  key: StageKey;
  label: string;
  runStage: string;
}[] = [
  { key: "architect", label: "Architect", runStage: "architect" },
  { key: "decompose", label: "Decompose", runStage: "decompose" },
  { key: "breakdown", label: "Breakdown", runStage: "breakdown" },
  { key: "tdd", label: "TDD", runStage: "tdd" },
  { key: "execute", label: "Execute", runStage: "execute" },
  { key: "qa", label: "QA", runStage: "qa" },
  { key: "feedback", label: "Feedback", runStage: "feedback" },
];

/** Derive a single human-readable status string from task list + project state */
export function deriveCurrentStatus(
  taskList: TaskLike[],
  projectStatus: string,
  running: boolean,
  activeStage: string | null = null,
): StatusResult {
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
      label: "QA checking — reviewing output…",
      phase: "qa",
      color: "accent",
      progressPct,
    };
  }

  if (editingTasks.length > 0) {
    return {
      label: "Editing — fixing QA issues…",
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

/** Derive per-stage UI state from task list + completed stages + running flag */
export function deriveStageStates(
  taskList: TaskLike[],
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

  for (const s of PIPELINE_STAGES) {
    if (completedStages.includes(s.key)) {
      states[s.key] = "done";
    }
  }

  // Implied completions
  if (states.decompose === "done") states.architect = "done";
  if (states.execute === "done") states.tdd = "done";

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

  const hasAwaiting = taskList.some((t) => t.status === "awaiting_approval");
  if (hasAwaiting && states.breakdown !== "done" && !running) {
    states.breakdown = "approval";
  }

  return states;
}
