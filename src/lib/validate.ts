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

  // Strip >> TTM protocol markers from line starts (model leaking protocol format into code)
  // e.g. ">>  import React" → "import React"
  if (/^>>[ \t]/m.test(code)) {
    code = code.replace(/^>>[ \t]?/gm, "");
    fixes.push("Stripped >> TTM line prefixes from code");
  }

  // Strip markdown code fences (```tsx, ```javascript, ``` etc.)
  if (/^```\w*\s*$/m.test(code)) {
    code = code
      .replace(/^```\w*\s*$/gm, "") // opening fences
      .replace(/^```\s*$/gm, "") // closing fences
      .trim();
    fixes.push("Stripped markdown code fences");
  }

  // Strip trailing English text after code (model dumping explanations)
  // For TSX/JSX/TS/JS: find the last top-level closing brace and remove everything after it
  if (ext === "tsx" || ext === "jsx" || ext === "ts" || ext === "js") {
    const lines = code.split("\n");
    let lastTopLevelBrace = -1;
    let depth = 0;
    for (let i = 0; i < lines.length; i++) {
      for (const ch of lines[i]) {
        if (ch === "{") depth++;
        if (ch === "}") depth--;
      }
      if (depth === 0 && lines[i].trim() === "}") {
        lastTopLevelBrace = i;
      }
    }
    if (lastTopLevelBrace >= 0 && lastTopLevelBrace < lines.length - 1) {
      // Check if lines after the last top-level brace are English text (not code)
      const trailing = lines
        .slice(lastTopLevelBrace + 1)
        .join("\n")
        .trim();
      if (trailing.length > 0) {
        // If trailing content has no code constructs (import, export, const, function, {, }, ;)
        // it's likely model explanation text — strip it
        const hasCodeSyntax =
          /^(import |export |const |let |var |function |\/\/|\/\*|\{|\}|;|\))/m.test(
            trailing,
          );
        if (!hasCodeSyntax) {
          code = lines.slice(0, lastTopLevelBrace + 1).join("\n");
          fixes.push("Stripped trailing explanation text after code");
        }
      }
    }
  }

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
      } else if (count < 0 && ext === "css") {
        // CSS-specific: strip trailing extra closing braces.
        // The model frequently appends a stray `}` at the end of a CSS file.
        // In CSS (unlike JS/TS) extra closers are almost always at the end and safe to remove.
        let toRemove = -count;
        code = code
          .trimEnd()
          .replace(new RegExp(`(\\${close}\\s*){0,${toRemove}}$`), (m) => {
            const removed = (m.match(new RegExp(`\\${close}`, "g")) || [])
              .length;
            toRemove = removed; // actual count removed
            return "";
          })
          .trimEnd();
        if (toRemove > 0) {
          fixes.push(`Stripped ${toRemove} extra closing ${name}(s)`);
        }
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

  // Auto-wrap unguarded top-level DOM bindings in JS (not TSX — React components don't use DOM directly)
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

  // Reject code where most lines start with >> (TTM markers leaked into output)
  const nonEmptyLinesForCheck = output
    .split("\n")
    .filter((l) => l.trim().length > 0);
  const ttmPrefixedLines = nonEmptyLinesForCheck.filter((l) => /^>>/.test(l));
  if (
    nonEmptyLinesForCheck.length > 3 &&
    ttmPrefixedLines.length / nonEmptyLinesForCheck.length > 0.4
  ) {
    return {
      valid: false,
      reason:
        'Output has TTM protocol ">>" markers on most lines — model is outputting protocol format instead of code. Retry without >> prefixes.',
    };
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
    // Detect JSX/React code injected inside a <script> tag.
    // This happens when the model writes a React component into a plain .html file,
    // putting `import React`, `export default function`, or JSX syntax inside <script>.
    const scriptContentMatch = output.match(
      /<script[^>]*>([\s\S]*?)<\/script>/gi,
    );
    if (scriptContentMatch) {
      for (const block of scriptContentMatch) {
        const inner = block.replace(/<script[^>]*>|<\/script>/gi, "");
        const hasReactImport = /\bimport\s+React\b/.test(inner);
        const hasExportDefault = /\bexport\s+default\b/.test(inner);
        const hasJsxReturn =
          /\breturn\s*\(?\s*<[A-Z]/.test(inner) ||
          /\breturn\s*\(?\s*<[a-z][a-zA-Z]*[\s/>]/.test(inner);
        if (hasReactImport || hasExportDefault || hasJsxReturn) {
          return {
            valid: false,
            reason:
              "HTML file contains a React/JSX component inside a <script> tag. " +
              "Plain HTML files cannot run JSX — write vanilla JS or remove the .html file " +
              "if a .tsx component already covers this.",
          };
        }
        // Detect duplicate export default / function declarations in inline script
        const exportMatches = (
          inner.match(/\bexport\s+default\s+function\b/g) ?? []
        ).length;
        if (exportMatches > 1) {
          return {
            valid: false,
            reason:
              "HTML <script> block contains duplicate `export default function` declarations. " +
              "This is not valid browser JavaScript.",
          };
        }
      }
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
    const isJsx = ext === "jsx" || ext === "tsx";

    // Reject imports from parent directories ("../").
    // All generated files live in a flat output directory — "../" paths are phantom
    // hallucinations (e.g. import from "../store/...", "../types/...").
    const upDirImportMatch = trimmed.match(
      /^\s*import\s+.*?from\s+["']\.\.\/[^"']*["']/m,
    );
    if (upDirImportMatch) {
      const offendingLine = upDirImportMatch[0].trim().slice(0, 80);
      return {
        valid: false,
        reason:
          `File imports from a parent directory ("../") which does not exist: ${offendingLine}. ` +
          `All imports must be from "./" sibling files or installed packages. Remove the "../" import.`,
      };
    }

    // Reject imports of non-browser / desktop-only packages.
    // These are hallucinated dependencies that don't exist in a web project.
    const BANNED_PACKAGES = [
      "electron",
      "electron-clipboard",
      "child_process",
      "worker_threads",
      "readline",
      "repl",
      "cluster",
      "dgram",
      // web-audio-api is a Node.js polyfill — in browsers use new AudioContext() directly
      "web-audio-api",
      // soundjs / tone.js hallucinations
      "soundjs",
      // UI libraries not installed in this project
      "@material-ui/core",
      "@material-ui/icons",
      "@mui/material",
      "@mui/icons-material",
      "@mui/system",
      // State management not installed
      "react-redux",
      "redux",
      "zustand",
      "mobx",
      "recoil",
      // Routing not installed
      "react-router-dom",
      "react-router",
    ];
    const bannedImportMatch = trimmed.match(
      new RegExp(
        `^\\s*import\\s+.*?from\\s+["'](${BANNED_PACKAGES.map((p) => p.replace(/[-/]/g, "\\$&")).join("|")})["']`,
        "m",
      ),
    );
    if (bannedImportMatch) {
      const pkg = bannedImportMatch[1];
      return {
        valid: false,
        reason:
          `File imports from "${pkg}" which is not available in a browser/React project. ` +
          `Remove this import and use browser-native APIs instead (e.g. navigator.clipboard for clipboard access).`,
      };
    }

    if (
      trimmed.startsWith("<!DOCTYPE") ||
      trimmed.startsWith("<html") ||
      trimmed.startsWith("<head") ||
      trimmed.startsWith("<body")
    ) {
      return {
        valid: false,
        reason:
          "File contains HTML document markup instead of component code. Write a React component, not a full HTML document.",
      };
    }
    // HTML tag checks only apply to plain JS/TS — JSX/TSX legitimately contain HTML-like tags
    if (!isJsx) {
      const htmlTagPattern =
        /^\s*<(?:div|span|button|input|form|table|ul|ol|li|p|h[1-6]|a|img|nav|header|footer|section|main|!DOCTYPE|html|head|body)[\s>]/im;
      if (htmlTagPattern.test(trimmed)) {
        return {
          valid: false,
          reason:
            "JavaScript file contains HTML tags. Write only JavaScript code, no HTML.",
        };
      }
      const lines = trimmed.split("\n").filter((l) => l.trim().length > 0);
      const htmlLines = lines.filter((l) => /^\s*<[a-zA-Z!\/]/.test(l));
      if (lines.length > 3 && htmlLines.length / lines.length > 0.3) {
        return {
          valid: false,
          reason:
            "JavaScript file appears to contain HTML markup instead of JavaScript code.",
        };
      }
    }
    // TSX-specific: must have a default export, return statement, and JSX
    if (isJsx) {
      if (!trimmed.includes("export default")) {
        return {
          valid: false,
          reason:
            "TSX component must have a default export (e.g., export default function Component).",
        };
      }
      // Must have a return statement (components that don't return JSX render nothing)
      if (!trimmed.includes("return")) {
        return {
          valid: false,
          reason: "Component has no return statement — it must return JSX.",
        };
      }
      // Must contain JSX (angle brackets in a return context, or React.createElement)
      const hasJsx =
        /<\w/.test(trimmed) || trimmed.includes("React.createElement");
      if (!hasJsx) {
        return {
          valid: false,
          reason:
            "Component has no JSX — it must return rendered elements like <div>.",
        };
      }
      // Check for truncated/incomplete component (function body ends abruptly)
      // A component with `return (` but no closing `)` for it is truncated
      const returnCount = (trimmed.match(/\breturn\s*[\(\<]/g) || []).length;
      if (
        returnCount === 0 &&
        trimmed.includes("return") &&
        !trimmed.includes("return null") &&
        !trimmed.includes("return;")
      ) {
        // Has "return" but not followed by JSX or null — likely truncated
        const lastReturn = trimmed.lastIndexOf("return");
        const afterReturn = trimmed.slice(lastReturn + 6).trim();
        if (afterReturn.length < 5) {
          return {
            valid: false,
            reason:
              "Component return statement appears truncated — incomplete code.",
          };
        }
      }
    }
    // Check JS file is not just comments
    const jsStripped = trimmed
      .replace(/\/\/.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .trim();
    if (jsStripped.length < 10) {
      return {
        valid: false,
        reason: "Component file contains only comments, no actual code",
      };
    }
    // Scaffold detection: reject JS that has functions but no real logic
    if (!options?.allowScaffold) {
      const scaffoldResult = detectJsScaffold(trimmed);
      if (!scaffoldResult.valid) return scaffoldResult;
    }
    // A JS/TS file can only have one export default
    if (ext === "tsx" || ext === "jsx" || ext === "ts" || ext === "js") {
      const exportDefaultCount = (trimmed.match(/\bexport\s+default\b/g) ?? [])
        .length;
      if (exportDefaultCount > 1) {
        return {
          valid: false,
          reason: `File has ${exportDefaultCount} "export default" declarations — only one is allowed per file. Each step must edit the same component, not append new ones.`,
        };
      }
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
        reason: `Component file has duplicate declarations: ${names}. Each function/variable must be declared only once.`,
      };
    }

    // TSX-specific scoping check: detect setState calls in components that lack
    // the matching useState.  Pattern: `setFoo(` appears in a component function
    // body but `const [, setFoo] = useState` (or equivalent) is absent.
    // This catches the runtime-crash pattern where a parent calls a child's state
    // setter that was never declared in the parent.
    // NOTE: skip this on intermediate steps (allowScaffold=true) because the file
    // is being built incrementally — state declarations may arrive in a later step.
    if (isJsx && !options?.allowScaffold) {
      // Browser-native functions that start with "set" but are NOT React state setters.
      // These must be excluded from the useState scoping check.
      const BROWSER_SET_GLOBALS = new Set([
        "setInterval",
        "setTimeout",
        "setImmediate",
        "setItem", // localStorage.setItem
        "setAttribute",
        "setProperty", // CSSStyleDeclaration
        "setPointerCapture",
        "setCustomValidity",
        "setSelectionRange",
        "setRangeText",
        "setRequestHeader",
        "setTransform",
        "setTime",
        "setDate",
        "setMonth",
        "setFullYear",
        "setHours",
        "setMinutes",
        "setSeconds",
        "setMilliseconds",
      ]);

      // Collect every `setXxx(` call in the file. Exclude method calls
      // (anything preceded by `.` or `?.`) so DOM/browser setters like
      // `dataTransfer.setData()`, `localStorage.setItem()`, `element.setAttribute()`
      // are not misread as undeclared React state setters.
      const setterCalls =
        trimmed.match(/(^|[^.\w?])set([A-Z][a-zA-Z0-9]*)\s*\(/g) ?? [];
      for (const callMatch of setterCalls) {
        // Extract the setter name e.g. "setCount" from "(set|^)setCount("
        const nameMatch = callMatch.match(/set[A-Z][a-zA-Z0-9]*/);
        if (!nameMatch) continue;
        const setterName = nameMatch[0];
        // Skip known browser globals
        if (BROWSER_SET_GLOBALS.has(setterName)) continue;
        // Build the matching useState pattern: const [anything, setFoo] = useState
        const useStatePat = new RegExp(
          `const\\s+\\[\\s*\\w+\\s*,\\s*${setterName}\\s*\\]\\s*=\\s*use(?:State|Reducer)`,
        );
        if (!useStatePat.test(trimmed)) {
          return {
            valid: false,
            reason:
              `Component calls \`${setterName}()\` but never declares the matching \`const [state, ${setterName}] = useState(...)\`. ` +
              `Add the useState declaration or remove the setter call.`,
          };
        }
      }
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
        "Component file contains only scaffold/empty functions with no real logic. Functions need actual implementation.",
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
    "current file draft",
    "current output draft",
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
//  Consistency validation
// ─────────────────────────────────────────────

export interface ConsistencyIssue {
  file: string;
  severity: "error" | "warning";
  message: string;
}

/**
 * Cross-file consistency validation stub.
 * Retained for API compatibility; returns empty for now.
 * Future: could check import/export consistency across manifest files.
 */
export function validateCrossFileConsistency(
  _component: string,
): ConsistencyIssue[] {
  return [];
}
