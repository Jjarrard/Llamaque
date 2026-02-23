import { callOllama } from "@/lib/ollama";
import { parseTTM, QABlock } from "@/lib/protocol";

const SYSTEM_PROMPT = `You are QA. Given a task and its code snippet, check:
1. Does the snippet address what the task asks for?
2. Is the code syntactically valid?
3. Are there obvious bugs?

Be LENIENT. This is a small snippet that will be inserted into a larger file.
Do NOT fail for: missing surrounding code, missing imports, incomplete files, or style preferences.
Only FAIL for: completely wrong output, syntax errors, or code that won't work.

Reply with:
>>QA
task: (the task)
output: (brief)
verdict: PASS or FAIL
reason: (one sentence)
>>END`;

export async function runQA(
  model: string,
  taskDescription: string,
  output: string,
): Promise<{
  block: QABlock | null;
  raw: string;
  prompt: string;
  tokens: number;
  durationMs: number;
}> {
  // Truncate output if too long to keep context small
  const truncatedOutput =
    output.length > 800 ? output.slice(0, 800) + "\n...(truncated)" : output;

  const userMessage = `task: ${taskDescription}\noutput: |\n  ${truncatedOutput.split("\n").join("\n  ")}`;

  const { text, prompt, tokens, durationMs } = await callOllama(
    model,
    "qa",
    SYSTEM_PROMPT,
    userMessage,
  );

  const block = parseTTM(text);

  if (block && block.command === "QA") {
    return { block: block as QABlock, raw: text, prompt, tokens, durationMs };
  }

  // If parse fails, treat as FAIL (conservative)
  return { block: null, raw: text, prompt, tokens, durationMs };
}
