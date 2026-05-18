/**
 * Model capability detection — tiering + multimodal support.
 *
 * The pipeline adapts strictness based on the active model's size.
 * Tiny models (≤4B) need restrictive prompts and hard limits to avoid
 * hallucinated service classes. Capable models (8B+) handle multi-file
 * decomposition and produce cleaner code.
 *
 * Capabilities are inferred from the model name (size suffix + family).
 * We do NOT call `ollama show` per call — that costs ~100ms and the
 * tag-based heuristic is reliable for Ollama's standard naming.
 */

export type ComplexityTier = "small" | "medium" | "large";

export interface ModelCapabilities {
  tier: ComplexityTier;
  /** Approximate parameter count in billions (for logging/decisions) */
  paramsB: number;
  /** Vision-capable (gemma3+, llava, qwen-vl, etc.) */
  vision: boolean;
  /** Max files the architect may produce */
  maxFiles: number;
}

/**
 * Models known to support vision input via Ollama's chat API.
 * Maintained as a denylist of prefixes — anything matching is vision-capable.
 */
const VISION_PREFIXES = [
  "gemma3",
  "gemma4",
  "llava",
  "llava-llama3",
  "llava-phi3",
  "bakllava",
  "moondream",
  "minicpm-v",
  "llama3.2-vision",
  "qwen2-vl",
  "qwen2.5-vl",
  "qwen3-vl",
  "internvl",
];

/**
 * Extract approximate parameter count (billions) from an Ollama model tag.
 *
 * Handles common patterns:
 *   "llama3.2:3b"      → 3
 *   "llama3.2:latest"  → 3   (llama 3.2 latest defaults to 3B)
 *   "gemma4:e4b"       → 8   (e4b = effective 4B but ~8B params)
 *   "gemma3:12b"       → 12
 *   "qwen2.5:7b"       → 7
 *
 * Returns 0 if no size could be inferred (treated as "small" to be safe).
 */
export function inferParamsB(model: string): number {
  const tag = model.toLowerCase();

  // Special-case Gemma 3/4 "effective" sizes
  // e4b = ~8B params (Gemma's MatFormer "Mix-n-Match" tag)
  // e2b = ~5B params
  if (/:e4b\b/.test(tag)) return 8;
  if (/:e2b\b/.test(tag)) return 5;

  // Explicit Nb tag
  const m = tag.match(/:(\d+(?:\.\d+)?)b\b/);
  if (m) return parseFloat(m[1]);

  // Family defaults when tag is "latest" / unspecified
  if (tag.startsWith("llama3.2") || tag.includes("llama3.2:latest")) return 3;
  if (tag.startsWith("llama3.1")) return 8;
  if (tag.startsWith("llama3")) return 8;
  if (tag.startsWith("qwen2.5")) return 7;
  if (tag.startsWith("qwen3")) return 7;
  if (tag.startsWith("mistral")) return 7;
  if (tag.startsWith("phi3")) return 4;
  if (tag.startsWith("phi4")) return 14;
  if (tag.startsWith("gemma3") || tag.startsWith("gemma4")) return 8;

  return 0;
}

export function inferTier(paramsB: number): ComplexityTier {
  if (paramsB <= 4) return "small";
  if (paramsB <= 8) return "medium";
  return "large";
}

export function inferVision(model: string): boolean {
  const tag = model.toLowerCase();
  return VISION_PREFIXES.some((p) => tag.startsWith(p));
}

/**
 * Resolve all capabilities for a model in one call.
 * The architect, validator, and visual-QA stage all key off this.
 */
export function modelCapabilities(model: string): ModelCapabilities {
  const paramsB = inferParamsB(model);
  const tier = inferTier(paramsB);
  const vision = inferVision(model);

  // File-count cap is tied to tier:
  //   small (≤4B) → 2 files: too easily wanders into hallucinated services
  //   medium (5-8B) → 4 files: can handle proper component decomposition
  //   large (8B+)  → 6 files: trusted to split cleanly
  const maxFiles = tier === "small" ? 2 : tier === "medium" ? 4 : 6;

  return { tier, paramsB, vision, maxFiles };
}
