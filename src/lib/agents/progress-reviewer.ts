import { callOllama } from "@/lib/ollama";

/**
 * Progress Reviewer agent — the "PM honing role".
 *
 * Runs AFTER the developer and iterative QA passes have completed.
 * Reads the project spec and the final source files, then reports
 * which spec-level features appear DONE vs MISSING. The pipeline
 * uses the MISSING list to drive a final round of patch-based fixes.
 *
 * This catches "spec drift" — cases where the developer technically
 * built something compileable that doesn't match the user's intent
 * (e.g. spec says "add a delete button" but the model only added
 * a delete handler, no button rendered).
 *
 * The agent emits a structured block; we parse it deterministically.
 *
 * Output format:
 *
 *   >>PROGRESS
 *   done:
 *   - feature A
 *   - feature B
 *   missing:
 *   - feature C in <file>
 *   - feature D in <file>
 *   nextAction: short single sentence
 *   >>END
 */

const SYSTEM_PROMPT = `You are a project manager reviewing whether a built project matches its spec.

You will be given the project description and the FINAL source files. Compare them against the spec and produce a short progress report.

Reply ONLY in this exact format. Be concise — bullets, not paragraphs.

>>PROGRESS
done:
- <one feature from the spec that is fully implemented and visible in the UI>
- <another done feature>
missing:
- <one spec feature that is NOT implemented or NOT wired up correctly> in <filename>
- <another missing feature> in <filename>
nextAction: <a single sentence describing the single most important thing to add next>
>>END

Rules:
- "missing" is for things the SPEC explicitly asks for that are not in the code OR not rendered in the UI.
- Do NOT list "missing" items that are out of scope for the spec.
- Do NOT list polish/style improvements as "missing" — only spec-required behaviour.
- If everything in the spec is done, leave the missing list empty (just write "missing:" with no bullets) and nextAction: "All spec features implemented."
- Cap each list at 5 items.
- Reference real filenames from the file list provided.`;

export interface ProgressReviewResult {
  done: string[];
  missing: { feature: string; file: string }[];
  nextAction: string;
  raw: string;
  prompt: string;
  tokens: number;
  durationMs: number;
}

export interface ProjectFileSnapshot {
  path: string;
  content: string;
}

export async function runProgressReviewer(
  model: string,
  projectName: string,
  projectDescription: string,
  files: ProjectFileSnapshot[],
): Promise<ProgressReviewResult> {
  // Cap individual files to keep prompt size reasonable.
  // 80 lines is enough to see exports, JSX, and main handlers.
  const fileBlocks = files
    .map((f) => {
      const lines = f.content.split("\n");
      const trimmed =
        lines.length > 80
          ? lines.slice(0, 80).join("\n") +
            `\n... (${lines.length - 80} more lines)`
          : f.content;
      return `--- ${f.path} (${lines.length} lines) ---\n${trimmed}`;
    })
    .join("\n\n");

  const userMessage = `Project: ${projectName}
Spec: ${projectDescription}

FINAL SOURCE FILES:
${fileBlocks}

Review and emit the PROGRESS block.`;

  const { text, prompt, tokens, durationMs } = await callOllama(
    model,
    "reviewer",
    SYSTEM_PROMPT,
    userMessage,
  );

  const parsed = parseProgress(
    text,
    files.map((f) => f.path),
  );

  return {
    ...parsed,
    raw: text,
    prompt,
    tokens,
    durationMs,
  };
}

/**
 * Parse a >>PROGRESS block. Tolerant of minor formatting drift —
 * small models often skip the >>END marker or use slightly different
 * bullet characters.
 */
export function parseProgress(
  text: string,
  knownFiles: string[],
): {
  done: string[];
  missing: { feature: string; file: string }[];
  nextAction: string;
} {
  // Extract block content between >>PROGRESS and >>END (or EOF)
  const match = text.match(/>>PROGRESS\s*\n([\s\S]*?)(?:>>END|$)/i);
  const body = match ? match[1] : text;

  const lines = body.split("\n");
  const done: string[] = [];
  const missing: { feature: string; file: string }[] = [];
  let nextAction = "";

  type Section = "none" | "done" | "missing";
  let section: Section = "none";

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (/^done\s*:/i.test(line)) {
      section = "done";
      continue;
    }
    if (/^missing\s*:/i.test(line)) {
      section = "missing";
      continue;
    }
    if (/^next\s*action\s*:/i.test(line)) {
      section = "none";
      nextAction = line.replace(/^next\s*action\s*:\s*/i, "").trim();
      continue;
    }

    // Bullet line
    const bullet = line.match(/^[-*•]\s*(.+)$/);
    if (!bullet) continue;
    const item = bullet[1].trim();
    if (!item) continue;

    if (section === "done") {
      done.push(item);
    } else if (section === "missing") {
      // Try to extract " in <filename>" from the end of the bullet
      let feature = item;
      let file = "";
      const fileMatch = item.match(/^(.+?)\s+in\s+([^\s]+)\s*$/i);
      if (fileMatch) {
        feature = fileMatch[1].trim();
        file = fileMatch[2].trim().replace(/[`'"]/g, "");
      }
      // Fall back: pick the first known file that appears in the item text
      if (!file) {
        const hit = knownFiles.find((p) =>
          item.toLowerCase().includes(p.toLowerCase()),
        );
        if (hit) file = hit;
      }
      // Final fallback: use the first known file (best-guess targeting)
      if (!file && knownFiles.length > 0) file = knownFiles[0];
      missing.push({ feature, file });
    }
  }

  return { done, missing, nextAction };
}
