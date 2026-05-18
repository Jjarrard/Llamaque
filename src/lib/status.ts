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

/**
 * Task statuses that indicate the pipeline is actively doing work on a task.
 * Used by deriveIsRunning as a task-status fallback when the DB project status
 * isn't yet "running" (brief race on pipeline start) or to double-check that
 * active work is happening even if the DB field is stale.
 *
 * NOTE: "ready" is intentionally NOT in this list — features sit in "ready"
 * during TDD (test-generation) and during early breakdown phases.  The "ready"
 * status means "queued for work", not "actively being processed".  The
 * presence of "ready" tasks alone does NOT mean the pipeline is running.
 */
export const ACTIVE_TASK_STATUSES = [
  "executing",
  "decomposing",
  "qa_check",
  "editing",
] as const;

/**
 * Determine whether the pipeline is currently active, given the project status
 * stored in the DB and the latest task list.
 *
 * Rules (in priority order):
 * 1. If project.status === "running" → running (source of truth for stages
 *    like TDD where no individual task is ever set to an active status).
 * 2. If any task has an active status (executing / decomposing / qa_check /
 *    editing) → running (task-level fallback for the race where the DB hasn't
 *    been updated yet but work is visibly in progress).
 * 3. Otherwise → not running.
 */
export function deriveIsRunning(
  projectStatus: string,
  taskList: Pick<TaskLike, "status">[],
): boolean {
  if (projectStatus === "running") return true;
  return taskList.some((t) =>
    (ACTIVE_TASK_STATUSES as readonly string[]).includes(t.status),
  );
}

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
  { key: "decompose", label: "Plan", runStage: "decompose" },
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

/** Derive per-stage UI state from task list + completed stages + running flag.
 *
 * `activeStage` should now be `project.currentStage` — written to the DB by
 * the pipeline at the start of each stage and cleared when it finishes.
 * This gives an authoritative, race-free source of truth.
 */
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

  // Mark completed stages as done
  for (const s of PIPELINE_STAGES) {
    if (completedStages.includes(s.key)) {
      states[s.key] = "done";
    }
  }

  // Legacy implied completion: decompose can only run after architect.
  if (states.decompose === "done") states.architect = "done";

  if (running) {
    const target = activeStage as StageKey | null;
    if (target && target in states && states[target] !== "done") {
      // Pipeline explicitly says this stage is active
      states[target] = "active";
    } else {
      // No currentStage set yet (pipeline just started) or stage just completed
      // but next hasn't been written yet — mark the first non-done non-feedback
      // stage so something is always visibly active while running.
      for (const s of PIPELINE_STAGES) {
        if (states[s.key] !== "done" && s.key !== "feedback") {
          states[s.key] = "active";
          break;
        }
      }
    }
  }

  // Approval state: show breakdown awaiting approval
  const hasAwaiting = taskList.some((t) => t.status === "awaiting_approval");
  if (hasAwaiting && states.breakdown !== "done" && !running) {
    states.breakdown = "approval";
  }

  return states;
}
