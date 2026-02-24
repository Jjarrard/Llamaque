import { callOllama } from "@/lib/ollama";

const SYSTEM_PROMPT = `Given epics for a project, reply with numbers to REMOVE.
Only remove epics totally unrelated to the project or exact duplicates.
When in doubt, KEEP. Most times all are good.

Reply: REMOVE: NONE
Or: REMOVE: 3, 5`;

export interface ReviewResult {
  kept: string[];
  raw: string;
  prompt: string;
  tokens: number;
  durationMs: number;
}

export async function runReviewer(
  model: string,
  userRequest: string,
  features: string[],
): Promise<ReviewResult> {
  const featureList = features.map((f, i) => `${i + 1}. ${f}`).join("\n");

  const userMessage = `User's request: "${userRequest}"

Proposed epics:
${featureList}

Which numbers should we REMOVE? (Reply REMOVE: NONE if all are good)`;

  const { text, prompt, tokens, durationMs } = await callOllama(
    model,
    "reviewer",
    SYSTEM_PROMPT,
    userMessage,
  );

  // Strip >> prefill prefix from all lines
  const cleaned = text.replace(/^>>\s*/gm, "").trim();

  // Check for "NONE" response — keep everything
  if (/\bNONE\b/i.test(cleaned) || /\bALL\b/i.test(cleaned)) {
    return { kept: features, raw: text, prompt, tokens, durationMs };
  }

  // Extract all numbers from the response (these are indices to REMOVE)
  const numbers = cleaned.match(/\d+/g);
  if (!numbers) {
    // Parsing failed — safe fallback: keep everything
    return { kept: features, raw: text, prompt, tokens, durationMs };
  }

  const toRemove = new Set<number>();
  for (const numStr of numbers) {
    const idx = parseInt(numStr, 10) - 1; // 1-indexed → 0-indexed
    if (idx >= 0 && idx < features.length) {
      toRemove.add(idx);
    }
  }

  // Safety: if the reviewer would remove more than half, it probably misunderstood.
  // Fall back to keeping everything.
  if (toRemove.size > features.length / 2) {
    return { kept: features, raw: text, prompt, tokens, durationMs };
  }

  const kept = features.filter((_, i) => !toRemove.has(i));

  // If we ended up with nothing, keep everything (safe fallback)
  if (kept.length === 0) {
    return { kept: features, raw: text, prompt, tokens, durationMs };
  }

  return { kept, raw: text, prompt, tokens, durationMs };
}
