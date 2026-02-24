import { AppOperation, OperationResult } from "@/lib/ops/types";

/**
 * Apply deterministic operations to files.
 * In the single-component TSX model, this is a no-op.
 */
export function applyOperations(
  files: Record<string, string>,
  _operations: AppOperation[],
): OperationResult {
  return { files, executions: [] };
}
