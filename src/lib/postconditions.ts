/**
 * Postcondition checks derived from a feedback instruction.
 *
 * The user's natural-language instruction is parsed into a small set of
 * deterministic checks against the resulting file. When a check fails, the
 * retry prompt carries the exact evidence (line numbers, surrounding text)
 * back to the model instead of just "try again".
 */

export interface Postcondition {
  kind: "absent" | "present";
  /** Lowercased substring or regex source to test against the file. */
  needle: string;
  /** Human-readable label for retry prompts and logs. */
  label: string;
}

export interface PostconditionFailure {
  condition: Postcondition;
  /** First offending line number (1-based), or 0 for present-failures. */
  lineNumber: number;
  /** Excerpt from the file showing the problem. */
  excerpt: string;
  /** Pre-formatted retry hint. */
  message: string;
}

/**
 * Parse an instruction into postconditions.
 * Returns [] if no usable verb-pattern is detected.
 */
export function derivePostconditions(instruction: string): Postcondition[] {
  const out: Postcondition[] = [];
  const lower = instruction.toLowerCase().trim();

  // ── rename X to Y ──
  // Matches: "rename X to Y", "rename 'X' to 'Y'", "change X to Y"
  const renameMatch = lower.match(
    /(?:rename|change)\s+(?:the\s+)?["']?([\w\s-]{2,40}?)["']?\s+to\s+["']?([\w\s-]{2,40}?)["']?\s*[.!?]?$/,
  );
  if (renameMatch) {
    const from = renameMatch[1].trim();
    const to = renameMatch[2].trim();
    if (from && to && from !== to) {
      out.push({ kind: "absent", needle: from, label: `"${from}"` });
      out.push({ kind: "present", needle: to, label: `"${to}"` });
      return out;
    }
  }

  // ── replace X with Y ──
  const replaceMatch = lower.match(
    /replace\s+(?:the\s+)?["']?([\w\s-]{2,40}?)["']?\s+with\s+["']?([\w\s-]{2,40}?)["']?\s*[.!?]?$/,
  );
  if (replaceMatch) {
    const from = replaceMatch[1].trim();
    const to = replaceMatch[2].trim();
    if (from && to && from !== to) {
      out.push({ kind: "absent", needle: from, label: `"${from}"` });
      out.push({ kind: "present", needle: to, label: `"${to}"` });
      return out;
    }
  }

  // ── remove / delete X ──
  const removeMatch = lower.match(
    /(?:remove|delete|drop|get rid of|take out)\s+(?:the\s+)?(.{2,60}?)\s*[.!?]?$/,
  );
  if (removeMatch) {
    const target = removeMatch[1]
      .replace(/\b(screen|page|section|component|button|form|field)\b/g, "")
      .trim();
    if (target.length >= 3) {
      out.push({
        kind: "absent",
        needle: target,
        label: `"${target}"`,
      });
      // Also assert the un-stripped phrase if it had a UI noun (helps catch
      // "Signup" when instruction said "signup screen").
      const fullTarget = removeMatch[1].trim();
      if (fullTarget !== target && fullTarget.length >= 3) {
        out.push({
          kind: "absent",
          needle: fullTarget,
          label: `"${fullTarget}"`,
        });
      }
    }
  }

  // ── add X / introduce X ──
  const addMatch = lower.match(
    /(?:add|introduce|include)\s+(?:an?\s+|the\s+)?(.{2,60}?)\s*[.!?]?$/,
  );
  if (addMatch) {
    const target = addMatch[1]
      .replace(/\b(button|field|input|component|section|page)\b/g, "")
      .trim();
    if (target.length >= 3) {
      out.push({ kind: "present", needle: target, label: `"${target}"` });
    }
  }

  return out;
}

/**
 * Replace comment contents with spaces so substring searches don't trigger
 * inside `// foo`, `/* foo *\/`, `<!-- foo -->`, or `# foo` (Python/shell).
 * Line numbers and offsets are preserved.
 */
function maskComments(content: string, filePath?: string): string {
  const ext = (filePath?.split(".").pop() ?? "").toLowerCase();
  const usesHash = [
    "py",
    "rb",
    "sh",
    "bash",
    "zsh",
    "yaml",
    "yml",
    "toml",
  ].includes(ext);
  const usesHtml = [
    "html",
    "htm",
    "xml",
    "svg",
    "vue",
    "md",
    "markdown",
  ].includes(ext);
  const usesSlash = !usesHash; // C-family covers most code files

  const out: string[] = [];
  let i = 0;
  let inBlock = false;
  let inHtmlComment = false;
  let inString: '"' | "'" | "`" | null = null;
  while (i < content.length) {
    const c = content[i];
    const next = content[i + 1];

    if (inBlock) {
      if (c === "*" && next === "/") {
        out.push("  ");
        i += 2;
        inBlock = false;
      } else {
        out.push(c === "\n" ? "\n" : " ");
        i++;
      }
      continue;
    }
    if (inHtmlComment) {
      if (c === "-" && next === "-" && content[i + 2] === ">") {
        out.push("   ");
        i += 3;
        inHtmlComment = false;
      } else {
        out.push(c === "\n" ? "\n" : " ");
        i++;
      }
      continue;
    }
    if (inString) {
      out.push(c);
      if (c === "\\" && next) {
        out.push(next);
        i += 2;
        continue;
      }
      if (c === inString) inString = null;
      i++;
      continue;
    }
    // Not in any masked region.
    if (usesSlash && c === "/" && next === "/") {
      // Line comment until newline.
      while (i < content.length && content[i] !== "\n") {
        out.push(" ");
        i++;
      }
      continue;
    }
    if (usesSlash && c === "/" && next === "*") {
      out.push("  ");
      i += 2;
      inBlock = true;
      continue;
    }
    if (usesHash && c === "#") {
      while (i < content.length && content[i] !== "\n") {
        out.push(" ");
        i++;
      }
      continue;
    }
    if (
      usesHtml &&
      c === "<" &&
      next === "!" &&
      content.slice(i, i + 4) === "<!--"
    ) {
      out.push("    ");
      i += 4;
      inHtmlComment = true;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      inString = c as '"' | "'" | "`";
      out.push(c);
      i++;
      continue;
    }
    out.push(c);
    i++;
  }
  return out.join("");
}

/**
 * Run all postconditions against the file content.
 * Returns failures only (empty array == all good).
 *
 * `filePath` (optional) selects the comment dialect used for masking.
 */
export function checkPostconditions(
  content: string,
  conditions: Postcondition[],
  filePath?: string,
): PostconditionFailure[] {
  const failures: PostconditionFailure[] = [];
  const masked = maskComments(content, filePath);
  const lower = masked.toLowerCase();
  const lines = content.split("\n");

  for (const cond of conditions) {
    const needle = cond.needle.toLowerCase();
    const idx = lower.indexOf(needle);

    if (cond.kind === "absent" && idx >= 0) {
      // Find the line number.
      let charsSoFar = 0;
      let lineNo = 1;
      for (let i = 0; i < lines.length; i++) {
        if (charsSoFar + lines[i].length >= idx) {
          lineNo = i + 1;
          break;
        }
        charsSoFar += lines[i].length + 1; // +1 for newline
      }
      const excerpt = (lines[lineNo - 1] ?? "").trim().slice(0, 160);
      failures.push({
        condition: cond,
        lineNumber: lineNo,
        excerpt,
        message: `The text ${cond.label} still appears on line ${lineNo}: \`${excerpt}\``,
      });
    } else if (cond.kind === "present" && idx === -1) {
      failures.push({
        condition: cond,
        lineNumber: 0,
        excerpt: "",
        message: `The text ${cond.label} is not present anywhere in the file. Add it.`,
      });
    }
  }

  return failures;
}

/**
 * Format failures as a short retry instruction the model can act on.
 */
export function formatFailureMessage(failures: PostconditionFailure[]): string {
  if (failures.length === 0) return "";
  if (failures.length === 1) return failures[0].message;
  return failures.map((f, i) => `${i + 1}. ${f.message}`).join("\n");
}
