/**
 * TinyTask Markup (TTM) Protocol Parser
 *
 * Parses structured >>COMMAND ... >>END blocks from LLM responses.
 * Designed to be fuzzy — handles malformed output from small LLMs.
 */

export type TTMCommand =
  | "BREAKDOWN"
  | "READY"
  | "RESULT"
  | "QA"
  | "SUMMARY"
  | "EDIT"
  | "EXECUTE";

export interface BreakdownBlock {
  command: "BREAKDOWN";
  tasks: string[];
}

export interface ReadyBlock {
  command: "READY";
  task: string;
  filePath?: string;
}

export interface ResultBlock {
  command: "RESULT";
  status: string;
  filePath?: string;
  output: string;
}

export interface QABlock {
  command: "QA";
  task: string;
  output: string;
  verdict: "PASS" | "FAIL";
  reason: string;
}

export interface SummaryBlock {
  command: "SUMMARY";
  context: string;
}

export interface EditBlock {
  command: "EDIT";
  filePath: string;
  startLine: number;
  endLine: number;
  replace: string;
}

export interface ExecuteBlock {
  command: "EXECUTE";
  task: string;
  context?: string;
  filePath?: string;
}

export type TTMBlock =
  | BreakdownBlock
  | ReadyBlock
  | ResultBlock
  | QABlock
  | SummaryBlock
  | EditBlock
  | ExecuteBlock;

/**
 * Extract the first valid TTM block from an LLM response.
 * Case-insensitive. Handles missing >>END (uses end of string).
 * Ignores everything outside the block.
 */
export function parseTTM(raw: string): TTMBlock | null {
  if (!raw || typeof raw !== "string") return null;

  // Normalise: the response may have been prefilled with ">>"
  // so the actual content might start with just the command name
  const text = raw.trim();

  // Try to find a >>COMMAND block (case-insensitive)
  const blockRegex = />>(\w+)\s*\n([\s\S]*?)(?:>>END|$)/i;
  const match = text.match(blockRegex);

  if (!match) {
    // Try without >> prefix (in case prefill already consumed it)
    const noPrefixRegex = /^(\w+)\s*\n([\s\S]*?)(?:>>END|$)/i;
    const altMatch = text.match(noPrefixRegex);
    if (!altMatch) return null;
    return parseBlock(altMatch[1].toUpperCase() as TTMCommand, altMatch[2]);
  }

  return parseBlock(match[1].toUpperCase() as TTMCommand, match[2]);
}

function parseBlock(command: string, body: string): TTMBlock | null {
  const trimmed = body.trim();

  switch (command) {
    case "BREAKDOWN":
      return parseBreakdown(trimmed);
    case "READY":
      return parseReady(trimmed);
    case "RESULT":
      return parseResult(trimmed);
    case "QA":
      return parseQA(trimmed);
    case "SUMMARY":
      return parseSummary(trimmed);
    case "EDIT":
      return parseEdit(trimmed);
    case "EXECUTE":
      return parseExecute(trimmed);
    default:
      return null;
  }
}

