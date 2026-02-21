/**
 * Programmatic code validation — replaces LLM-based QA.
 *
 * Checks for objective issues only:
 *   - Empty output
 *   - Unbalanced HTML tags
 *   - Unbalanced braces / brackets / parentheses
 *   - Unterminated strings
 *
 * Returns { valid: true } or { valid: false, reason: "..." }
 */

export interface ValidationResult {
  valid: boolean;
  reason?: string;
}

/**
 * Auto-repair common truncation issues.
 * Closes unclosed braces/brackets/parens at end of file.
 * Closes unclosed HTML tags.
 * Returns the repaired string (or original if no repair needed).
 */
export function autoRepairOutput(
  output: string,
  filePath?: string,
): { repaired: string; fixes: string[] } {
  const ext = filePath ? filePath.split(".").pop()?.toLowerCase() || "" : "";
  let code = output;
  const fixes: string[] = [];

  // Auto-close braces/brackets/parens for JS/CSS files
  if (
    ext === "js" ||
    ext === "ts" ||
    ext === "css" ||
    ext === "jsx" ||
    ext === "tsx"
  ) {
    // Strip strings and comments for counting
    const stripped = code
      .replace(/\/\/.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/"(?:[^"\\]|\\.)*"/g, '""')
      .replace(/'(?:[^'\\]|\\.)*'/g, "''")
      .replace(/`(?:[^`\\]|\\.)*`/g, "``");

    const pairs: [string, string, string][] = [
      ["{", "}", "brace"],
      ["(", ")", "paren"],
      ["[", "]", "bracket"],
    ];

    for (const [open, close, name] of pairs) {
      let count = 0;
      for (const ch of stripped) {
        if (ch === open) count++;
        if (ch === close) count--;
      }
      if (count > 0) {
        // Append missing closing characters
        code = code.trimEnd() + "\n" + close.repeat(count) + "\n";
        fixes.push(`Auto-closed ${count} unclosed ${name}(s)`);
      }
    }
  }

  // Auto-close HTML tags
  if (ext === "html" || ext === "htm") {
    // Fix truncated charset (UTF- → UTF-8)
    if (
      /charset=["']?UTF-["']?/i.test(code) &&
      !/charset=["']?UTF-8/i.test(code)
    ) {
      code = code.replace(/charset=["']?UTF-["']?/gi, 'charset="UTF-8"');
      fixes.push("Fixed truncated charset to UTF-8");
    }

    // Move <script src="script.js"> to just before </body> if it appears too early
    // (e.g. at top of <body> before content — causes DOM bindings to fail)
    const scriptTagPattern =
      /\s*<script\s+src=["']script\.js["']\s*><\/script>\s*/i;
    const bodyCloseIdx = code.lastIndexOf("</body>");
    if (bodyCloseIdx !== -1) {
      const scriptMatch = code.match(scriptTagPattern);
      if (scriptMatch) {
        const scriptIdx = code.indexOf(scriptMatch[0]);
        // Only fix if the script tag is in the first half of the body
        // (i.e. before most content) — not if it's already at the end
        const bodyOpenIdx = code.indexOf("<body");
        const bodyContentLen = bodyCloseIdx - (bodyOpenIdx || 0);
        if (scriptIdx < bodyOpenIdx + bodyContentLen * 0.4) {
          code = code.replace(scriptTagPattern, "\n");
          code = code.replace(
            /<\/body>/i,
            '  <script src="script.js"></script>\n</body>',
          );
          fixes.push('Moved <script src="script.js"> to before </body>');
        }
      }
    }

    // Fix malformed closing tags like </">, </"> , </ >, etc.
    code = code.replace(/<\/\s*["'>]+\s*>/g, "");
    // Fix self-closing tags that shouldn't be: <form /> → <form>
    code = code.replace(
      /<(form|div|ul|ol|main|section|nav|header|footer|article)\s*\/>/gi,
      "<$1>",
    );
    // Remove any content after </html>
    const htmlCloseIdx = code.lastIndexOf("</html>");
    if (htmlCloseIdx !== -1) {
      const afterHtml = code.slice(htmlCloseIdx + 7).trim();
      if (afterHtml.length > 0) {
        code = code.slice(0, htmlCloseIdx + 7) + "\n";
        fixes.push("Removed content after </html>");
      }
    }

    const blockTags = [
      "html",
      "head",
      "body",
      "div",
      "section",
      "form",
      "table",
      "ul",
      "ol",
      "nav",
      "header",
      "footer",
      "main",
      "script",
      "style",
    ];
    const cleanedForCount = code.replace(/<!--[\s\S]*?-->/g, "");

    for (const tag of blockTags) {
      const openCount = (
        cleanedForCount.match(new RegExp(`<${tag}[\\s>]`, "gi")) || []
      ).length;
      const closeCount = (
        cleanedForCount.match(new RegExp(`</${tag}\\s*>`, "gi")) || []
      ).length;
      const missing = openCount - closeCount;
      if (missing > 0) {
        for (let i = 0; i < missing; i++) {
          code = code.trimEnd() + `\n</${tag}>`;
        }
        fixes.push(`Auto-closed ${missing} unclosed <${tag}> tag(s)`);
      }
    }
  }

  // Auto-wrap unguarded top-level DOM bindings in JS
  if (ext === "js") {
    // Detect top-level getElementById/querySelector calls NOT inside a function or DOMContentLoaded
    // Pattern: lines at indent 0 that do getElementById/addEventListener outside any function body
    const hasTopLevelDomBinding = hasUnguardedTopLevelDomBindings(code);
    if (hasTopLevelDomBinding && !code.includes("DOMContentLoaded")) {
      // Wrap the entire file in DOMContentLoaded
      code = `document.addEventListener("DOMContentLoaded", function() {\n${code}\n});\n`;
      fixes.push("Wrapped top-level DOM bindings in DOMContentLoaded listener");
    }
  }

  return { repaired: code, fixes };
}

/**
 * Check if JS has top-level (depth=0) DOM query + addEventListener calls
 * that are NOT inside a function body or DOMContentLoaded guard.
 */
function hasUnguardedTopLevelDomBindings(source: string): boolean {
  const lines = source.split("\n");
  let depth = 0;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, "");
    const trimmed = line.trim();

    if (depth === 0) {
      // Look for: const x = document.getElementById(...); if (x) x.addEventListener(...)
      if (
        /\bdocument\.getElementById\b/.test(trimmed) &&
        !/^\s*function\b/.test(trimmed)
      ) {
        // Check if this line or the next few lines have addEventListener
        if (
          /\.addEventListener\s*\(/.test(trimmed) ||
          /\.addEventListener\s*\(/.test(source)
        ) {
          return true;
        }
      }
      // Direct: element.addEventListener at top-level
      if (
        /^(?:const|let|var|if)\b/.test(trimmed) &&
        /\.addEventListener\s*\(/.test(trimmed)
      ) {
        return true;
      }
    }

    const openCount = (line.match(/\{/g) || []).length;
    const closeCount = (line.match(/\}/g) || []).length;
    depth += openCount - closeCount;
    if (depth < 0) depth = 0;
  }

  return false;
}

export function validateOutput(
  output: string,
  filePath?: string,
  options?: { allowScaffold?: boolean },
): ValidationResult {
  if (!output || output.trim().length === 0) {
    return { valid: false, reason: "Output is empty" };
  }

  // Very short output — probably truncated or garbage
  if (output.trim().length < 5) {
    return { valid: false, reason: "Output too short (< 5 chars)" };
  }

  // Detect prompt template echo — model parroted back the example placeholder
  const promptEchoPatterns = [
    /^\s*\(complete\s+\w[\w\s]*\)\s*$/i,
    /^\s*\.\.\. your [\w\s]+ here \.\.\.\s*$/i,
    /^\s*YOUR_CODE_HERE\s*$/i,
    /^\s*\(your [\w\s]+ here\)\s*$/i,
  ];
  if (promptEchoPatterns.some((p) => p.test(output.trim()))) {
    return {
      valid: false,
      reason:
        "Output is a placeholder echo from the prompt template, not real code. The model repeated the example instead of writing actual code.",
    };
  }

  // Detect placeholder / stub output
  const lower = output.trim().toLowerCase();
  const placeholders = [
    "// your code here",
    "/* your code here */",
    "// todo",
    "// add your",
    "// write your",
    "// implement",
    "<!-- your code here -->",
    "// placeholder",
    "/* placeholder */",
    "// ...",
    "/* ... */",
  ];
  // Check if the ENTIRE output is a placeholder
  if (placeholders.some((p) => lower === p || lower.startsWith(p + "\n"))) {
    return {
      valid: false,
      reason: "Output is placeholder code, not real implementation",
    };
  }
  // Also check if placeholder appears prominently (more than 20% of non-empty lines)
  const nonEmptyLines = output.split("\n").filter((l) => l.trim().length > 0);
  const placeholderLines = nonEmptyLines.filter((l) => {
    const ll = l.trim().toLowerCase();
    return placeholders.some(
      (p) =>
        ll === p ||
        ll.includes("your code here") ||
        ll.includes("todo: implement"),
    );
  });
  if (
    nonEmptyLines.length > 0 &&
    placeholderLines.length / nonEmptyLines.length > 0.2
  ) {
    return {
      valid: false,
      reason:
        "Output contains too many placeholder comments instead of real code",
    };
  }

  const ext = filePath ? filePath.split(".").pop()?.toLowerCase() || "" : "";

  // Minimum content requirements per file type
  if (ext === "html" || ext === "htm") {
    const trimmed = output.trim().toLowerCase();
    if (
      !trimmed.includes("<!doctype") &&
      !trimmed.includes("<html") &&
      !trimmed.includes("<head") &&
      !trimmed.includes("<body") &&
      !trimmed.includes("<div") &&
      !trimmed.includes("<main")
    ) {
      return {
        valid: false,
        reason:
          "HTML file has no HTML tags. Expected at least <!DOCTYPE html>, <html>, or structural tags.",
      };
    }
    if (output.trim().length < 50) {
      return {
        valid: false,
        reason:
          "HTML file is too short (< 50 chars). Expected a complete HTML document.",
      };
    }
  }

  if (ext === "js" || ext === "ts") {
    if (output.trim().length < 30) {
      return {
        valid: false,
        reason:
          "JavaScript file is too short (< 30 chars). Expected real implementation code.",
      };
    }
  }

  if (ext === "css") {
    if (output.trim().length < 30) {
      return {
        valid: false,
        reason: "CSS file is too short (< 30 chars). Expected real CSS rules.",
      };
    }
  }

  if (looksLikeInstructionDump(output)) {
    return {
      valid: false,
      reason:
        "Output appears to contain prompt/instruction text instead of actual file content.",
    };
  }

  // Content-type validation: catch wrong content type in file
  if (ext === "js" || ext === "ts" || ext === "jsx" || ext === "tsx") {
    const trimmed = output.trim();
    if (
      trimmed.startsWith("<!DOCTYPE") ||
      trimmed.startsWith("<html") ||
      trimmed.startsWith("<head") ||
      trimmed.startsWith("<body")
    ) {
      return {
        valid: false,
        reason:
          "JavaScript file contains HTML markup instead of JavaScript code. Write only JS code.",
      };
    }
    // Check for HTML tags anywhere in the JS file (not in strings/comments)
    const htmlTagPattern =
      /^\s*<(?:div|span|button|input|form|table|ul|ol|li|p|h[1-6]|a|img|nav|header|footer|section|main|!DOCTYPE|html|head|body)[\s>]/im;
    if (htmlTagPattern.test(trimmed)) {
      return {
        valid: false,
        reason:
          "JavaScript file contains HTML tags. Write only JavaScript code, no HTML.",
      };
    }
    // Check if output is mostly HTML tags (more than 30% of lines start with <)
    const lines = trimmed.split("\n").filter((l) => l.trim().length > 0);
    const htmlLines = lines.filter((l) => /^\s*<[a-zA-Z!\/]/.test(l));
    if (lines.length > 3 && htmlLines.length / lines.length > 0.3) {
      return {
        valid: false,
        reason:
          "JavaScript file appears to contain HTML markup instead of JavaScript code.",
      };
    }
    // Check JS file is not just comments
    const jsStripped = trimmed
      .replace(/\/\/.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .trim();
    if (jsStripped.length < 10) {
      return {
        valid: false,
        reason: "JavaScript file contains only comments, no actual code",
      };
    }
    // Scaffold detection: reject JS that has functions but no real logic
    if (!options?.allowScaffold) {
      const scaffoldResult = detectJsScaffold(trimmed);
      if (!scaffoldResult.valid) return scaffoldResult;
    }
    // Check for duplicate TOP-LEVEL declarations only.
    // Block-scoped duplicates inside different functions are valid and should not fail.
    const declarations = collectTopLevelJsDeclarations(trimmed);
    const duplicates = Object.entries(declarations).filter(
      ([, count]) => count > 1,
    );
    if (duplicates.length > 0) {
      const names = duplicates
        .map(([name, count]) => `${name} (${count}x)`)
        .join(", ");
      return {
        valid: false,
        reason: `JavaScript file has duplicate declarations: ${names}. Each function/variable must be declared only once.`,
      };
    }
  }

  if (ext === "css") {
    const trimmed = output.trim();
    if (
      trimmed.startsWith("<!DOCTYPE") ||
      trimmed.startsWith("<html") ||
      trimmed.startsWith("<head")
    ) {
      return {
        valid: false,
        reason:
          "CSS file contains HTML markup instead of CSS rules. Write only CSS.",
      };
    }
    // Check CSS file has at least one real rule (selector { property: value })
    const strippedComments = trimmed
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "")
      .trim();
    if (strippedComments.length < 5) {
      return {
        valid: false,
        reason: "CSS file contains only comments, no actual CSS rules",
      };
    }
    // Check for at least one CSS rule pattern: selector { ... }
    if (!/{[^}]*}/.test(strippedComments)) {
      return {
        valid: false,
        reason:
          "CSS file has no CSS rules (expected selector { property: value } patterns)",
      };
    }
    // Check for HTML tags inside CSS (common model error)
    const htmlInCSS =
      /^\s*<(?:div|span|button|input|form|table|ul|ol|li|p|h[1-6]|a|img|!DOCTYPE|html|head|body)[\s>]/im;
    if (htmlInCSS.test(trimmed)) {
      return {
        valid: false,
        reason: "CSS file contains HTML tags. Write only CSS rules.",
      };
    }
    // Check for duplicate CSS rule blocks (only class/id selectors, not elements/pseudo)
    const rulePattern = /([.#][\w-]+)\s*[{,]/g;
    const cssDecls: Record<string, number> = {};
    let cssMatch;
    while ((cssMatch = rulePattern.exec(strippedComments)) !== null) {
      const sel = cssMatch[1].toLowerCase();
      cssDecls[sel] = (cssDecls[sel] || 0) + 1;
    }
    // Only flag class/id selectors that appear > 4 times (element selectors like
    // button, li, label naturally repeat in CSS and are no longer checked)
    const cssDupes = Object.entries(cssDecls).filter(([, c]) => c > 4);
    if (cssDupes.length > 0) {
      const names = cssDupes.map(([s, c]) => `${s} (${c}x)`).join(", ");
      return {
        valid: false,
        reason: `CSS has excessively duplicated selectors: ${names}`,
      };
    }
  }

  // HTML validation
  if (ext === "html" || ext === "htm") {
    const htmlResult = validateHTML(output);
    if (!htmlResult.valid) return htmlResult;
  }

  // CSS scaffold detection: reject CSS that only has base reset rules
  if (ext === "css" && !options?.allowScaffold) {
    const cssScaffoldResult = detectCssScaffold(output);
    if (!cssScaffoldResult.valid) return cssScaffoldResult;
  }

  // CSS validation
  if (ext === "css") {
    const cssResult = validateBraces(output, "CSS");
    if (!cssResult.valid) return cssResult;
  }

  // JS/TS validation
  if (ext === "js" || ext === "ts" || ext === "jsx" || ext === "tsx") {
    const jsResult = validateBraces(output, "JavaScript");
    if (!jsResult.valid) return jsResult;
  }

  return { valid: true };
}

function collectTopLevelJsDeclarations(source: string): Record<string, number> {
  const counts: Record<string, number> = {};
  const lines = source.split("\n");

  let depth = 0;
  let inBlockComment = false;

  const stripStrings = (line: string) =>
    line
      .replace(/`(?:\\.|[^`])*`/g, "``")
      .replace(/"(?:\\.|[^"])*"/g, '""')
      .replace(/'(?:\\.|[^'])*'/g, "''");

  const inc = (name: string) => {
    counts[name] = (counts[name] || 0) + 1;
  };

  for (const rawLine of lines) {
    let line = rawLine;

    if (inBlockComment) {
      const endIdx = line.indexOf("*/");
      if (endIdx === -1) continue;
      line = line.slice(endIdx + 2);
      inBlockComment = false;
    }

    const blockStartIdx = line.indexOf("/*");
    if (blockStartIdx !== -1) {
      const endIdx = line.indexOf("*/", blockStartIdx + 2);
      if (endIdx === -1) {
        line = line.slice(0, blockStartIdx);
        inBlockComment = true;
      } else {
        line = line.slice(0, blockStartIdx) + line.slice(endIdx + 2);
      }
    }

    line = line.replace(/\/\/.*$/, "");
    const safe = stripStrings(line);
    const trimmed = safe.trim();

    if (depth === 0 && trimmed.length > 0) {
      const fn = trimmed.match(/^function\s+([A-Za-z_$][\w$]*)\s*\(/);
      if (fn) inc(fn[1]);

      const varDecl = trimmed.match(
        /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\b/,
      );
      if (varDecl) inc(varDecl[1]);
    }

    const openCount = (safe.match(/\{/g) || []).length;
    const closeCount = (safe.match(/\}/g) || []).length;
    depth += openCount - closeCount;
    if (depth < 0) depth = 0;
  }

  return counts;
}

