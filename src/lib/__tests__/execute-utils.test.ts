import { describe, it, expect } from "vitest";
import { getTasksForStep, getUncoveredTasks, TaskSlim } from "../execute-utils";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTasks(n: number): TaskSlim[] {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    description: `Task ${i + 1}`,
    status: "pending",
    sortOrder: i,
  }));
}

// ─── getTasksForStep ──────────────────────────────────────────────────────────

describe("getTasksForStep", () => {
  it("returns [] when taskGroup is empty", () => {
    expect(getTasksForStep(0, 3, [])).toEqual([]);
  });

  it("returns [] when totalSteps is 0", () => {
    const group = makeTasks(3);
    expect(getTasksForStep(0, 0, group)).toEqual([]);
  });

  it("returns exactly 1 task for each step within task range", () => {
    const group = makeTasks(5);
    // Steps 0-4 are within the 5-task group → exactly 1 task each
    for (let i = 0; i < group.length; i++) {
      const result = getTasksForStep(i, 10, group);
      expect(result.length).toBe(1);
    }
  });

  it("returns [] for steps beyond the last task index", () => {
    const group = makeTasks(5);
    for (let i = group.length; i < group.length + 3; i++) {
      expect(getTasksForStep(i, 10, group)).toEqual([]);
    }
  });

  it("maps 1:1 when tasks === steps", () => {
    const group = makeTasks(3);
    expect(getTasksForStep(0, 3, group)[0].id).toBe(1);
    expect(getTasksForStep(1, 3, group)[0].id).toBe(2);
    expect(getTasksForStep(2, 3, group)[0].id).toBe(3);
  });

  it("returns [] when stepIndex >= taskGroup.length with fewer tasks than steps", () => {
    const group = makeTasks(2);
    expect(getTasksForStep(2, 5, group)).toEqual([]);
    expect(getTasksForStep(4, 5, group)).toEqual([]);
  });

  it("returns correct task for each step when tasks < steps (1:1 region only)", () => {
    const group = makeTasks(2);
    expect(getTasksForStep(0, 5, group)[0].id).toBe(1);
    expect(getTasksForStep(1, 5, group)[0].id).toBe(2);
  });

  it("returns exactly 1 task per step even when tasks > steps (old bug scenario)", () => {
    // Old private method returned 2+ tasks when taskGroup.length > totalSteps
    const group = makeTasks(5); // "**Acceptance Criteria:**" etc.
    const totalSteps = 2;

    const step0 = getTasksForStep(0, totalSteps, group);
    const step1 = getTasksForStep(1, totalSteps, group);

    expect(step0.length).toBe(1);
    expect(step1.length).toBe(1);
  });

  it("returns [] when stepIndex >= taskGroup.length (steps beyond last task)", () => {
    const group = makeTasks(3);
    // stepIndex 5 with only 3 tasks → no task available
    expect(getTasksForStep(5, 10, group)).toEqual([]);
    expect(getTasksForStep(3, 10, group)).toEqual([]);
  });

  it("sequential invariant: at most 1 task is 'executing' at a time", () => {
    const group = makeTasks(4);
    const totalSteps = 3;
    const simulatedExecuting = new Set<number>();

    for (let i = 0; i < totalSteps; i++) {
      const step = getTasksForStep(i, totalSteps, group);
      // Verify at most 1 task would be marked executing at this step
      expect(step.length).toBeLessThanOrEqual(1);
      if (step[0]) {
        // "mark executing"
        simulatedExecuting.add(step[0].id);
        // UI invariant: only 1 executing task at any snapshot
        // (We verify by checking step length, not accumulation)
        expect(step.length).toBe(1);
        // "mark done"
        simulatedExecuting.delete(step[0].id);
      }
      // After marking done, executing set must be empty
      expect(simulatedExecuting.size).toBe(0);
    }
  });
});

// ─── getUncoveredTasks ────────────────────────────────────────────────────────

describe("getUncoveredTasks", () => {
  it("returns [] when tasks === steps (exact coverage)", () => {
    const group = makeTasks(3);
    expect(getUncoveredTasks(3, group)).toEqual([]);
  });

  it("returns [] when tasks < steps (all tasks are covered)", () => {
    const group = makeTasks(2);
    expect(getUncoveredTasks(5, group)).toEqual([]);
  });

  it("returns [] when group is empty", () => {
    expect(getUncoveredTasks(3, [])).toEqual([]);
  });

  it("returns the tail tasks beyond totalSteps when tasks > steps", () => {
    const group = makeTasks(5);
    const uncovered = getUncoveredTasks(3, group);
    expect(uncovered.length).toBe(2);
    expect(uncovered[0].id).toBe(4);
    expect(uncovered[1].id).toBe(5);
  });

  it("returns all tasks except the first when totalSteps = 1 and many tasks", () => {
    const group = makeTasks(4);
    const uncovered = getUncoveredTasks(1, group);
    expect(uncovered.length).toBe(3);
    expect(uncovered.map((t) => t.id)).toEqual([2, 3, 4]);
  });
});

// ─── Coverage completeness ────────────────────────────────────────────────────

describe("full-coverage invariant", () => {
  it("getTasksForStep + getUncoveredTasks covers each task exactly once", () => {
    // Simulate executeSpec with more tasks than steps
    const group = makeTasks(5);
    const totalSteps = 3;
    const covered = new Map<number, number>(); // taskId → count

    for (const t of group) covered.set(t.id, 0);

    for (let i = 0; i < totalSteps; i++) {
      for (const t of getTasksForStep(i, totalSteps, group)) {
        covered.set(t.id, (covered.get(t.id) ?? 0) + 1);
      }
    }
    for (const t of getUncoveredTasks(totalSteps, group)) {
      covered.set(t.id, (covered.get(t.id) ?? 0) + 1);
    }

    for (const [, count] of covered) {
      expect(count).toBe(1); // every task covered exactly once
    }
  });

  it("no task is left at count 0 (none missed)", () => {
    const group = makeTasks(6);
    const totalSteps = 2;
    const seen = new Set<number>();

    for (let i = 0; i < totalSteps; i++) {
      for (const t of getTasksForStep(i, totalSteps, group)) seen.add(t.id);
    }
    for (const t of getUncoveredTasks(totalSteps, group)) seen.add(t.id);

    expect(seen.size).toBe(group.length);
    for (const t of group) expect(seen.has(t.id)).toBe(true);
  });
});
