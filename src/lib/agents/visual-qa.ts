/**
 * Visual QA agent — render the built UI in headless Chromium, screenshot
 * it, and ask a vision-capable model whether it matches the spec.
 *
 * GATED by `modelCapabilities(model).vision`. The pipeline only runs this
 * pass when the active model can accept image input (gemma3+, llava, etc).
 *
 * The agent loads the project's main .tsx file, inlines local sibling
 * imports, wraps in a React+Babel-standalone preview HTML, renders it via
 * Playwright at a fixed 1024×768 viewport, captures a PNG, then sends the
 * image + spec to the vision model for review.
 *
 * Output is a list of visual issues (empty if the UI matches the spec).
 */

import fs from "fs";
import path from "path";
import { chromium } from "playwright";
import { callOllamaVision } from "@/lib/ollama";

export interface VisualIssue {
  file: string;
  problem: string;
}

export interface VisualQAResult {
  ok: boolean;
  issues: VisualIssue[];
  screenshotBytes?: number;
  /** Diagnostic — set when we couldn't render (missing files, browser launch failed) */
  skippedReason?: string;
  raw?: string;
  prompt?: string;
  tokens?: number;
  durationMs?: number;
}

const SYSTEM_PROMPT = `You are a UI reviewer. You will be given:
1. A project specification.
2. A screenshot of the rendered application in its INITIAL / IDLE state (no user interaction has occurred).

Identify VISUAL issues where the rendered UI does not match the spec:
- Missing buttons / inputs / elements explicitly listed in the spec
- Blank screen / error message visible
- Critical text mismatches (e.g. spec says "Submit" but the button reads "Click")

IMPORTANT — this is a STATIC screenshot of the initial render. Do NOT flag:
- Dynamic behaviours that only appear after user interaction (e.g. button text changing from "Start" to "Pause" while running, counters incrementing, items appearing after clicking Add)
- Timers, countdowns, or animations that change over time
- State that is only visible after a specific user action
Only flag elements that should be present on first load and are missing from the screenshot.

Do NOT report polish (colours, alignment, fonts) — only spec-compliance.

Reply ONLY in this exact format:

>>VISUAL
- <one specific visual issue>
- <another visual issue>
>>END

If everything looks correct, leave the list empty:

>>VISUAL
>>END

Cap the list at 3 items.`;

/**
 * Build a self-contained preview HTML for a single .tsx/.jsx component.
 *
 * Inlines sibling local imports (./Foo.tsx etc) up to 3 levels deep so the
 * preview works without a bundler. Uses React UMD + Babel standalone from
 * unpkg — the headless browser needs network access for this to render.
 */
