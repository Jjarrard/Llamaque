import { callOllama } from "@/lib/ollama";
import { parseTTM, BreakdownBlock } from "@/lib/protocol";

const SYSTEM_PROMPT = `You are a Project Manager. Break the user's idea into 3-5 high-level epics.
Each epic must be a CORE FEATURE of the specific app the user described.
Think: what are the main things a user would DO with this app? Each epic = one of those things.
Do NOT mention files. Do NOT mention HTML, CSS, JS, or React. Just describe WHAT the component needs.
Do NOT use generic features. Every epic must directly serve the app's purpose.

Example for a "weather app":
>>BREAKDOWN
- task: "Current weather display with temperature, conditions, and icon"
- task: "City search and location selection"
- task: "5-day forecast view"
>>END

Now break down the user's project the same way — epics specific to THEIR app idea.
Reply ONLY with >>BREAKDOWN ... >>END`;

export async function runProjectManager(
  model: string,
  projectName: string,
  projectDescription: string,
): Promise<{
  block: BreakdownBlock | null;
  raw: string;
  prompt: string;
  tokens: number;
  durationMs: number;
}> {
  const userMessage = `Project: ${projectName}\nDescription: ${projectDescription}`;

  const { text, prompt, tokens, durationMs } = await callOllama(
    model,
    "project-manager",
    SYSTEM_PROMPT,
    userMessage,
  );

  const block = parseTTM(text);

  if (block && block.command === "BREAKDOWN") {
    return {
      block: block as BreakdownBlock,
      raw: text,
      prompt,
      tokens,
      durationMs,
    };
  }

  return { block: null, raw: text, prompt, tokens, durationMs };
}
