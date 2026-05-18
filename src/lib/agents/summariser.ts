import { callOllama } from "@/lib/ollama";
import { parseTTM, SummaryBlock } from "@/lib/protocol";

const SYSTEM_PROMPT = `You are a code summariser.
Given a source file, output ONE line listing its key identifiers.
Format: "<filePath>: exports <ExportNames>; state <stateVars>; handlers <handlerNames>"
Only include what actually exists in the code. Omit empty sections.
Reply with:
>>SUMMARY
context: "<one line summary>"
>>END`;

export async function runSummariser(
  model: string,
  filePath: string,
  fileContent: string,
): Promise<{
  block: SummaryBlock | null;
  raw: string;
  prompt: string;
  tokens: number;
  durationMs: number;
}> {
  const userMessage = `File: ${filePath}\n\n${fileContent}`;

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
