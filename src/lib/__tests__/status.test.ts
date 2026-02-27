import { describe, it, expect } from "vitest";
import {
  deriveCurrentStatus,
  deriveStageStates,
  deriveIsRunning,
  ACTIVE_TASK_STATUSES,
  type TaskLike,
} from "@/lib/status";

// ─── helpers ─────────────────────────────────────────────────────────────────

function task(
  status: string,
  description = "Task",
  depth = 2,
): TaskLike {
  return { status, description, depth, parentId: null };
}

const NO_TASKS: TaskLike[] = [];

// ─── deriveCurrentStatus ─────────────────────────────────────────────────────

describe("deriveCurrentStatus", () => {
  // ── done state ──

  it("returns done phase when projectStatus is 'done'", () => {
    const result = deriveCurrentStatus(NO_TASKS, "done", false);
    expect(result.phase).toBe("done");
    expect(result.color).toBe("success");
    expect(result.progressPct).toBe(100);
  });

  it("returns done even when tasks exist and running=true if status is done", () => {
    const result = deriveCurrentStatus([task("done")], "done", true);
    expect(result.phase).toBe("done");
  });

  // ── review state ──

  it("returns review phase when projectStatus is 'review' and not running", () => {
    const result = deriveCurrentStatus(NO_TASKS, "review", false);
    expect(result.phase).toBe("review");
    expect(result.color).toBe("warning");
    expect(result.label).toContain("Stage complete");
  });

  it("does NOT return review phase when running (pipeline resumed)", () => {
    const result = deriveCurrentStatus(NO_TASKS, "review", true, "decompose");
    expect(result.phase).not.toBe("review");
  });

  it("returns review with task progress when tasks exist and status is review", () => {
    const tasks = [task("done"), task("ready")];
    const result = deriveCurrentStatus(tasks, "review", false);
    expect(result.phase).toBe("review");
    expect(result.progressPct).toBe(50);
  });

  // ── paused state ──

  it("shows paused when not running, has tasks, and status is paused", () => {
    const result = deriveCurrentStatus(
      [task("ready"), task("done")],
      "paused",
      false,
    );
    expect(result.phase).toBe("paused");
    expect(result.label).toContain("Paused");
  });

  it("NEVER shows 'paused' for review status even with tasks", () => {
    const result = deriveCurrentStatus(
      [task("ready"), task("done")],
      "review",
      false,
    );
    expect(result.phase).not.toBe("paused");
    expect(result.label).not.toContain("Paused");
  });

  // ── idle / ready state ──

  it("returns idle/ready when no tasks and not running", () => {
    const result = deriveCurrentStatus(NO_TASKS, "pending", false);
    expect(result.phase).toBe("idle");
    expect(result.label).toBe("Ready to start");
  });

  it("returns idle/ready when no tasks even if status is paused and not running", () => {
    const result = deriveCurrentStatus(NO_TASKS, "paused", false);
    expect(result.phase).toBe("idle");
  });

  // ── stuck state ──

  it("returns stuck phase when tasks are stuck and not running", () => {
    const result = deriveCurrentStatus(
      [task("stuck"), task("stuck")],
      "paused",
      false,
    );
    expect(result.phase).toBe("stuck");
    expect(result.color).toBe("danger");
    expect(result.label).toContain("2 tasks stuck");
  });

  it("does NOT show stuck phase while running (pipeline is handling recovery)", () => {
    const result = deriveCurrentStatus([task("stuck")], "running", true);
    expect(result.phase).not.toBe("stuck");
  });

  // ── awaiting approval ──

  it("returns approval phase when tasks are awaiting approval", () => {
    const result = deriveCurrentStatus(
      [task("awaiting_approval")],
      "paused",
      false,
    );
    expect(result.phase).toBe("approval");
    expect(result.color).toBe("warning");
  });

  // ── running states ──

  it("returns running phase with generic label when no activeStage", () => {
    const result = deriveCurrentStatus(
      [task("ready"), task("done")],
      "running",
      true,
    );
    expect(result.phase).toBe("running");
    expect(result.label).toContain("Running");
  });

  it("returns stage-specific label for each known stage when running", () => {
    const stages: [string, string][] = [
      ["architect", "Architect"],
      ["decompose", "Decomposing"],
      ["breakdown", "Breakdown"],
      ["tdd", "TDD"],
      ["execute", "Execute"],
      ["qa", "QA"],
      ["feedback", "Feedback"],
    ];
    for (const [stage, expectedLabel] of stages) {
      const result = deriveCurrentStatus(NO_TASKS, "running", true, stage);
      expect(result.label).toContain(expectedLabel);
      expect(result.phase).toBe(stage);
    }
  });

  it("returns decompose phase when tasks have decomposing status", () => {
    const result = deriveCurrentStatus(
      [task("decomposing")],
      "running",
      true,
    );
    expect(result.phase).toBe("decompose");
  });

  it("returns execute phase when tasks are executing", () => {
    const result = deriveCurrentStatus(
      [task("executing", "Build the thing")],
      "running",
      true,
    );
    expect(result.phase).toBe("execute");
    expect(result.label).toContain("Build the thing");
  });

  it("returns edit phase when tasks are editing while running", () => {
    const result = deriveCurrentStatus([task("editing")], "running", true);
    expect(result.phase).toBe("edit");
    expect(result.label).toContain("Editing");
    expect(result.color).toBe("accent");
  });

  it("returns generic running phase when activeStage is unrecognised", () => {
    const result = deriveCurrentStatus(
      [task("ready")],
      "running",
      true,
      "unknown_future_stage",
    );
    expect(result.phase).toBe("running");
    expect(result.label).toContain("Running");
  });

  it("returns paused when projectStatus is a stale 'running' but running=false", () => {
    // DB can hold 'running' if the process crashed — UI shows paused until user acts
    const result = deriveCurrentStatus(
      [task("ready"), task("done")],
      "running",
      false,
    );
    expect(result.phase).toBe("paused");
    expect(result.label).toContain("Paused");
  });

  it("truncates executing task description to 50 chars in label", () => {
    const longDescription = "A".repeat(80);
    const result = deriveCurrentStatus(
      [task("executing", longDescription)],
      "running",
      true,
    );
    expect(result.label.length).toBeLessThan(longDescription.length + 20);
    expect(result.label).toContain("A".repeat(50));
    expect(result.label).not.toContain("A".repeat(51));
  });

  it("returns progressPct 0 when all tasks are pending (none done)", () => {
    const result = deriveCurrentStatus(
      [task("ready"), task("ready"), task("ready")],
      "running",
      true,
    );
    expect(result.progressPct).toBe(0);
  });

  it("calculates progress percentage correctly", () => {
    const tasks = [
      task("done"),
      task("done"),
      task("done"),
      task("ready"),
    ];
    const result = deriveCurrentStatus(tasks, "running", true);
    expect(result.progressPct).toBe(75);
  });
});