export function buildPreviewHtml(
  mainFile: string,
  outputDir: string,
): { html: string; componentName: string } {
  const raw = fs.readFileSync(path.join(outputDir, mainFile), "utf-8");
  const cleaned = raw.replace(/^>>[ \t]?/gm, "");
  const componentCode = inlineLocalImports(cleaned, outputDir);

  const fnNameMatch = cleaned.match(
    /export\s+default\s+function\s+(\w+)|(?:^|\n)\s*function\s+(\w+)/,
  );
  const componentName = fnNameMatch?.[1] || fnNameMatch?.[2] || "Component";

  const fullCode =
    `const { useState, useEffect, useRef, useCallback, useMemo, useReducer, useContext, createContext, Fragment } = React;\n\n` +
    componentCode +
    `\n\nvar root = ReactDOM.createRoot(document.getElementById("root"));\n` +
    `root.render(React.createElement(typeof ${componentName} !== "undefined" ? ${componentName} : function() { return React.createElement("div", null, "No component found"); }));`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Visual QA</title>
  <script src="https://unpkg.com/react@18/umd/react.development.js" crossorigin></script>
  <script src="https://unpkg.com/react-dom@18/umd/react-dom.development.js" crossorigin></script>
  <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
  <style>* { margin: 0; padding: 0; box-sizing: border-box; } body { font-family: -apple-system, system-ui, sans-serif; padding: 16px; }</style>
</head>
<body>
  <div id="root"></div>
  <script>
    try {
      var code = ${JSON.stringify(fullCode)};
      var result = Babel.transform(code, {
        presets: ['react', ['typescript', { isTSX: true, allExtensions: true }]],
        filename: 'Component.tsx'
      });
      var s = document.createElement('script');
      s.textContent = result.code;
      document.body.appendChild(s);
    } catch (e) {
      document.body.innerHTML = '<pre style="color:red">' + (e.message || String(e)) + '</pre>';
    }
  </script>
</body>
</html>`;

  return { html, componentName };
}

/** Recursive sibling-import inlining — duplicated minimally from the output route. */
function inlineLocalImports(
  content: string,
  outputDir: string,
  seen: Set<string> = new Set(),
  depth = 0,
): string {
  if (depth > 3) return content;

  const importedPaths: string[] = [];
  let stripped = content.replace(
    /^\s*import\s+(?:[\w*{},\s]+)\s+from\s+["'](\.\/[^"']+)["'];?\s*$/gm,
    (_, p: string) => {
      importedPaths.push(p);
      return "";
    },
  );
  stripped = stripped
    .replace(/^\s*import\s+[\s\S]*?from\s+["'].*?["'];?\s*$/gm, "")
    .replace(/^\s*import\s+["'].*?["'];?\s*$/gm, "")
    .replace(/^\s*export\s+default\s+\w+;\s*$/gm, "")
    .replace(/^\s*export\s+default\s+/gm, "")
    .replace(
      /^\s*export\s+(?=function|const|class|let|var|type|interface)/gm,
      "",
    );

  const chunks: string[] = [];
  for (const importPath of importedPaths) {
    const base = importPath.replace(/\.\w+$/, "");
    for (const ext of [".tsx", ".ts", ".jsx", ".js"]) {
      const candidate = path.join(outputDir, base + ext);
      if (fs.existsSync(candidate) && !seen.has(candidate)) {
        seen.add(candidate);
        let sib = fs.readFileSync(candidate, "utf-8");
        sib = sib.replace(/^>>[ \t]?/gm, "");
        sib = inlineLocalImports(sib, outputDir, seen, depth + 1);
        chunks.push(sib);
        break;
      }
    }
  }

  return chunks.join("\n\n") + "\n\n" + stripped;
}

export function parseVisualIssues(text: string): string[] {
  const match = text.match(/>>VISUAL\s*\n([\s\S]*?)(?:>>END|$)/i);
  const body = match ? match[1] : text;
  const issues: string[] = [];
  for (const line of body.split("\n")) {
    const m = line.trim().match(/^[-*•]\s*(.+)$/);
    if (m) issues.push(m[1].trim());
  }
  return issues.slice(0, 3);
}

/**
 * Render the main file, screenshot it, and send to the vision model for review.
 *
 * `mainFile` should be the entry .tsx file (typically App.tsx).
 * `outputDir` is the absolute path to the project's output folder.
 */
export async function runVisualQA(
  model: string,
  projectName: string,
  projectDescription: string,
  mainFile: string,
  outputDir: string,
): Promise<VisualQAResult> {
  if (!fs.existsSync(path.join(outputDir, mainFile))) {
    return {
      ok: false,
      issues: [],
      skippedReason: `Main file ${mainFile} not found`,
    };
  }

  let html: string;
  try {
    ({ html } = buildPreviewHtml(mainFile, outputDir));
  } catch (e) {
    return {
      ok: false,
      issues: [],
      skippedReason: `Preview build failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  // Render in headless Chromium
  let screenshot: Buffer;
  try {
    const browser = await chromium.launch({ headless: true });
    try {
      const ctx = await browser.newContext({
        viewport: { width: 1024, height: 768 },
      });
      const page = await ctx.newPage();
      await page.setContent(html, { waitUntil: "networkidle", timeout: 15000 });
      // Give Babel a moment to transform + render
      await page.waitForTimeout(500);
      screenshot = await page.screenshot({ type: "png", fullPage: false });
    } finally {
      await browser.close();
    }
  } catch (e) {
    return {
      ok: false,
      issues: [],
      skippedReason: `Browser render failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const userMessage = `Project: ${projectName}
Spec: ${projectDescription}

The attached screenshot is the rendered ${mainFile}. Review it against the spec.`;

  try {
    const { text, prompt, tokens, durationMs } = await callOllamaVision(
      model,
      "qa",
      SYSTEM_PROMPT,
      userMessage,
      [screenshot.toString("base64")],
    );
    const issues = parseVisualIssues(text).map((problem) => ({
      file: mainFile,
      problem,
    }));
    return {
      ok: true,
      issues,
      screenshotBytes: screenshot.length,
      raw: text,
      prompt,
      tokens,
      durationMs,
    };
  } catch (e) {
    return {
      ok: false,
      issues: [],
      screenshotBytes: screenshot.length,
      skippedReason: `Vision call failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/**
 * Render-and-collect-errors gate.
 *
 * Runs the same preview-HTML render as `runVisualQA` but ONLY collects
 * runtime errors — no vision call, no screenshot. Used as a mandatory
 * QA gate (not vision-gated) to catch broken artifacts: cross-file
 * duplicate identifiers, undefined references, throw-on-mount components,
 * etc. The per-file TypeScript checks miss these because the preview
 * inlines all sibling imports into a single virtual file before babel
 * transforms it.
 *
 * Returns:
 *   { errors: string[], rendered: boolean, skippedReason?: string }
 *
 * `errors` contains:
 *   - Unhandled page errors (page.on("pageerror"))
 *   - Console.error messages
 *   - Render fallback markers from the inline error boundary
 * `rendered` is true if the page loaded without launch failures.
 * `skippedReason` is set when we couldn't even attempt rendering.
 */
export interface RenderErrorReport {
  errors: string[];
  rendered: boolean;
  skippedReason?: string;
}

export async function renderAndCollectErrors(
  mainFile: string,
  outputDir: string,
): Promise<RenderErrorReport> {
  if (!fs.existsSync(path.join(outputDir, mainFile))) {
    return {
      errors: [],
      rendered: false,
      skippedReason: `Main file ${mainFile} not found`,
    };
  }

  let html: string;
  try {
    ({ html } = buildPreviewHtml(mainFile, outputDir));
  } catch (e) {
    return {
      errors: [],
      rendered: false,
      skippedReason: `Preview build failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const errors: string[] = [];

  try {
    const browser = await chromium.launch({ headless: true });
    try {
      const ctx = await browser.newContext({
        viewport: { width: 1024, height: 768 },
      });
      const page = await ctx.newPage();

      page.on("pageerror", (err) => {
        errors.push(`pageerror: ${err.message}`);
      });
      page.on("console", (msg) => {
        if (msg.type() === "error") {
          const text = msg.text();
          // Filter noise we don't care about
          if (
            text.includes("Failed to load resource") ||
            text.includes("favicon")
          ) {
            return;
          }
          errors.push(`console.error: ${text}`);
        }
      });

      await page.setContent(html, {
        waitUntil: "networkidle",
        timeout: 15000,
      });
      // Give Babel a moment to transform + React to mount
      await page.waitForTimeout(500);

      // Look for our inline error boundary fallback marker
      try {
        const fallback = await page.evaluate(() => {
          const el = document.querySelector("[data-render-error]");
          return el ? el.textContent : null;
        });
        if (fallback) errors.push(`render fallback: ${fallback.slice(0, 200)}`);
      } catch {
        // ignore
      }
    } finally {
      await browser.close();
    }
  } catch (e) {
    return {
      errors,
      rendered: false,
      skippedReason: `Browser render failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  // Deduplicate
  const unique = Array.from(new Set(errors));
  return { errors: unique, rendered: true };
}
