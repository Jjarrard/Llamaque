/**
 * Ollama API client with hardening for small LLMs.
 *
 * - Prefills assistant response with ">>" to prevent preamble
 * - Uses ">>END" as a stop sequence
 * - Sets temperature and num_predict per agent role
 * - Streams tokens to the UI via AsyncLocalStorage context when available
 */

import { streamingStorage } from "@/lib/stream-state";

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://localhost:11434";

export type AgentRole =
  | "project-manager"
  | "architect"
  | "reviewer"
  | "improver"
  | "manager"
  | "developer"
  | "qa"
  | "summariser"
  | "editor"
  | "feedback"
  | "planner";

interface AgentConfig {
  temperature: number;
  numPredict: number;
}

const AGENT_CONFIGS: Record<AgentRole, AgentConfig> = {
  "project-manager": { temperature: 0.3, numPredict: -1 },
  architect: { temperature: 0.2, numPredict: -1 },
  reviewer: { temperature: 0, numPredict: -1 },
  improver: { temperature: 0, numPredict: -1 },
  manager: { temperature: 0, numPredict: -1 },
  developer: { temperature: 0, numPredict: -1 },
  qa: { temperature: 0, numPredict: -1 },
  summariser: { temperature: 0, numPredict: 150 },
  editor: { temperature: 0, numPredict: -1 },
  feedback: { temperature: 0, numPredict: -1 },
  planner: { temperature: 0, numPredict: 200 },
};

/** Context window — set high, let the model use what it needs */
const NUM_CTX = 32768;

/** Keep model loaded between calls (seconds). -1 = forever. */
const KEEP_ALIVE = "30m";

/**
 * CPU thread cap — limits heat and keeps the laptop usable.
 * Set OLLAMA_NUM_THREAD in .env.local to override (0 = let Ollama decide).
 * Default: half the logical CPUs.
 */
const NUM_THREAD = (() => {
  const v = parseInt(process.env.OLLAMA_NUM_THREAD ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : undefined; // undefined = Ollama default
})();

interface OllamaMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface OllamaResponse {
  message: { role: string; content: string };
  done: boolean;
  total_duration?: number;
  eval_count?: number;
}

/**
 * Call Ollama chat API with prefill and stop sequence hardening.
 * Returns the raw text response (which should contain a TTM block).
 *
 * When an AsyncLocalStorage StreamContext is active (set by the Pipeline),
 * this automatically uses stream:true and forwards each token chunk to the
 * onChunk callback so the UI can display live model output.
 */
export async function callOllama(
  model: string,
  role: AgentRole,
  systemPrompt: string,
  userMessage: string,
  overrides?: { numPredict?: number; prefill?: string },
): Promise<{
  text: string;
  tokens: number;
  durationMs: number;
  prompt: string;
}> {
  const config = AGENT_CONFIGS[role];
  const numPredict = overrides?.numPredict ?? config.numPredict;

  const prefill = overrides?.prefill ?? ">>";
  const messages: OllamaMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage },
    // Prefill: commit the model to the expected output structure immediately.
    // Agents that use a structured format (e.g. developer) pass a stronger
    // prefill that includes the command header so the model can't ignore it.
    { role: "assistant", content: prefill },
  ];

  // Build a readable prompt log
  const promptLog = `[SYSTEM]\n${systemPrompt}\n\n[USER]\n${userMessage}\n\n[PREFILL]\n${prefill}`;

  // Check if there's a streaming context (set by Pipeline.run wrapper)
  const streamCtx = streamingStorage.getStore();
  const useStream = streamCtx !== undefined;
  const activity = streamCtx?.onActivity;

  activity?.(`[${role}] sending prompt to ${model}...`);

  const body = {
    model,
    messages,
    stream: useStream,
    keep_alive: KEEP_ALIVE,
    // Disable thinking tokens (<think>...</think>) for models that support them
    // (Gemma 4, Qwen3, DeepSeek-R1, etc.). The >>END stop sequence fires inside
    // thinking blocks, cutting the stream before >>RESULT is ever generated.
    think: false,
    options: {
      temperature: config.temperature,
      num_predict: numPredict,
      num_ctx: NUM_CTX,
      ...(NUM_THREAD !== undefined ? { num_thread: NUM_THREAD } : {}),
    },
    stop: [">>END"],
  };

  // 10-minute timeout per LLM call
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10 * 60 * 1000);

  let res: Response;
  try {
    res = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err: unknown) {
    clearTimeout(timeout);
    if (err instanceof Error && err.name === "AbortError") {
      throw new OllamaError("LLM call timed out after 10 minutes");
    }
    throw err;
  }

  if (!res.ok) {
    clearTimeout(timeout);
    const errText = await res.text();
    throw new OllamaError(`Ollama API error (${res.status}): ${errText}`);
  }

  // ── Streaming mode: read NDJSON line-by-line ──────────────────────────
  if (useStream && res.body) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let accumulated = prefill; // starts with prefill
    let totalTokens = 0;
    let totalDurationMs = 0;
    let leftover = "";
    let chunkCount = 0;
    let firstChunkSeen = false;
    let lastActivityUpdate = Date.now();
    activity?.(`[${role}] waiting for ${model} to respond...`);

    try {
      while (true) {
        let done: boolean;
        let value: Uint8Array | undefined;
        try {
          ({ done, value } = await reader.read());
        } catch (readErr: unknown) {
          if (readErr instanceof Error && readErr.name === "AbortError") {
            throw new OllamaError("LLM call timed out after 10 minutes");
          }
          throw readErr;
        }
        if (done) break;

        const chunk = leftover + decoder.decode(value, { stream: true });
        const lines = chunk.split("\n");
        // Last element may be a partial line — save for next iteration
        leftover = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const parsed = JSON.parse(trimmed) as {
              message?: { content?: string };
              done?: boolean;
              eval_count?: number;
              total_duration?: number;
            };
            if (parsed.message?.content) {
              accumulated += parsed.message.content;
              chunkCount++;
              // Forward token to UI — send accumulated text so the display
              // always shows the full current output (not just the delta)
              streamCtx!.onChunk(accumulated);
              if (!firstChunkSeen) {
                firstChunkSeen = true;
                activity?.(`[${role}] generating with ${model}...`);
              }
              // Throttle activity updates to every ~500ms so we don't spam DB
              const now = Date.now();
              if (now - lastActivityUpdate > 500) {
                activity?.(
                  `[${role}] generating... ${accumulated.length} chars / ${chunkCount} chunks`,
                );
                lastActivityUpdate = now;
              }
            }
            if (parsed.done) {
              totalTokens = parsed.eval_count ?? 0;
              totalDurationMs = parsed.total_duration
                ? Math.round(parsed.total_duration / 1_000_000)
                : 0;
            }
          } catch {
            // Malformed NDJSON line — ignore
          }
        }
      }
    } finally {
      clearTimeout(timeout);
      reader.releaseLock();
    }

    return {
      text: accumulated,
      prompt: promptLog,
      tokens: totalTokens,
      durationMs: totalDurationMs,
    };
  }

  // ── Non-streaming mode (fallback) ─────────────────────────────────────
  clearTimeout(timeout);
  const data: OllamaResponse = await res.json();

  // The response content continues after our prefill
  const fullText = prefill + (data.message?.content || "");

  return {
    text: fullText,
    prompt: promptLog,
    tokens: data.eval_count || 0,
    durationMs: data.total_duration
      ? Math.round(data.total_duration / 1_000_000)
      : 0,
  };
}