// ─── deriveStageStates ───────────────────────────────────────────────────────

describe("deriveStageStates", () => {
  it("all stages start as pending when nothing is complete", () => {
    const states = deriveStageStates(NO_TASKS, [], false, null);
    for (const s of [
      "architect",
      "decompose",
      "breakdown",
      "tdd",
      "execute",
      "qa",
      "feedback",
    ] as const) {
      expect(states[s]).toBe("pending");
    }
  });

  it("marks completed stages as done", () => {
    const states = deriveStageStates(
      NO_TASKS,
      ["architect", "decompose"],
      false,
      null,
    );
    expect(states.architect).toBe("done");
    expect(states.decompose).toBe("done");
    expect(states.breakdown).toBe("pending");
  });

  it("implies architect=done when decompose is done", () => {
    const states = deriveStageStates(NO_TASKS, ["decompose"], false, null);
    expect(states.architect).toBe("done");
  });

  it("implies tdd=done when execute is done", () => {
    const states = deriveStageStates(NO_TASKS, ["execute"], false, null);
    expect(states.tdd).toBe("done");
  });

  it("marks active stage when running with explicit activeStage", () => {
    const states = deriveStageStates(
      NO_TASKS,
      ["architect"],
      true,
      "decompose",
    );
    expect(states.decompose).toBe("active");
    expect(states.architect).toBe("done");
  });

  it("falls back to first non-done stage when running with no activeStage", () => {
    const states = deriveStageStates(
      NO_TASKS,
      ["architect", "decompose"],
      true,
      null,
    );
    expect(states.breakdown).toBe("active");
  });

  it("does not mark a done stage as active even if explicitly passed", () => {
    const states = deriveStageStates(
      NO_TASKS,
      ["architect"],
      true,
      "architect",
    );
    // architect is done — should fall through to decompose as active
    expect(states.architect).toBe("done");
    expect(states.decompose).toBe("active");
  });

  it("marks breakdown as approval when tasks await approval and breakdown not done", () => {
    const awaitingTasks = [task("awaiting_approval")];
    const states = deriveStageStates(
      awaitingTasks,
      ["architect", "decompose"],
      false,
      null,
    );
    expect(states.breakdown).toBe("approval");
  });

  it("does NOT mark breakdown as approval when running", () => {
    const awaitingTasks = [task("awaiting_approval")];
    const states = deriveStageStates(
      awaitingTasks,
      ["architect", "decompose"],
      true,
      "breakdown",
    );
    expect(states.breakdown).toBe("active");
  });

  it("does NOT mark breakdown as approval when breakdown is already done", () => {
    const awaitingTasks = [task("awaiting_approval")];
    const states = deriveStageStates(
      awaitingTasks,
      ["architect", "decompose", "breakdown"],
      false,
      null,
    );
    expect(states.breakdown).toBe("done");
  });

  it("all stages done when all 7 are in completedStages", () => {
    const allStages = [
      "architect",
      "decompose",
      "breakdown",
      "tdd",
      "execute",
      "qa",
      "feedback",
    ];
    const states = deriveStageStates(NO_TASKS, allStages, false, null);
    for (const s of allStages) {
      expect(states[s as import("@/lib/status").StageKey]).toBe("done");
    }
  });

  it("fallback active-stage picker reaches feedback when all prior stages are done", () => {
    const states = deriveStageStates(
      NO_TASKS,
      ["architect", "decompose", "breakdown", "tdd", "execute", "qa"],
      true,
      null, // no explicit hint — fallback picker must find 'feedback'
    );
    expect(states.feedback).toBe("active");
  });
});

