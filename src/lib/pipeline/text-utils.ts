/**
 * Pure text helpers shared by the pipeline phases.
 */
export function truncateForPrompt(content: string, maxLines: number): string {
  const lines = content.split("\n");
  if (lines.length <= maxLines) return content;
  return lines.slice(0, maxLines).join("\n") + "\n/* ... */";
}

/**
 * Rough token estimate (~4 chars per token for English/code).
 * Logs a warning if the prompt exceeds a safety threshold.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
