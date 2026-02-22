/**
 * Ollama API client with hardening for small LLMs.
 *
 * - Prefills assistant response with ">>" to prevent preamble
 * - Uses ">>END" as a stop sequence
 * - Sets temperature and num_predict per agent role
 */

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://localhost:11434";

export type AgentRole =
  | "project-manager"
  | "reviewer"
  | "improver"
  | "manager"
  | "developer"
  | "qa"
  | "summariser"
  | "editor"
  | "feedback";

interface AgentConfig {
  temperature: number;
  numPredict: number;
}

const AGENT_CONFIGS: Record<AgentRole, AgentConfig> = {
  "project-manager": { temperature: 0.3, numPredict: 400 },
  reviewer: { temperature: 0, numPredict: 300 },
  improver: { temperature: 0, numPredict: 400 },
  manager: { temperature: 0, numPredict: 250 },
  developer: { temperature: 0, numPredict: 600 },
  qa: { temperature: 0, numPredict: 100 },
  summariser: { temperature: 0, numPredict: 100 },
  editor: { temperature: 0, numPredict: 300 },
  feedback: { temperature: 0, numPredict: 400 },
};

/** Context window limit — prompt + response must fit within this */
const NUM_CTX = 4096;

/** Keep model loaded between calls (seconds). -1 = forever. */
const KEEP_ALIVE = "30m";

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
 */
export async function callOllama(
  model: string,
  role: AgentRole,
  systemPrompt: string,
  userMessage: string,
  overrides?: { numPredict?: number },
): Promise<{
  text: string;
  tokens: number;
  durationMs: number;
  prompt: string;
}> {
  const config = AGENT_CONFIGS[role];
  const numPredict = overrides?.numPredict ?? config.numPredict;

  const messages: OllamaMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage },
    // Prefill: start the assistant response with ">>" to skip preamble
    { role: "assistant", content: ">>" },
  ];

  // Build a readable prompt log
  const promptLog = `[SYSTEM]\n${systemPrompt}\n\n[USER]\n${userMessage}`;

  const body = {
    model,
    messages,
    stream: false,
    keep_alive: KEEP_ALIVE,
    options: {
      temperature: config.temperature,
      num_predict: numPredict,
      num_ctx: NUM_CTX,
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
  clearTimeout(timeout);

  if (!res.ok) {
    const errText = await res.text();
    throw new OllamaError(`Ollama API error (${res.status}): ${errText}`);
  }

  const data: OllamaResponse = await res.json();

  // The response content continues after our ">>" prefill
  // Reconstruct the full block: ">>" + response
  const fullText = ">>" + (data.message?.content || "");

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
