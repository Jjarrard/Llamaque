/**
 * Ops types — unused in the single-component TSX model.
 * Retained as minimal stubs for interface compatibility.
 */

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export type AppOperation = {};
export type OperationExecution = {
  operation: AppOperation;
  applied: boolean;
  reason?: string;
};
export type OperationResult = {
  files: Record<string, string>;
  executions: OperationExecution[];
};
