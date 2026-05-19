import { callOllama } from "@/lib/ollama";
import { parseTTM, PlanBlock } from "@/lib/protocol";

/**
 * Planner agent — chain-of-thought pass before code generation.
 *
 * Makes a single low-token call to produce a 3-5 bullet implementation
 * skeleton for a file. For code files the skeleton names concrete
 * identifiers (state variables, handler names, key functions) so the
 * Developer agent uses consistent names across every enhancement step.
 *
 * This agent NEVER retries and NEVER throws. If the call fails or the
 * model produces unusable output, it returns null and the pipeline
 * continues without a skeleton.
 */

/**
 * File-type-aware system prompts.
 * Code files ask for concrete identifiers; doc/config files ask for structure.
 */
function getSystemPrompt(ext: string): string {
  switch (ext) {
    case "tsx":
    case "jsx":
      return `You are an implementation planner for a React component.
List 3-5 bullet points naming the EXACT identifiers you will use:
- useState calls (e.g. const [items, setItems] = useState([]))
- key handler names (e.g. handleAdd, handleDelete)
- main JSX sections (e.g. <form>, <ul with items.map>)
Be specific. Use real variable and function names.
Reply:
>>PLAN
- bullet
- bullet
>>END`;

    case "ts":
    case "js":
      return `You are an implementation planner for a TypeScript/JS module.
List 3-5 bullet points naming:
- exported function/type names
- key internal variables or data structures
- any external imports needed
Be specific. Use real names.
Reply:
>>PLAN
- bullet
- bullet
>>END`;

    case "py":
      return `You are an implementation planner for a Python script.
List 3-5 bullet points naming:
- key function or class names
- important variables or data structures
- any imports needed
Be specific. Use real names.
Reply:
>>PLAN
- bullet
- bullet
>>END`;

    default:
      return `You are an implementation planner.
List 3-5 bullet points describing the structure of the file.
Be specific about sections, headings, or major elements.
Reply:
>>PLAN
- bullet
- bullet
>>END`;
  }
}

const FILE_TYPE_LABELS: Record<string, string> = {
  tsx: "React component",
  jsx: "React component",
  ts: "TypeScript module",
  js: "JavaScript module",
  py: "Python script",
  html: "HTML page",
  css: "CSS stylesheet",
  md: "Markdown document",
  json: "JSON file",
};

/**
 * Returns a short implementation skeleton (bullet list as a string), or
 * null if the call fails or the model doesn't produce a usable plan.
 *
 * Only called when requirements.length >= 2 — single-requirement files
 * don't benefit enough to justify the extra round-trip.
 */
export async function runPlanner(
  model: string,
  filePath: string,
  requirements: string[],
  manifestDescription?: string,
  contractSnippet?: string,
): Promise<string | null> {
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  const fileTypeLabel = FILE_TYPE_LABELS[ext] || "file";
  const systemPrompt = getSystemPrompt(ext);

  let userMessage = `File: ${filePath} (${fileTypeLabel})`;
  if (manifestDescription) {
    userMessage += `\nRole: ${manifestDescription}`;
  }
  userMessage += `\nRequirements:\n${requirements.map((r, i) => `${i + 1}. ${r}`).join("\n")}`;
  if (contractSnippet) {
    userMessage += `\n\nShared types (use these exact names):\n${contractSnippet}`;
  }
  userMessage += `\n\nReply with a >>PLAN block.`;

  try {
    const { text } = await callOllama(
      model,
      "planner",
      systemPrompt,
      userMessage,
    );

    const block = parseTTM(text);
    if (!block || block.command !== "PLAN") return null;

    const steps = (block as PlanBlock).steps;
    if (steps.length === 0) return null;

    return steps.map((s) => `- ${s}`).join("\n");
  } catch {
    return null;
  }
}