function parseBreakdown(body: string): BreakdownBlock | null {
  const tasks: string[] = [];
  // Match lines like: - task: "description" or - "description" or - description
  const lines = body.split("\n");
  for (const line of lines) {
    const trimmedLine = line.trim();
    if (!trimmedLine) continue;

    // Try: - task: "description"
    let match = trimmedLine.match(/^-\s*task:\s*"(.+?)"\s*$/);
    if (match) {
      tasks.push(match[1]);
      continue;
    }
    // Try: - task: description (no quotes)
    match = trimmedLine.match(/^-\s*task:\s*(.+)$/);
    if (match) {
      tasks.push(match[1].replace(/^["']|["']$/g, "").trim());
      continue;
    }
    // Try: - "description"
    match = trimmedLine.match(/^-\s*"(.+?)"\s*$/);
    if (match) {
      tasks.push(match[1]);
      continue;
    }
    // Try: - description (bare)
    match = trimmedLine.match(/^-\s+(.+)$/);
    if (match) {
      tasks.push(match[1].replace(/^["']|["']$/g, "").trim());
    }
  }

  if (tasks.length === 0) return null;
  return { command: "BREAKDOWN", tasks };
}

function parseReady(body: string): ReadyBlock | null {
  const match = body.match(/task:\s*"?(.+?)"?\s*$/m);
  if (!match) return null;
  const filePath =
    extractField(body, "filePath") || extractField(body, "filepath");
  return {
    command: "READY",
    task: match[1].trim(),
    filePath: filePath || undefined,
  };
}

function parseResult(body: string): ResultBlock | null {
  const status = extractField(body, "status") || "DONE";
  const filePath =
    extractField(body, "filePath") || extractField(body, "filepath");

  // Try standard multiline field first
  let output = extractMultilineField(body, "output");

  // Fallback 1: output on a single line (output: <html>...)
  if (!output) {
    const singleLine = body.match(/^\s*output:\s*(.+)$/im);
    if (singleLine && !singleLine[1].startsWith("|")) {
      output = singleLine[1].trim().replace(/^["']|["']$/g, "");
    }
  }

  // Fallback 2: everything after status/filePath lines is probably the code
  if (!output) {
    const lines = body.split("\n");
    const codeLines: string[] = [];
    let pastHeaders = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!pastHeaders) {
        if (
          trimmed.match(/^(status|filePath|filepath|output):/i) ||
          trimmed === ""
        ) {
          continue;
        }
        pastHeaders = true;
      }
      codeLines.push(line);
    }
    const joined = codeLines.join("\n").trim();
    if (joined.length > 0) {
      output = joined;
    }
  }

  if (!output) return null;
  return {
    command: "RESULT",
    status,
    filePath: filePath || undefined,
    output,
  };
}

function parseQA(body: string): QABlock | null {
  const task = extractField(body, "task") || "";
  const output = extractMultilineField(body, "output") || "";
  const verdictRaw = extractField(body, "verdict") || "";
  const reason = extractField(body, "reason") || "";

  const verdict = verdictRaw.toUpperCase().includes("PASS") ? "PASS" : "FAIL";

  return { command: "QA", task, output, verdict, reason };
}

function parseSummary(body: string): SummaryBlock | null {
  const context = extractField(body, "context");
  if (!context) {
    // Try treating the whole body as context
    if (body.trim()) return { command: "SUMMARY", context: body.trim() };
    return null;
  }
  return { command: "SUMMARY", context };
}

function parseEdit(body: string): EditBlock | null {
  const filePath =
    extractField(body, "filePath") || extractField(body, "filepath") || "";
  const startLineStr =
    extractField(body, "startLine") || extractField(body, "startline") || "0";
  const endLineStr =
    extractField(body, "endLine") || extractField(body, "endline") || "0";
  const replace = extractMultilineField(body, "replace") || "";

  const startLine = parseInt(startLineStr, 10);
  const endLine = parseInt(endLineStr, 10);

  if (!filePath || isNaN(startLine) || isNaN(endLine)) return null;

  return { command: "EDIT", filePath, startLine, endLine, replace };
}

function parseExecute(body: string): ExecuteBlock | null {
  const task = extractField(body, "task") || "";
  const context = extractField(body, "context") || undefined;
  const filePath =
    extractField(body, "filePath") ||
    extractField(body, "filepath") ||
    undefined;
  if (!task) return null;
  return { command: "EXECUTE", task, context, filePath };
}

// --- Helpers ---

/**
 * Extract a single-line field value: `key: "value"` or `key: value`
 */
function extractField(body: string, key: string): string | null {
  const regex = new RegExp(`^\\s*${key}:\\s*"?(.+?)"?\\s*$`, "im");
  const match = body.match(regex);
  if (!match) return null;
  return match[1].trim();
}

/**
 * Extract a multi-line field (uses | block scalar notation).
 * Everything indented after "key: |" until the next unindented key or end.
 */
function extractMultilineField(body: string, key: string): string | null {
  // Find the "key: |" line, then collect ALL subsequent lines that are
  // either indented or blank, stopping at the next field header or >>END.
  const headerRegex = new RegExp(`^\\s*${key}:\\s*\\|\\s*$`, "im");
  const headerMatch = body.match(headerRegex);
  if (headerMatch && headerMatch.index !== undefined) {
    const afterHeader = body.slice(headerMatch.index + headerMatch[0].length);
    const lines = afterHeader.split("\n");
    // Skip the first element (empty string before first \n)
    const contentLines: string[] = [];
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      // Stop at next field header (e.g. "status:", "filePath:") or >>END
      if (/^\s*>>END/i.test(line)) break;
      if (/^\S+\w+:\s/.test(line)) break;
      contentLines.push(line);
    }

    if (contentLines.length === 0) {
      return extractField(body, key);
    }

    // Strip common leading whitespace
    const minIndent = contentLines
      .filter((l) => l.trim().length > 0)
      .reduce((min, l) => {
        const indent = l.match(/^(\s*)/)?.[1].length || 0;
        return Math.min(min, indent);
      }, Infinity);

    return contentLines
      .map((l) => (l.length >= minIndent ? l.slice(minIndent) : l))
      .join("\n")
      .trimEnd();
  }

  // Fallback: try single-line value
  return extractField(body, key);
}

/**
 * Extract references from code output (IDs, classes, function names).
 * Used by the system to build the reference registry — not by the LLM.
 */
export function extractReferences(
  output: string,
  filePath: string,
): { filePath: string; refType: string; refName: string }[] {
  const refs: { filePath: string; refType: string; refName: string }[] = [];

  // HTML element IDs: id="something" or id='something'
  const idMatches = output.matchAll(/id=["']([^"']+)["']/g);
  for (const m of idMatches) {
    refs.push({ filePath, refType: "id", refName: `#${m[1]}` });
  }

  // CSS classes: class="something something"
  const classMatches = output.matchAll(/class=["']([^"']+)["']/g);
  for (const m of classMatches) {
    for (const cls of m[1].split(/\s+/)) {
      if (cls) refs.push({ filePath, refType: "class", refName: `.${cls}` });
    }
  }

  // JS function declarations: function name( or const name = (
  const funcMatches = output.matchAll(
    /(?:function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:function|\(|async))/g,
  );
  for (const m of funcMatches) {
    const name = m[1] || m[2];
    if (name)
      refs.push({ filePath, refType: "function", refName: `${name}()` });
  }

  // Global variables / constants (top-level const/let/var not followed by function)
  const varMatches = output.matchAll(
    /^(?:const|let|var)\s+(\w+)\s*=\s*(?!function|\(|async)/gm,
  );
  for (const m of varMatches) {
    refs.push({ filePath, refType: "variable", refName: m[1] });
  }

  return refs;
}

/**
 * Build a compact reference summary string for injection into Developer context.
 */
export function formatReferenceRegistry(
  refs: { filePath: string; refType: string; refName: string }[],
): string {
  const byFile = new Map<string, string[]>();
  for (const r of refs) {
    if (!byFile.has(r.filePath)) byFile.set(r.filePath, []);
    byFile.get(r.filePath)!.push(r.refName);
  }

  const lines: string[] = [];
  for (const [fp, names] of byFile) {
    lines.push(`${fp}: ${names.join(", ")}`);
  }
  return lines.join("\n");
}

/**
 * Banned phrases that indicate vague/circular task decomposition.
 */
const BANNED_PHRASES = [
  "handle the rest",
  "finish up",
  "remaining work",
  "and more",
  "everything else",
  "do the rest",
];

/**
 * Common filler words to ignore when calculating keyword overlap.
 * These naturally appear in both parent and child tasks without implying circularity.
 */
const STOP_WORDS = new Set([
  "the",
  "for",
  "and",
  "with",
  "that",
  "this",
  "from",
  "into",
  "using",
  "create",
  "add",
  "write",
  "build",
  "implement",
  "make",
  "set",
  "get",
  "html",
  "css",
  "javascript",
  "file",
  "page",
  "section",
  "component",
  "index",
  "style",
  "app",
  "main",
  "new",
  "basic",
  "simple",
]);

/**
 * Check if a subtask is too similar to its parent (circular) or too vague.
 * A subtask that uses a SUBSET of parent words is valid as long as it narrows scope
 * (i.e. is significantly shorter than the parent).
 */
export function isVagueOrCircular(
  parentDesc: string,
  childDesc: string,
): { isVague: boolean; reason: string } {
  const lower = childDesc.toLowerCase();

  // Check banned phrases
  for (const phrase of BANNED_PHRASES) {
    if (lower.includes(phrase)) {
      return { isVague: true, reason: `Contains banned phrase: "${phrase}"` };
    }
  }

  // Check keyword overlap (excluding stop words)
  const parentWords = parentDesc
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
  const parentWordSet = new Set(parentWords);
  const childWords = childDesc
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));

  if (childWords.length === 0) {
    // No meaningful words left after filtering — check raw length
    const rawWords = childDesc.split(/\W+/).filter((w) => w.length > 0);
    if (rawWords.length < 3) {
      return { isVague: true, reason: "Task description is too short" };
    }
    // All words were stop words — that's fine, not vague
    return { isVague: false, reason: "" };
  }

  // Check if child is essentially identical to parent (normalized)
  const parentNorm = parentDesc.toLowerCase().replace(/\W+/g, " ").trim();
  const childNorm = childDesc.toLowerCase().replace(/\W+/g, " ").trim();
  if (parentNorm === childNorm) {
    return { isVague: true, reason: "Subtask is identical to parent" };
  }

  const overlap = childWords.filter((w) => parentWordSet.has(w)).length;
  const ratio = overlap / childWords.length;

  // Key insight: a subtask that narrows scope is VALID even with 100% word overlap.
  // "Input field for new todo" is a valid subset of
  // "User interface with input field for new todo and button to add todo".
  // Only flag as vague if the child is roughly the SAME size as the parent
  // (i.e. not narrowing scope) AND has very high overlap.
  const childIsNarrower = childWords.length < parentWords.length * 0.75;

  if (childIsNarrower) {
    // Child is significantly shorter — it's narrowing, not circular.
    // Only reject if literally identical after normalization (already checked above).
    return { isVague: false, reason: "" };
  }

  // Child is similar length to parent — check for circular rephrasing
  if (ratio > 0.8) {
    return {
      isVague: true,
      reason: `${Math.round(ratio * 100)}% keyword overlap with parent task (not narrowing scope)`,
    };
  }

  return { isVague: false, reason: "" };
}