/**
 * Vision-aware companion to `callOllama`. Sends one or more base64-encoded
 * images alongside the user message. Non-streaming (vision models tend to
 * stream poorly through Ollama's NDJSON, and we only need a short reply).
 *
 * The caller is responsible for verifying the model supports vision —
 * pass a model where `modelCapabilities(model).vision === true`.
 */
export async function callOllamaVision(
  model: string,
  role: AgentRole,
  systemPrompt: string,
  userMessage: string,
  imagesBase64: string[],
  overrides?: { numPredict?: number; prefill?: string },
): Promise<{
  text: string;
  tokens: number;
  durationMs: number;
  prompt: string;
}> {
  const config = AGENT_CONFIGS[role];
  const numPredict = overrides?.numPredict ?? config.numPredict;
  const prefill = overrides?.prefill ?? ">>";

  // Ollama's chat API accepts `images: string[]` on the user message
  const messages = [
    { role: "system", content: systemPrompt },
    {
      role: "user",
      content: userMessage,
      images: imagesBase64,
    },
    { role: "assistant", content: prefill },
  ];

  const promptLog = `[SYSTEM]\n${systemPrompt}\n\n[USER]\n${userMessage}\n\n[IMAGES] ${imagesBase64.length} attached (${imagesBase64.reduce((n, b) => n + b.length, 0)} base64 chars)\n\n[PREFILL]\n${prefill}`;

  const body = {
    model,
    messages,
    stream: false,
    keep_alive: KEEP_ALIVE,
    think: false,
    options: {
      temperature: config.temperature,
      num_predict: numPredict,
      num_ctx: NUM_CTX,
      ...(NUM_THREAD !== undefined ? { num_thread: NUM_THREAD } : {}),
    },
    stop: [">>END"],
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5 * 60 * 1000);

  let res: Response;
  try {
    res = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err: unknown) {
    clearTimeout(timeout);
    if (err instanceof Error && err.name === "AbortError") {
      throw new OllamaError("Vision LLM call timed out after 5 minutes");
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    const errText = await res.text();
    throw new OllamaError(
      `Ollama vision API error (${res.status}): ${errText}`,
    );
  }

  const data: OllamaResponse = await res.json();
  const fullText = prefill + (data.message?.content || "");

  return {
    text: fullText,
    prompt: promptLog,
    tokens: data.eval_count || 0,
    durationMs: data.total_duration
      ? Math.round(data.total_duration / 1_000_000)
      : 0,
  };
}

/**
 * Check if Ollama is running and the model is available.
 */
export async function checkOllamaHealth(
  model: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    // Check if Ollama is running
    const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      return { ok: false, error: "Ollama is not responding" };
    }

    const data = await res.json();
    const models = (data.models || []).map((m: { name: string }) => m.name);

    // Check if the model is pulled (match with or without :latest tag)
    const hasModel = models.some(
      (m: string) =>
        m === model || m === `${model}:latest` || m.startsWith(`${model}:`),
    );

    if (!hasModel) {
      return {
        ok: false,
        error: `Model "${model}" not found. Available: ${models.join(", ")}`,
      };
    }

    return { ok: true };
  } catch {
    return {
      ok: false,
      error: "Cannot connect to Ollama. Is it running? (ollama serve)",
    };
  }
}

export class OllamaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OllamaError";
  }
}

/**
 * Get list of all locally available Ollama models.
 * Used for multi-model fallback when the primary model fails.
 */
export async function getAvailableModels(): Promise<string[]> {
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.models || []).map((m: { name: string }) => m.name);
  } catch {
    return [];
  }
}
