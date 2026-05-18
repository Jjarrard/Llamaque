import { callOllama } from "@/lib/ollama";
import { ManifestFile } from "@/db/schema";
import { checkTypeScriptSyntax } from "@/lib/ops/compiler";

/**
 * ContractDesigner agent — runs once after Architect, before code generation.
 *
 * For multi-file TypeScript projects it produces a short list of shared
 * type/interface names that every file should agree on (e.g. the shape of
 * a Todo item, a handler prop signature, a shared constant name).
 *
 * The output is NOT written as a full _contracts.ts file — that would
 * require another file for the LLM to maintain and could grow unbounded.
 * Instead we produce a compact "contracts snippet": 3-6 lines of TS
 * interface/type definitions that get injected into every Developer
 * system prompt as a small context anchor.
 *
 * Only runs when:
 *   - There are >= 2 TypeScript/TSX files in the manifest
 *   - The project has a meaningful description (>10 chars)
 *
 * NEVER retries and NEVER throws. Returns null on any failure.
 * The pipeline continues unmodified if this returns null.
 */

const SYSTEM_PROMPT = `You are a TypeScript interface designer.
Given a list of files for a project, write 3-6 lines of shared TypeScript types.
Rules:
- Only write interface or type definitions — no imports, no code
- Name the types after the project's domain objects (e.g. Todo, Item, User)
- Keep each definition on one line
- Output ONLY the type definitions, nothing else`;

/**
 * Returns a compact TS types snippet (multi-line string), or null if the
 * project doesn't need shared contracts or the call fails.
 */
export async function runContractDesigner(
  model: string,
  projectName: string,
  projectDescription: string,
  manifest: ManifestFile[],
): Promise<string | null> {
  // Only useful for multi-file TS/TSX projects
  const tsFiles = manifest.filter((f) =>
    ["ts", "tsx", "jsx"].includes(f.path.split(".").pop()?.toLowerCase() ?? ""),
  );
  if (tsFiles.length < 2) return null;
  if (projectDescription.length < 10) return null;

  const fileList = tsFiles
    .map((f) => `- ${f.path}: ${f.description}`)
    .join("\n");

  const userMessage = `Project: ${projectName}
Description: ${projectDescription}

Files:
${fileList}

Write 3-6 TypeScript type/interface definitions that these files will share.`;

  try {
    const { text } = await callOllama(
      model,
      "planner", // reuse planner role: temperature 0, numPredict 200
      SYSTEM_PROMPT,
      userMessage,
    );

    // Strip any TTM block markers the model might emit, markdown fences,
    // and blank lines. Keep only lines that look like complete one-line TS
    // type definitions — discard multi-line block openers (e.g. "interface X {")
    // because they arrive without a body and produce invalid TS fragments.
    const snippet = text
      .replace(/>>[\w]+/g, "")
      .replace(/```[\w]*/g, "")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => {
        if (
          !(
            l.startsWith("type ") ||
            l.startsWith("interface ") ||
            l.startsWith("export type ") ||
            l.startsWith("export interface ")
          )
        )
          return false;
        // Reject lines that open a block without closing it (multi-line fragment)
        const opens = (l.match(/\{/g) || []).length;
        const closes = (l.match(/\}/g) || []).length;
        if (opens !== closes) return false;
        return true;
      })
      .slice(0, 6)
      .join("\n");

    if (snippet.length === 0) return null;

    // Final guard: validate with TS syntax checker before injecting into prompts
    const synErrors = checkTypeScriptSyntax("contracts.ts", snippet);
    if (synErrors.length > 0) return null;

    return snippet;
  } catch {
    return null;
  }
}