// ─── deriveIsRunning ──────────────────────────────────────────────────────────
// These tests guard the bug where "PAUSED" appeared while TDD was executing.
// TDD never sets tasks to active statuses (tasks stay "ready"), so the ONLY
// running signal is project.status === "running". This logic was previously
// inline and untested in page.tsx.

describe("deriveIsRunning", () => {
  // ── TDD-phase scenario (the exact bug) ─────────────────────────────────────

  it("TDD phase: true when project.status='running' even with all tasks ready", () => {
    // generateTests() never changes task statuses — tasks stay "ready" throughout.
    // The running signal fully depends on project.status being "running".
    // Without this test, the TDD-phase PAUSED bug would not have been caught.
    const tasks = [task("ready"), task("ready"), task("ready"), task("done")];
    expect(deriveIsRunning("running", tasks)).toBe(true);
  });

  it("TDD phase: false when project.status='paused' and tasks all ready", () => {
    // After a TDD error, the catch handler sets status='paused' but tasks stay
    // 'ready' (only executing/decomposing/qa_check/editing are reset, none of
    // which TDD ever uses). UI should correctly show paused.
    const tasks = [task("ready"), task("ready"), task("done")];
    expect(deriveIsRunning("paused", tasks)).toBe(false);
  });

  it("TDD phase: false when project.status='review' and tasks all ready", () => {
    // Between manual stage runs the DB can hold 'review'. Tasks are still
    // 'ready', but with no active run the UI should NOT show running.
    expect(deriveIsRunning("review", [task("ready"), task("done")])).toBe(false);
  });

  // ── Task-status fallback (execute / decompose / qa phases) ─────────────────

  it("true when a task is executing even if project.status is not yet 'running'", () => {
    // Race: the DB status update may lag behind task status changes.
    expect(deriveIsRunning("pending", [task("executing")])).toBe(true);
  });

  it("true when a task is decomposing", () => {
    expect(deriveIsRunning("review", [task("decomposing"), task("ready")])).toBe(true);
  });

  it("true when a task is qa_check", () => {
    expect(deriveIsRunning("paused", [task("qa_check")])).toBe(true);
  });

  it("true when a task is editing", () => {
    expect(deriveIsRunning("review", [task("editing")])).toBe(true);
  });

  // ── Not-running states ──────────────────────────────────────────────────────

  it("false when project is done and no active tasks", () => {
    expect(deriveIsRunning("done", [task("done"), task("done")])).toBe(false);
  });

  it("false when project is pending with no tasks (initial state)", () => {
    expect(deriveIsRunning("pending", [])).toBe(false);
  });

  it("false when project is paused and all tasks are ready or done", () => {
    expect(
      deriveIsRunning("paused", [task("ready"), task("ready"), task("done")]),
    ).toBe(false);
  });

  // ── ACTIVE_TASK_STATUSES constant completeness ──────────────────────────────

  it("every status in ACTIVE_TASK_STATUSES triggers isRunning=true", () => {
    for (const s of ACTIVE_TASK_STATUSES) {
      expect(
        deriveIsRunning("paused", [task(s)]),
        `status "${s}" should trigger isRunning`,
      ).toBe(true);
    }
  });

  it("'ready' is NOT in ACTIVE_TASK_STATUSES — it means queued, not actively processing", () => {
    // This is the heart of the TDD bug: tasks are "ready" during TDD but that
    // does NOT mean the pipeline is running. Only project.status="running" does.
    expect((ACTIVE_TASK_STATUSES as readonly string[]).includes("ready")).toBe(false);
  });

  it("'stuck' is NOT in ACTIVE_TASK_STATUSES", () => {
    expect((ACTIVE_TASK_STATUSES as readonly string[]).includes("stuck")).toBe(false);
  });
});