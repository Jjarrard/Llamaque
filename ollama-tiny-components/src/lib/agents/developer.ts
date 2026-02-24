import { callOllama } from "@/lib/ollama";
import { parseTTM, ResultBlock } from "@/lib/protocol";

/**
 * System prompt for React TSX component generation.
 * The output is a single Component.tsx file with inline styles.
 */
const SYSTEM_PROMPTS: Record<string, string> = {
  "Component.tsx": `Write a complete React component. Rules:
- export default function ComponentName()
- Inline styles ONLY: style={{ }}
- React hooks for state (useState, useEffect, useRef)
- Must return JSX
- Real working code, no placeholders

Reply:
>>RESULT
status: DONE
filePath: Component.tsx
output: |
  import React, { useState } from "react";

  export default function Component() {
    return <div>...</div>;
  }
>>END`,
};

const DEFAULT_PROMPT = `Write a complete React component.
- export default function, inline styles only
- Real working code, no placeholders
- Must return JSX

Reply:
>>RESULT
status: DONE
filePath: Component.tsx
output: |
  (full component code)
>>END`;

/**
 * Run the Developer agent.
 *
 * The pipeline builds the full userMessage (including HTML context, requirements,
 * QA feedback, etc.) so this function just forwards it to Ollama with the
 * appropriate file-type system prompt.
 */
export async function runDeveloper(
  model: string,
  userMessage: string,
  filePath?: string,
): Promise<{
  block: ResultBlock | null;
  raw: string;
  prompt: string;
  tokens: number;
  durationMs: number;
}> {
  const systemPrompt = (filePath && SYSTEM_PROMPTS[filePath]) || DEFAULT_PROMPT;

  const { text, prompt, tokens, durationMs } = await callOllama(
    model,
    "developer",
    systemPrompt,
    userMessage,
  );

  const block = parseTTM(text);

  if (block && block.command === "RESULT") {
    return {
      block: block as ResultBlock,
      raw: text,
      prompt,
      tokens,
      durationMs,
    };
  }

  return { block: null, raw: text, prompt, tokens, durationMs };
}
