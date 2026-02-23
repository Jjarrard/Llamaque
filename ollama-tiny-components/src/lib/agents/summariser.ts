import { callOllama } from "@/lib/ollama";
import { parseTTM, SummaryBlock } from "@/lib/protocol";

const SYSTEM_PROMPT = `You are a Summariser. Given completed task outputs, compress them into a short context summary.
Max 3 sentences. ALWAYS preserve: element IDs, class names, function names, variable names, file paths.
Reply with:
>>SUMMARY
context: "compressed summary here"
>>END`;

export async function runSummariser(
  model: string,
  completedWork: string,
): Promise<{
  block: SummaryBlock | null;
  raw: string;
  prompt: string;
  tokens: number;
  durationMs: number;
}> {
  const userMessage = `Completed work to summarise:\n${completedWork}`;

  const { text, prompt, tokens, durationMs } = await callOllama(
    model,
    "summariser",
    SYSTEM_PROMPT,
    userMessage,
  );

  const block = parseTTM(text);

  if (block && block.command === "SUMMARY") {
    return {
      block: block as SummaryBlock,
      raw: text,
      prompt,
      tokens,
      durationMs,
    };
  }

  return { block: null, raw: text, prompt, tokens, durationMs };
}
