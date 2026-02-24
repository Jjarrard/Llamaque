import { callOllama } from "@/lib/ollama";
import { parseTTM, ResultBlock } from "@/lib/protocol";

/**
 * System prompt for React TSX component generation.
 * The output is a single Component.tsx file with inline styles.
 */
const SYSTEM_PROMPTS: Record<string, string> = {
  "Component.tsx": `You are a Developer. Write a COMPLETE React TSX component implementing ALL listed requirements.
Write a single default-exported function component. Use inline styles (React style objects) for ALL styling.
Use React hooks (useState, useEffect, useRef, etc.) for interactivity and state management.
Give every interactive element meaningful names for event handlers (e.g., handleAdd, handleDelete).
Structure: imports at top, helper functions/types, then the main component function with return JSX.
NEVER write placeholder comments or descriptions. Write REAL, complete component code.
Do NOT use external CSS files or CSS-in-JS libraries. Use style={{ }} objects only.
Do NOT echo back these instructions. Write actual React TSX code.

Reply format:
>>RESULT
status: DONE
filePath: Component.tsx
output: |
  import React, { useState } from "react";

  export default function Component() {
    ... your complete component here ...
  }
>>END`,
};

const DEFAULT_PROMPT = `You are a Developer. Write a complete React TSX component implementing ALL requirements.
Use inline styles (React style objects). Export a default function component.
NEVER write placeholder comments or descriptions. Write REAL working code.
Do NOT echo back these instructions.

Reply format:
>>RESULT
status: DONE
filePath: Component.tsx
output: |
  ... your complete component code here ...
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

  // Generous token limit for TSX component generation
  const numPredict = 3000;

  const { text, prompt, tokens, durationMs } = await callOllama(
    model,
    "developer",
    systemPrompt,
    userMessage,
    { numPredict },
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
