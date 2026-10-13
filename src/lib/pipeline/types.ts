/** Limits and types shared by the pipeline and its phase modules. */
/** Planning stops at depth 2 (Epic → Feature). Features ARE the execution leaves. */
export const MAX_DEPTH = 2;
export const MAX_TASKS = 200;
export const MAX_RETRIES = 2;
export const MAX_PARSE_RETRIES = 2;
/** Max bullet points per file spec — keeps Developer prompt short */
export const MAX_REQUIREMENTS = 4;
/** Max features the Manager can produce per epic */
export const MAX_SUBTASKS = 2;
/** Max epics from PM */
export const MAX_EPICS = 4;
export type PipelineStage =
  | "all"
  | "architect"
  | "decompose"
  | "breakdown"
  | "tdd"
  | "execute"
  | "qa"
  | "feedback";
export type PipelineEvent = {
  type: string;
  data: Record<string, unknown>;
};
export type EventCallback = (event: PipelineEvent) => void;
/**
   * If manifest files have no features, generate a default spec.
   * Default-spec files are tagged with a recognisable prefix so the execute
   * loop can inject richer sibling-file context and avoid duplicates.
   */
export const DEFAULT_SPEC_TAG = "__DEFAULT_SPEC__";
/** Max attempts to fix the test file itself when vitest crashes */
export const MAX_TEST_REPAIR_ATTEMPTS = 2; // repairs per individual test name
/** Max test-fix rounds (run tests → fix first failure → repeat) */
export const MAX_TEST_FIX_ROUNDS = 5;
/** Max iterations for the find-one-fix-one QA loop */
export const MAX_ITERATIVE_QA_ROUNDS = 3;
/** Max attempts to self-heal a broken component before giving up */
export const MAX_SELF_HEAL_ATTEMPTS = 3;
/** Max distinct missing-feature patches applied per honing pass */
export const MAX_HONING_FIXES = 3;