/**
 * Check that major HTML tags are balanced.
 * Only checks block-level tags — not self-closing ones.
 */
function validateHTML(html: string): ValidationResult {
  // Strip comments and script/style content
  const stripped = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "");

  const blockTags = [
    "html",
    "head",
    "body",
    "div",
    "section",
    "form",
    "table",
    "ul",
    "ol",
    "nav",
    "header",
    "footer",
    "main",
    "article",
    "aside",
  ];

  for (const tag of blockTags) {
    const openCount = (stripped.match(new RegExp(`<${tag}[\\s>]`, "gi")) || [])
      .length;
    const closeCount = (stripped.match(new RegExp(`</${tag}\\s*>`, "gi")) || [])
      .length;
    if (openCount > 0 && closeCount === 0) {
      return {
        valid: false,
        reason: `Unclosed <${tag}> tag (${openCount} opened, 0 closed)`,
      };
    }
    if (openCount > 0 && Math.abs(openCount - closeCount) > 1) {
      return {
        valid: false,
        reason: `Mismatched <${tag}> tags (${openCount} opened, ${closeCount} closed)`,
      };
    }
  }

  return { valid: true };
}

/**
 * Check that braces, brackets, and parentheses are balanced.
 */
function validateBraces(code: string, language: string): ValidationResult {
  // Strip string literals and comments to avoid false positives
  const stripped = code
    .replace(/\/\/.*$/gm, "") // line comments
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
    .replace(/"(?:[^"\\]|\\.)*"/g, '""') // double-quoted strings
    .replace(/'(?:[^'\\]|\\.)*'/g, "''") // single-quoted strings
    .replace(/`(?:[^`\\]|\\.)*`/g, "``"); // template literals

  const pairs: [string, string, string][] = [
    ["{", "}", "braces"],
    ["(", ")", "parentheses"],
    ["[", "]", "brackets"],
  ];

  for (const [open, close, name] of pairs) {
    let count = 0;
    for (const ch of stripped) {
      if (ch === open) count++;
      if (ch === close) count--;
      if (count < 0) {
        return {
          valid: false,
          reason: `${language}: extra closing ${name}`,
        };
      }
    }
    if (count > 0) {
      return {
        valid: false,
        reason: `${language}: ${count} unclosed ${name}`,
      };
    }
  }

  return { valid: true };
}

/**
 * Detect scaffold-only JavaScript: functions exist but contain no real logic.
 * A function body with only comments, `return;`, or `preventDefault()` is scaffold.
 */
function detectJsScaffold(source: string): ValidationResult {
  const fnPattern = /function\s+(\w+)\s*\([^)]*\)\s*\{/g;
  let match;
  let totalFunctions = 0;
  let scaffoldFunctions = 0;

  while ((match = fnPattern.exec(source)) !== null) {
    totalFunctions++;
    const fnName = match[1];
    // Extract body: find the matching closing brace
    let depth = 1;
    let bodyStart = match.index + match[0].length;
    let i = bodyStart;
    while (i < source.length && depth > 0) {
      if (source[i] === "{") depth++;
      if (source[i] === "}") depth--;
      i++;
    }
    const body = source.slice(bodyStart, i - 1).trim();
    // Strip comments and empty lines
    const bodyStripped = body
      .replace(/\/\/.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    // Check if body only contains scaffold-like statements
    const scaffoldPatterns = [
      /^if\s*\(\s*event\s*\)\s*event\.preventDefault\(\)/,
      /^if\s*\(\s*!\s*\w+\s*\)\s*return;?$/,
      /^return;?$/,
      /^var\s+\w+\s*=\s*document\.getElementById\(/,
      /^const\s+\w+\s*=\s*document\.getElementById\(/,
      /^let\s+\w+\s*=\s*document\.getElementById\(/,
    ];

    const isScaffold =
      bodyStripped.length === 0 ||
      bodyStripped.every((line) => scaffoldPatterns.some((p) => p.test(line)));

    if (isScaffold) scaffoldFunctions++;
  }

  // If ALL functions are scaffolds and there are at least 2, it's a scaffold file
  if (totalFunctions >= 2 && scaffoldFunctions === totalFunctions) {
    return {
      valid: false,
      reason:
        "JavaScript file contains only scaffold/empty functions with no real logic. Functions need actual implementation.",
    };
  }

  return { valid: true };
}

/**
 * Detect scaffold-only CSS: only a few base reset rules, no feature-specific styling.
 */
function detectCssScaffold(source: string): ValidationResult {
  const strippedComments = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")
    .trim();

  // Count distinct rule blocks (selector { ... })
  const ruleBlocks = strippedComments.match(/[^{}]+\{[^{}]*\}/g) || [];

  // Base reset selectors that don't count as "real" feature styling
  const baseSelectors = ["body", "*", "#app", "#apptitle", "html"];

  let featureRules = 0;
  for (const block of ruleBlocks) {
    const selectorMatch = block.match(/^\s*([^{]+)/);
    if (!selectorMatch) continue;
    const selector = selectorMatch[1].trim().toLowerCase();
    const isBase = baseSelectors.some(
      (base) => selector === base || selector.startsWith(base + " "),
    );
    if (!isBase) featureRules++;
  }

  if (ruleBlocks.length >= 2 && featureRules === 0) {
    return {
      valid: false,
      reason:
        "CSS file contains only base reset rules (body, #app) with no feature-specific styling. Add styles for forms, buttons, lists, etc.",
    };
  }

  return { valid: true };
}

function looksLikeInstructionDump(output: string): boolean {
  const lower = output.toLowerCase();

  // Detect prompt template echo — the exact placeholder text from system prompts
  const templateEchoes = [
    "(complete html document)",
    "(complete css rules)",
    "(complete javascript code)",
    "(complete code)",
    "... your complete code here ...",
    "... your css rules here ...",
    "... your javascript code here ...",
    "... your complete html here ...",
    "your_code_here",
  ];
  if (
    templateEchoes.some((echo) => lower.trim() === echo || lower.includes(echo))
  ) {
    return true;
  }

  const strongSignals = [
    "write the complete",
    "it must include:",
    "previous attempt failed:",
    "you must respond with",
    "never write placeholder",
    "current script.js draft",
    "current index.html draft",
    "current style.css draft",
    "do not echo back",
    "reply format:",
    "reply exactly:",
  ];

  if (strongSignals.some((signal) => lower.includes(signal))) {
    return true;
  }

  const numberedItems = output.match(/\n\s*\d+\.\s+/g)?.length || 0;
  const imperativeWords = ["create", "implement", "handle", "write", "include"];
  const imperativeHits = imperativeWords.filter((w) =>
    lower.includes(w),
  ).length;

  // Heuristic: prompt-like instruction block tends to contain many numbered steps
  // and imperative verbs.
  return numberedItems >= 4 && imperativeHits >= 3;
}

// ─────────────────────────────────────────────
//  Cross-file consistency validation
// ─────────────────────────────────────────────

export interface ConsistencyIssue {
  file: string;
  severity: "error" | "warning";
  message: string;
}

/**
 * Validate cross-file consistency between HTML, CSS, and JS.
 * Checks that:
 *   - JS getElementById/querySelector targets exist in HTML
 *   - CSS id selectors reference IDs that exist in HTML
 *   - HTML includes the style.css and script.js links
 *   - JS has event listeners if HTML has interactive elements
 *   - CSS has styling if HTML has elements to style
 */
export function validateCrossFileConsistency(
  html: string,
  css: string,
  js: string,
): ConsistencyIssue[] {
  const issues: ConsistencyIssue[] = [];

  if (!html || html.trim().length < 20) return issues;

  // Extract IDs from HTML
  const htmlIds = new Set<string>();
  const idPattern = /\bid=["']([^"']+)["']/gi;
  let m;
  while ((m = idPattern.exec(html)) !== null) {
    htmlIds.add(m[1]);
  }

  // Extract classes from HTML
  const htmlClasses = new Set<string>();
  const classPattern = /\bclass=["']([^"']+)["']/gi;
  while ((m = classPattern.exec(html)) !== null) {
    for (const cls of m[1].split(/\s+/)) {
      if (cls) htmlClasses.add(cls);
    }
  }

  // Check JS → HTML references
  if (js && js.trim().length > 10) {
    const jsIdRefs = new Set<string>();

    // getElementById('x')
    const getByIdPattern = /getElementById\s*\(\s*["']([^"']+)["']\s*\)/g;
    while ((m = getByIdPattern.exec(js)) !== null) {
      jsIdRefs.add(m[1]);
    }

    // querySelector('#x')
    const qsIdPattern =
      /querySelector(?:All)?\s*\(\s*["']#([^"'\s.]+)["']\s*\)/g;
    while ((m = qsIdPattern.exec(js)) !== null) {
      jsIdRefs.add(m[1]);
    }

    for (const id of jsIdRefs) {
      if (!htmlIds.has(id)) {
        issues.push({
          file: "script.js",
          severity: "error",
          message: `JS references element #${id} but no element with id="${id}" exists in HTML. Either add id="${id}" to an HTML element or fix the JS selector.`,
        });
      }
    }

    // Check JS queries CSS classes that don't exist
    const jsClassRefs = new Set<string>();
    const qsClassPattern =
      /querySelector(?:All)?\s*\(\s*["']\.([^"'\s#.]+)["']\s*\)/g;
    while ((m = qsClassPattern.exec(js)) !== null) {
      jsClassRefs.add(m[1]);
    }
    const getByClassPattern =
      /getElementsByClassName\s*\(\s*["']([^"']+)["']\s*\)/g;
    while ((m = getByClassPattern.exec(js)) !== null) {
      jsClassRefs.add(m[1]);
    }

    for (const cls of jsClassRefs) {
      if (!htmlClasses.has(cls)) {
        issues.push({
          file: "script.js",
          severity: "warning",
          message: `JS references class .${cls} but no element with class="${cls}" exists in HTML`,
        });
      }
    }

    // Check JS has event listeners if HTML has interactive elements
    const hasButtons = html.includes("<button");
    const hasInputs = html.includes("<input");
    const hasForms = html.includes("<form");
    if (hasButtons || hasInputs || hasForms) {
      if (!js.includes("addEventListener") && !js.includes("onclick")) {
        issues.push({
          file: "script.js",
          severity: "warning",
          message:
            "HTML has interactive elements (buttons/inputs/forms) but JS has no event listeners",
        });
      }
    }
  }

  // Check CSS → HTML references (IDs only, classes are too common for false positives)
  if (css && css.trim().length > 10) {
    const cssIdRefs = new Set<string>();
    const cssIdPattern = /#([\w-]+)\s*[{,:\s]/g;
    while ((m = cssIdPattern.exec(css)) !== null) {
      cssIdRefs.add(m[1]);
    }

    for (const id of cssIdRefs) {
      if (!htmlIds.has(id) && id !== "app") {
        issues.push({
          file: "style.css",
          severity: "warning",
          message: `CSS targets #${id} but no element with id="${id}" exists in HTML`,
        });
      }
    }
  }

  // Check HTML has required asset links
  if (
    !html.includes('href="style.css"') &&
    !html.includes("href='style.css'")
  ) {
    issues.push({
      file: "index.html",
      severity: "error",
      message:
        'HTML is missing <link rel="stylesheet" href="style.css">. Add it inside <head>.',
    });
  }
  if (!html.includes('src="script.js"') && !html.includes("src='script.js'")) {
    issues.push({
      file: "index.html",
      severity: "error",
      message:
        'HTML is missing <script src="script.js"></script>. Add it before </body>.',
    });
  }

  // Check HTML has interactive elements when JS has logic
  if (js && js.trim().length > 50) {
    if (htmlIds.size === 0 && htmlClasses.size === 0) {
      issues.push({
        file: "index.html",
        severity: "warning",
        message:
          "JS file has logic but HTML has no IDs or classes for JS to target",
      });
    }
  }

  return issues;
}
