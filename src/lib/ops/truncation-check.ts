/**
 * Truncation detector for LLM-generated source files.
 *
 * Small models often run out of generation budget mid-function. The visible
 * symptom is files that end with a partial statement: `sto`, `handleFoo = (`,
 * `const x =`, etc. These files compile in isolation but fail at runtime or
 * during inlined preview rendering.
 *
 * Heuristics (any one fires → truncated):
 *   1. Unbalanced braces / parens / brackets at EOF
 *   2. Final non-blank line ends with an opening bracket or trailing operator
 *      that cannot legally end a file
 *   3. Final non-blank line is a fragment (alphanumeric/identifier with no
 *      statement terminator and no closing brace context)
 *   4. File is far below the size expected for its declared requirements
 *      (caller passes minExpectedLines)
 *
 * Returns a list of reasons (empty = file looks complete).
 * Designed for TS/TSX/JS/JSX. Non-code files: returns [].
 */

const TRAILING_OPERATORS = new Set([
  "=",
  "+",
  "-",
  "*",
  "/",
  "%",
  ":",
  ",",
  "&&",
  "||",
  "??",
  "?",
  "=>",
  "<",
  ">",
  "(",
  "[",
  "{",
]);

export interface TruncationCheckOptions {
  /** If set, files shorter than this trigger a "too short" reason. */
  minExpectedLines?: number;
}

export function detectTruncation(
  filePath: string,
  content: string,
  opts: TruncationCheckOptions = {},
): string[] {
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  if (!["ts", "tsx", "jsx", "js", "py", "html", "css"].includes(ext)) {
    return [];
  }

  const reasons: string[] = [];

  // ── 1. Bracket balance ──
  // Strip strings, template literals, and comments before counting to avoid
  // false positives on braces inside string content.
  const stripped = stripStringsAndComments(content);
  let parens = 0;
  let braces = 0;
  let brackets = 0;
  for (const ch of stripped) {
    if (ch === "(") parens++;
    else if (ch === ")") parens--;
    else if (ch === "{") braces++;
    else if (ch === "}") braces--;
    else if (ch === "[") brackets++;
    else if (ch === "]") brackets--;
  }
  if (parens > 0) reasons.push(`${parens} unclosed parenthesis at end of file`);
  if (braces > 0) reasons.push(`${braces} unclosed brace at end of file`);
  if (brackets > 0) reasons.push(`${brackets} unclosed bracket at end of file`);

  // ── 2. Final non-blank line analysis ──
  const lines = content.split("\n");
  let lastIdx = lines.length - 1;
  while (lastIdx >= 0 && lines[lastIdx].trim() === "") lastIdx--;
  if (lastIdx >= 0) {
    const lastLine = lines[lastIdx].trim();

    // Trailing operator at the very end of the file is almost always a cutoff
    for (const op of TRAILING_OPERATORS) {
      if (lastLine.endsWith(op)) {
        // Allow `}` (block close) and standard line endings — only flag if
        // the file ENDS with an open construct.
        if (op === "{" || op === "(" || op === "[") {
          reasons.push(`file ends with open '${op}' — likely truncated`);
        } else {
          reasons.push(
            `file ends with trailing operator '${op}' — likely truncated`,
          );
        }
        break;
      }
    }

    // Fragment detection: a line that looks like a partial identifier or
    // keyword with no terminator. Examples we want to catch: `sto`, `const x`,
    // `handleSomething = (` (already caught above), `function foo`.
    //
    // Heuristic: last line is short (< 25 chars), is pure identifier/keyword
    // material with no `;`, `}`, `>`, `)`, and is not a comment.
    if (
      lastLine.length > 0 &&
      lastLine.length < 25 &&
      /^[a-zA-Z_][\w.\-]*$/.test(lastLine) &&
      !lastLine.startsWith("//") &&
      !lastLine.startsWith("*")
    ) {
      reasons.push(
        `file ends with bare identifier '${lastLine}' — likely truncated mid-statement`,
      );
    }
  }

  // ── 3. Size sanity ──
  if (
    opts.minExpectedLines &&
    content.split("\n").length < opts.minExpectedLines
  ) {
    reasons.push(
      `file is ${content.split("\n").length} lines (expected at least ${opts.minExpectedLines})`,
    );
  }

  return reasons;
}

/**
 * Strip string literals, template literals, and comments from source so
 * that bracket counting only sees real code brackets.
 *
 * Best-effort and forgiving — on any ambiguity returns the original char.
 */
function stripStringsAndComments(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;

  while (i < n) {
    const ch = src[i];
    const next = src[i + 1];

    // Line comment
    if (ch === "/" && next === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    // Block comment
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    // Single-quoted string
    if (ch === "'") {
      i++;
      while (i < n && src[i] !== "'") {
        if (src[i] === "\\") i += 2;
        else i++;
      }
      i++;
      continue;
    }
    // Double-quoted string
    if (ch === '"') {
      i++;
      while (i < n && src[i] !== '"') {
        if (src[i] === "\\") i += 2;
        else i++;
      }
      i++;
      continue;
    }
    // Template literal — handle ${} nesting
    if (ch === "`") {
      i++;
      while (i < n && src[i] !== "`") {
        if (src[i] === "\\") {
          i += 2;
          continue;
        }
        if (src[i] === "$" && src[i + 1] === "{") {
          // Preserve the contents of ${ ... } since they may contain
          // real brackets that count toward balance
          i += 2;
          let depth = 1;
          while (i < n && depth > 0) {
            if (src[i] === "{") depth++;
            else if (src[i] === "}") depth--;
            if (depth > 0) {
              out += src[i];
              i++;
            }
          }
          i++; // skip closing }
          continue;
        }
        i++;
      }
      i++;
      continue;
    }

    out += ch;
    i++;
  }

  return out;
}
