import { AppOperation } from "@/lib/ops/types";

/**
 * Compile requirements into deterministic operations.
 * In the single-component TSX model, all generation is done by the LLM.
 * Always returns an empty list.
 */
export function compileRequirementsToOperations(
  _filePath: string,
  _requirements: string[],
  _projectName: string,
): AppOperation[] {
  return [];
}
