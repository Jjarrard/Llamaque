import { callOllama } from "@/lib/ollama";

const SYSTEM_PROMPT = `You are a Feature Reviewer. Given a user's project request and numbered epics, reply with the NUMBERS to KEEP.

Rules:
- KEEP epics that directly relate to the user's project.
- KEEP supporting features (styling, interactivity) every web app needs.
- REMOVE only epics that are completely unrelated or exact duplicates.
- When in doubt, KEEP.

Reply with ONLY a comma-separated list of numbers to keep. Example:
KEEP: 1, 2, 3, 5

If ALL epics are good, reply: KEEP: ALL`;

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

Which numbers do we KEEP?`;

  const { text, prompt, tokens, durationMs } = await callOllama(
    model,
    "reviewer",
    SYSTEM_PROMPT,
    userMessage,
    { numPredict: 100 },
  );

  // Strip >> prefill prefix from all lines
  const cleaned = text.replace(/^>>\s*/gm, "").trim();

  // Check for "ALL" response
  if (/\bALL\b/i.test(cleaned)) {
    return { kept: features, raw: text, prompt, tokens, durationMs };
  }

  // Extract all numbers from the response
  const numbers = cleaned.match(/\d+/g);
  if (!numbers) {
    // Parsing failed — safe fallback: keep everything
    return { kept: features, raw: text, prompt, tokens, durationMs };
  }

  const kept: string[] = [];
  for (const numStr of numbers) {
    const idx = parseInt(numStr, 10) - 1; // 1-indexed → 0-indexed
    if (idx >= 0 && idx < features.length && !kept.includes(features[idx])) {
      kept.push(features[idx]);
    }
  }

  // If we ended up with nothing, keep everything (safe fallback)
  if (kept.length === 0) {
    return { kept: features, raw: text, prompt, tokens, durationMs };
  }

  return { kept, raw: text, prompt, tokens, durationMs };
}
