/**
 * Pure utilities for the execute phase — extracted here so they can be
 * unit tested without mocking the entire pipeline.
 */

export type TaskSlim = {
  id: number;
  description: string;
  status: string;
  sortOrder: number;
};

/**
 * Returns AT MOST ONE task to display as "executing" for a given requirement
 * step — fixing the bug where multiple tasks were marked executing at once.
 *
 * Mapping rules:
 * - tasks === steps  → 1:1, each step returns its own task
 * - tasks < steps   → each task maps to one step (steps beyond task count → [])
 * - tasks > steps   → first `totalSteps` tasks each get a step; the rest are
 *                     handled by getUncoveredTasks() at end of executeSpec
 *
 * Generic so callers passing Task[] (a superset of TaskSlim) get Task[] back.
 */
export function getTasksForStep<T extends TaskSlim>(
  stepIndex: number,
  totalSteps: number,
  taskGroup: T[],
): T[] {
  if (taskGroup.length === 0 || totalSteps === 0) return [];
  // When there are fewer tasks than steps, steps beyond the last task return
  // nothing — they do real work but display no task status change.
  if (stepIndex >= taskGroup.length) return [];
  return [taskGroup[stepIndex]];
}

/**
 * Returns the tasks that were NOT covered by any getTasksForStep call.
 * This happens when taskGroup.length > totalSteps.  Call this after the
 * requirements loop to mark the remainder as done.
 *
 * Generic for the same reason as getTasksForStep.
 */
export function getUncoveredTasks<T extends TaskSlim>(
  totalSteps: number,
  taskGroup: T[],
): T[] {
  if (taskGroup.length <= totalSteps) return [];
  return taskGroup.slice(totalSteps);
}
