import { callOllama } from "@/lib/ollama";
import { parseTTM, ResultBlock } from "@/lib/protocol";

/**
 * File-type-specific system prompts.
 * Each prompt anchors the model on the exact language expected,
 * preventing common confusion (e.g. HTML leaking into JS/CSS).
 */
const SYSTEM_PROMPTS: Record<string, string> = {
  "index.html": `You are a Developer. Write a COMPLETE HTML document implementing ALL listed requirements.
Use semantic HTML5. Include <link rel="stylesheet" href="style.css"> in <head> and <script src="script.js"></script> before </body>.
Give every interactive element a unique id attribute (for JS to query).
NEVER write placeholder comments or descriptions. Write REAL, complete HTML code.
Do NOT echo back these instructions. Write actual HTML starting with <!DOCTYPE html>.

Reply format:
>>RESULT
status: DONE
filePath: index.html
output: |
  <!DOCTYPE html>
  <html lang="en">
  ... your complete HTML here ...
  </html>
>>END`,

  "style.css": `You are a Developer. Write a COMPLETE CSS file implementing ALL listed requirements.
Write ONLY CSS rules — no HTML, no <style> tags, no JavaScript.
Use the class names and IDs that appear in the HTML provided.
Include responsive, accessible, modern styles (flexbox/grid, hover states, transitions).
When given a draft, KEEP all existing rules and ADD more styling on top.
NEVER write placeholder comments or descriptions. Write REAL CSS rules.
Do NOT echo back these instructions. Write actual CSS rules.

Reply format:
>>RESULT
status: DONE
filePath: style.css
output: |
  body {
    ... your CSS rules here ...
  }
>>END`,

  "script.js": `You are a Developer. Write a COMPLETE JavaScript file implementing ALL listed requirements.
Write ONLY JavaScript — no HTML, no CSS, no <script> tags.
Use document.getElementById / querySelector to target elements from the HTML.
When given a draft with existing functions, KEEP them and ADD real logic inside each function body.
Declare each function and variable EXACTLY ONCE — no duplicates.
NEVER write placeholder comments or descriptions. Write REAL JavaScript code.
Do NOT echo back these instructions. Write actual JavaScript.

Reply format:
>>RESULT
status: DONE
filePath: script.js
output: |
  // script.js
  ... your JavaScript code here ...
>>END`,
};

const DEFAULT_PROMPT = `You are a Developer. Write the complete file implementing ALL requirements.
No frameworks — plain HTML, CSS, JavaScript only.
NEVER write placeholder comments or descriptions. Write REAL working code.
Do NOT echo back these instructions.

Reply format:
>>RESULT
status: DONE
filePath: (filename)
output: |
  ... your complete code here ...
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

  // Full-file mode with generous token limit — JS needs more room
  const numPredict = filePath === "script.js" ? 3000 : 2500;

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
