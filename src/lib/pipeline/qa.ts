/**
 * Post-build QA: the judge, the full QA sequence, and the holistic, improvement
 * and integration passes it runs.
 */
import { runDeveloper, supportsTDD } from "@/lib/agents/developer";
import { checkTypeScriptSyntax } from "@/lib/ops/compiler";
import { validateOutput, autoRepairOutput } from "@/lib/validate";
import fs from "fs";
import path from "path";
import type { Pipeline } from ".";
import { runTestQA } from "./tdd";
import { runIterativeQAPass, runProgressReviewPass } from "./review-passes";
import { runRenderErrorGate, runVisualQAPass } from "./visual";

// ─────────────────────────────────────────────
//  JUDGE PHASE (post-Execute gate)
// ─────────────────────────────────────────────

/**
 * Inspect what Execute actually produced and set this.judgeVerdict.
 *
 * Checks every TypeScript/TSX/JSX file in the manifest:
 *   - "substantial": > 150 non-whitespace chars (has real content)
 *   - "thin": <= 150 (scaffold-only or essentially empty)
 *   - "missing": not on disk at all
 *
 * Verdicts:
 *   proceed     — majority of files are substantial → normal QA
 *   warn        — some files are thin but majority OK → normal QA, log warning
 *   skip_vitest — majority are thin/missing → skip vitest (would crash-loop
 *                 against symptoms instead of the actual problem)
 *
 * Non-TS projects (markdown, JSON, Python) always get "proceed" since
 * vitest doesn't apply to them anyway.
 */
export async function runJudgePhase(p: Pipeline) {
  const SUBSTANTIAL = 150; // non-whitespace chars
  const MIN_STATEMENTS = 5; // semicolons/blocks for non-stub
  const MAX_TODO_RATIO = 0.3; // > this fraction of lines containing TODO/FIXME/XXX = stub

  const tsFiles = p.manifest.filter((f) =>
    ["ts", "tsx", "jsx"].includes(
      f.path.split(".").pop()?.toLowerCase() ?? "",
    ),
  );

  if (tsFiles.length === 0) {
    p.judgeVerdict = "proceed";
    return;
  }

  let substantial = 0;
  let thin = 0;
  let missing = 0;
  const thinReasons: string[] = [];

  for (const file of tsFiles) {
    const content = p.getCurrentFileContent(file.path);
    if (!content) {
      missing++;
      continue;
    }
    const nonWs = content.replace(/\s/g, "").length;
    const lines = content.split("\n");
    const nonBlankLines = lines.filter((l) => l.trim().length > 0);
    // Count rough statement-ish lines (lines ending in `;` or opening a block)
    const stmtCount = nonBlankLines.filter((l) =>
      /[;{]\s*$/.test(l.trimEnd()),
    ).length;
    const todoLines = nonBlankLines.filter((l) =>
      /\b(TODO|FIXME|XXX|placeholder|stub)\b/i.test(l),
    ).length;
    const todoRatio = nonBlankLines.length
      ? todoLines / nonBlankLines.length
      : 0;
    // Detect default-empty render bodies for tsx/jsx
    const isEmptyComponent =
      /\.(tsx|jsx)$/i.test(file.path) &&
      /return\s*\(\s*<>\s*<\/>\s*\)|return\s+null\s*;|return\s*<\s*\/?\s*>/.test(
        content,
      );

    const isThin =
      nonWs < SUBSTANTIAL ||
      stmtCount < MIN_STATEMENTS ||
      todoRatio > MAX_TODO_RATIO ||
      isEmptyComponent;

    if (!isThin) {
      substantial++;
    } else {
      thin++;
      const why: string[] = [];
      if (nonWs < SUBSTANTIAL) why.push(`${nonWs}<${SUBSTANTIAL} chars`);
      if (stmtCount < MIN_STATEMENTS)
        why.push(`${stmtCount}<${MIN_STATEMENTS} stmts`);
      if (todoRatio > MAX_TODO_RATIO)
        why.push(`${Math.round(todoRatio * 100)}% TODO`);
      if (isEmptyComponent) why.push("empty render");
      thinReasons.push(`${file.path} (${why.join(", ")})`);
    }
  }

  const total = tsFiles.length;
  const summary = `${substantial}/${total} files substantial, ${thin} thin, ${missing} missing`;
  const detail = thinReasons.length
    ? ` — thin: ${thinReasons.slice(0, 3).join("; ")}${thinReasons.length > 3 ? ` +${thinReasons.length - 3} more` : ""}`
    : "";

  if (missing + thin > substantial) {
    await p.log(
      "JUDGE",
      `${summary} → SKIP_VITEST: most output is insufficient; skipping test runner to avoid crash-loop${detail}`,
    );
    p.judgeVerdict = "skip_vitest";
    p.qaFatalIssues.push(`Judge verdict SKIP_VITEST: ${summary}${detail}`);
  } else if (thin > 0 || missing > 0) {
    await p.log(
      "JUDGE",
      `${summary} → WARN: some files are thin; QA may partially fail${detail}`,
    );
    p.judgeVerdict = "warn";
  } else {
    await p.log("JUDGE", `${summary} → PROCEED`);
    p.judgeVerdict = "proceed";
  }
}

// ─────────────────────────────────────────────
//  FULL QA PIPELINE (reusable: called after execute AND feedback)
// ─────────────────────────────────────────────

/**
 * Runs the complete QA pipeline:
 *   1. Test-based QA (run vitest, fix failures one at a time) — PRIMARY
 *   2. Holistic review (structural checks — programmatic only)
 *   3. Iterative QA (LLM find-one-fix-one) — ONLY if tests failed
 *   4. Improve pass — ONLY if tests failed
 *   5. Consistency check
 *
 * When TDD tests all pass, skip the expensive LLM-based QA passes.
 * Small models hallucinate phantom issues and introduce bugs while "fixing" them.
 */
export async function runFullQA(p: Pipeline) {
  if (p.judgeVerdict === "skip_vitest") {
    await p.log(
      "QA",
      "Judge: skipping vitest (insufficient output) — running holistic + render gate + consistency only",
    );
    await runHolisticReviewPass(p);
    // Render gate still runs even when vitest is skipped — a thin file
    // can still throw at mount, and surfacing that is honest reporting.
    await runRenderErrorGate(p);
    await runConsistencyCheck(p);
    return;
  }

  const tddFiles = p.manifest.filter((f) => supportsTDD(f.path));
  let testsAllPassed = tddFiles.length > 0;
  for (const tddFile of tddFiles) {
    const passed = await runTestQA(p, tddFile.path);
    if (!passed) testsAllPassed = false;
  }
  await runHolisticReviewPass(p);

  if (testsAllPassed) {
    await p.log(
      "QA",
      "Tests all pass — skipping iterative QA and improvement (would risk introducing bugs)",
    );
  } else {
    // Tests failed or don't exist: fall back to LLM-based QA as secondary safety net
    await runIterativeQAPass(p);
    await runImprovementPass(p);
  }

  // Progress review (PM honing): cheap final pass that compares the spec
  // to the built files and patches in genuinely missing spec features.
  // Runs whether or not tests passed — spec drift is orthogonal to bug
  // count, e.g. a project may build cleanly but be missing the "delete"
  // button the spec asked for.
  await runProgressReviewPass(p);

  // Render gate — render the UI in headless Chromium and collect any
  // runtime errors. Runs for ALL models (not vision-gated). Catches
  // cross-file bugs that per-file TS checks miss: duplicate identifiers
  // after import inlining, undefined references, throw-on-mount, etc.
  // If errors are found, fixes are attempted via runDeveloperPatch.
  await runRenderErrorGate(p);

  // Visual QA — render the UI in headless Chromium and ask a vision
  // model whether it matches the spec. Only runs for vision-capable
  // models (gemma3+, llava, etc). Reports issues via REV log entries;
  // does NOT auto-fix (vision verdicts are noisy — surface to user).
  await runVisualQAPass(p);

  await runConsistencyCheck(p);
}

// ─────────────────────────────────────────────
//  PHASE 5: HOLISTIC REVIEW (Programmatic quality checks + LLM review)
// ─────────────────────────────────────────────

/**
 * Programmatic checks for common structural/quality problems.
 * Adapts checks based on file type.
 */
export function checkOutputQualityForFile(
  p: Pipeline,
  content: string,
  filePath: string,
): { file: string; issue: string }[] {
  const issues: { file: string; issue: string }[] = [];
  const ext = filePath.split(".").pop()?.toLowerCase() || "";

  if (!content || content.trim().length < 30) {
    issues.push({
      file: filePath,
      issue: `File is nearly empty — write complete content`,
    });
    return issues;
  }

  // Code-specific checks
  if (["tsx", "jsx", "ts", "js", "py", "css"].includes(ext)) {
    // Brace balance / truncation indicator.
    // For JS/TS/JSX/TSX, defer to the TypeScript parser — counting `{`/`}`
    // by hand produces false positives for regex literals (`/\}/`) and
    // JSX expressions. The parser already reports unterminated blocks.
    // For CSS we still use a naive counter (no parser available).
    if (["tsx", "jsx", "ts", "js"].includes(ext)) {
      const errs = checkTypeScriptSyntax(filePath, content);
      const trunc = errs.find(
        (msg) =>
          /\}.*expected|expected.*\}|Unexpected end of/i.test(msg) ||
          /unterminated|unexpected token/i.test(msg),
      );
      if (trunc) {
        issues.push({
          file: filePath,
          issue: `Syntax error suggests truncation: ${trunc}`,
        });
      }
    } else if (ext === "css") {
      let braceCount = 0;
      const stripped = content
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/"(?:[^"\\]|\\.)*"/g, '""')
        .replace(/'(?:[^'\\]|\\.)*'/g, "''");
      for (const ch of stripped) {
        if (ch === "{") braceCount++;
        if (ch === "}") braceCount--;
      }
      if (braceCount !== 0) {
        issues.push({
          file: filePath,
          issue: `Unbalanced braces (${braceCount > 0 ? braceCount + " unclosed" : Math.abs(braceCount) + " extra closing"}) — file may be truncated`,
        });
      }
    }

    // Detect placeholder handlers: alert() or console.log() as main action.
    // BUT: skip this check if the project description literally asks for an
    // alert/alarm/notification — for things like timers, alert("Done!") is
    // a legitimate implementation, not a placeholder.
    const descLower = (p.projectDescription || "").toLowerCase();
    const alertIsRequested =
      /\b(alert|alarm|notify|notification|beep|chime|sound)\b/.test(
        descLower,
      );
    const alertPlaceholders =
      content.match(/alert\s*\(\s*["'`][^"'`]*["'`]\s*\)/g) || [];
    if (alertPlaceholders.length > 0 && !alertIsRequested) {
      issues.push({
        file: filePath,
        issue: `Found ${alertPlaceholders.length} alert() placeholder(s) — replace with real logic`,
      });
    }

    // Detect empty/stub handlers
    const stubHandlers = content.match(/=>\s*\{\s*\/\/.*\n\s*\}/g) || [];
    if (stubHandlers.length > 0) {
      issues.push({
        file: filePath,
        issue: `${stubHandlers.length} empty/stub handler(s) with only comments — implement real logic`,
      });
    }
  }

  // React-specific checks
  if (ext === "tsx" || ext === "jsx") {
    const lower = content.toLowerCase();

    if (!lower.includes("export default")) {
      issues.push({
        file: filePath,
        issue:
          "No default export found — add 'export default function Component()'",
      });
    }

    if (!content.includes("return")) {
      issues.push({
        file: filePath,
        issue:
          "Component has no return statement — it must return JSX elements",
      });
    }

    // Detect uncontrolled inputs
    const inputTags = content.match(/<input\b[^>]*>/g) || [];
    let uncontrolledCount = 0;
    for (const tag of inputTags) {
      if (
        !tag.includes("value=") &&
        !tag.includes("defaultValue=") &&
        !tag.includes("checked=") &&
        !tag.includes("defaultChecked=") &&
        !tag.includes('type="submit"') &&
        !tag.includes('type="button"')
      ) {
        uncontrolledCount++;
      }
    }
    if (uncontrolledCount > 0) {
      issues.push({
        file: filePath,
        issue: `${uncontrolledCount} uncontrolled input(s) found — add value={state} and onChange={handler}`,
      });
    }
  }

  // HTML-specific checks
  if (ext === "html" || ext === "htm") {
    if (!content.includes("<!DOCTYPE") && !content.includes("<!doctype")) {
      issues.push({
        file: filePath,
        issue: "Missing DOCTYPE declaration",
      });
    }
    if (!content.includes("<html")) {
      issues.push({
        file: filePath,
        issue: "Missing <html> tag — write a complete HTML page",
      });
    }
  }

  // Markdown checks
  if (ext === "md" || ext === "markdown") {
    if (!content.includes("#")) {
      issues.push({
        file: filePath,
        issue: "No headings found — use # for structure",
      });
    }
    if (content.trim().split("\n").length < 5) {
      issues.push({
        file: filePath,
        issue: "Document is very short — add more detail and content",
      });
    }
  }

  // JSON check
  if (ext === "json") {
    try {
      JSON.parse(content);
    } catch {
      issues.push({
        file: filePath,
        issue: "Invalid JSON — file cannot be parsed",
      });
    }
  }

  return issues;
}

export async function runHolisticReviewPass(p: Pipeline) {
  const outDir = p.outputDir();
  if (!fs.existsSync(outDir)) return;

  const readFile = (name: string) => {
    const fullPath = path.join(outDir, name);
    if (!fs.existsSync(fullPath)) return "";
    return fs.readFileSync(fullPath, "utf-8");
  };

  // Check all manifest files
  let hasContent = false;
  for (const file of p.manifest) {
    const content = readFile(file.path);
    if (content.trim().length > 20) {
      hasContent = true;
      break;
    }
  }
  if (!hasContent) return;

  await p.log("QA", "Running structural quality checks...");

  // Programmatic-only quality checks per file
  const allIssues: { file: string; issue: string }[] = [];
  for (const file of p.manifest) {
    const content = readFile(file.path);
    if (content.trim().length < 20) continue;
    const fileIssues = checkOutputQualityForFile(p, content, file.path);
    allIssues.push(...fileIssues);
  }

  if (allIssues.length === 0) {
    await p.log("QA", "PASS — no structural issues found");
    return;
  }

  await p.log(
    "QA",
    `Quality review found ${allIssues.length} issue(s) to fix`,
  );
  for (const { file, issue } of allIssues) {
    await p.log("QA", `[${file}] ${issue}`);
  }

  // Group issues by file (all are programmatic with known files)
  const issuesByFile: Record<string, string[]> = {};
  for (const { file, issue } of allIssues) {
    if (!issuesByFile[file]) issuesByFile[file] = [];
    issuesByFile[file].push(issue);
  }

  // Fix each file that has issues
  for (const filePath of p.getFileOrder()) {
    if (p.aborted) break;
    const fileIssues = issuesByFile[filePath];
    if (!fileIssues || fileIssues.length === 0) continue;

    const existingContent = readFile(filePath);
    if (!existingContent || existingContent.trim().length < 20) continue;

    let userMessage = `Project: ${p.projectName} — ${p.projectDescription}\n\n`;
    userMessage += `Current ${filePath}:\n${existingContent}\n\n`;
    userMessage += `A quality review found these issues:\n`;
    userMessage += fileIssues.map((iss, i) => `${i + 1}. ${iss}`).join("\n");
    userMessage += `\n\nFix ALL of these issues and rewrite the COMPLETE ${filePath} file. Keep all working functionality intact.`;

    userMessage = p.withCustomInstructions(userMessage);

    await p.log(
      "QA",
      `Reworking ${filePath}: ${fileIssues.length} issue(s)`,
    );

    const devResult = await runDeveloper(p.model, userMessage, filePath);

    if (devResult.block) {
      const output = devResult.block.output;
      const { repaired } = autoRepairOutput(output, filePath);
      const validation = validateOutput(repaired, filePath);
      if (validation.valid) {
        await p.writeOutputFile(filePath, repaired);
        await p.log(
          "QA",
          `Fixed ${filePath} (${devResult.tokens} tokens)`,
          undefined,
          devResult.prompt,
          devResult.raw,
        );
      } else {
        await p.log(
          "QA",
          `Fix for ${filePath} failed validation: ${validation.reason} — keeping original`,
          undefined,
          devResult.prompt,
          devResult.raw,
        );
      }
    } else {
      await p.log(
        "QA",
        `Could not fix ${filePath} — Developer parse failure`,
        undefined,
        devResult.prompt,
        devResult.raw,
      );
    }
  }

  await p.log("QA", "Quality review rework complete");
}

// ─────────────────────────────────────────────
//  PHASE 7: IMPROVE (file bug review)
// ─────────────────────────────────────────────

export async function runImprovementPass(p: Pipeline) {
  // Check each code file for real syntax/rendering errors using the TS
  // compiler — no LLM guessing. Only call the developer when there are
  // actual errors to fix.
  const CODE_EXTS = new Set(["tsx", "jsx", "ts", "js"]);
  const outDir = p.outputDir();
  if (!fs.existsSync(outDir)) return;

  for (const file of p.manifest) {
    if (p.aborted) break;
    const ext = file.path.split(".").pop()?.toLowerCase() || "";
    if (!CODE_EXTS.has(ext)) continue;

    const fullPath = path.join(outDir, file.path);
    if (!fs.existsSync(fullPath)) continue;

    const content = fs.readFileSync(fullPath, "utf-8");
    if (content.trim().length < 20) continue;

    const errors = checkTypeScriptSyntax(file.path, content);
    if (errors.length === 0) continue;

    const errorList = errors.join("\n");
    await p.log(
      "IMP",
      `${file.path}: ${errors.length} syntax error(s) — fixing`,
    );
    await p.log("IMP", errorList);

    let userMessage = `Project: ${p.projectName} — ${p.projectDescription}\n\n`;
    userMessage += `Current ${file.path}:\n${content}\n\n`;
    userMessage += `Fix these syntax errors and output the COMPLETE ${file.path}:\n${errorList}`;
    userMessage = p.withCustomInstructions(userMessage);

    const devResult = await runDeveloper(p.model, userMessage, file.path);
    if (!devResult.block) {
      await p.log(
        "IMP",
        `${file.path}: parse failure — skipping`,
        undefined,
        devResult.prompt,
        devResult.raw,
      );
      continue;
    }

    const { repaired } = autoRepairOutput(devResult.block.output, file.path);
    const validation = validateOutput(repaired, file.path);
    if (!validation.valid) {
      await p.log(
        "IMP",
        `${file.path}: fix failed validation (${validation.reason}) — keeping original`,
        undefined,
        devResult.prompt,
        devResult.raw,
      );
      continue;
    }

    // Only write if the errors are actually gone
    const remaining = checkTypeScriptSyntax(file.path, repaired);
    if (remaining.length < errors.length) {
      await p.writeOutputFile(file.path, repaired);
      await p.log(
        "IMP",
        `${file.path}: fixed (${errors.length - remaining.length} error(s) resolved)`,
        undefined,
        devResult.prompt,
        devResult.raw,
      );
    } else {
      await p.log(
        "IMP",
        `${file.path}: fix didn't reduce errors — keeping original`,
        undefined,
        devResult.prompt,
        devResult.raw,
      );
    }
  }
}

// ─────────────────────────────────────────────
//  PHASE 6: CONSISTENCY CHECK (Programmatic validation)
// ─────────────────────────────────────────────

export async function runConsistencyCheck(p: Pipeline) {
  await runIntegrationPass(p);
}

/**
 * Integration Pass — checks that named imports between manifest files
 * actually exist as exports in the target file.
 *
 * Pattern detected:
 *   import { Foo, Bar } from './SomeFile'
 *
 * For each such import we check whether the target file (SomeFile.tsx etc.)
 * contains a matching export. If not, we call the Developer to fix the
 * importing file with the specific missing-export error.
 *
 * Caps at 3 fix calls — beyond that the output is too broken for targeted
 * repair and the holistic pass will have already flagged the issues.
 */
export async function runIntegrationPass(p: Pipeline) {
  if (p.manifest.length < 2) {
    await p.log("CHK", "Integration check skipped (single-file project)");
    return;
  }

  const outDir = p.outputDir();
  if (!fs.existsSync(outDir)) return;

  const readFile = (name: string): string => {
    const fullPath = path.join(outDir, name);
    if (!fs.existsSync(fullPath)) return "";
    return fs.readFileSync(fullPath, "utf-8");
  };

  /**
   * Extract all named exports from a file's content.
   * Matches:
   *   export function Foo
   *   export const Foo
   *   export class Foo
   *   export type Foo
   *   export interface Foo
   *   export { Foo, Bar }
   *   export default function Foo  (adds "default" + "Foo")
   */
  const getExports = (content: string): Set<string> => {
    const names = new Set<string>();
    // export default (any form)
    if (/export\s+default\b/.test(content)) names.add("default");
    // export default function/class Name
    for (const m of content.matchAll(
      /export\s+default\s+(?:function|class)\s+(\w+)/g,
    )) {
      names.add(m[1]);
    }
    // export function/const/class/type/interface Name
    for (const m of content.matchAll(
      /export\s+(?:async\s+)?(?:function|const|let|var|class|type|interface)\s+(\w+)/g,
    )) {
      names.add(m[1]);
    }
    // export { Foo, Bar as Baz }
    for (const m of content.matchAll(/export\s*\{([^}]+)\}/g)) {
      for (const part of m[1].split(",")) {
        const name = part
          .trim()
          .split(/\s+as\s+/)
          .pop()
          ?.trim();
        if (name) names.add(name);
      }
    }
    return names;
  };

  /**
   * Resolve a relative import path from an importing file to a manifest
   * file path. Returns the manifest file path if found, null otherwise.
   * e.g. import from './TodoList' → 'TodoList.tsx'
   */
  const resolveToManifest = (
    importFrom: string,
    _importingFile: string,
  ): string | null => {
    // Strip leading ./ or ../
    const base = importFrom.replace(/^\.\.?\//, "").replace(/\\/g, "/");
    // Try exact match first
    const exact = p.manifest.find((f) => f.path === base);
    if (exact) return exact.path;
    // Try matching basename without extension
    const baseName = base.replace(/\.\w+$/, "").toLowerCase();
    const byBaseName = p.manifest.find(
      (f) => f.path.replace(/\.\w+$/, "").toLowerCase() === baseName,
    );
    if (byBaseName) return byBaseName.path;
    return null;
  };

  interface ImportIssue {
    importingFile: string;
    targetFile: string;
    missingNames: string[];
  }

  const issues: ImportIssue[] = [];

  for (const file of p.manifest) {
    const content = readFile(file.path);
    if (!content || content.trim().length < 30) continue;

    // Find all named import statements: import { A, B } from './X'
    const importRegex = /import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g;
    for (const m of content.matchAll(importRegex)) {
      const importedNames = m[1]
        .split(",")
        .map((s) =>
          s
            .trim()
            .split(/\s+as\s+/)[0]
            .trim(),
        )
        .filter(Boolean);
      const importPath = m[2];

      // Only check relative imports to other manifest files
      if (!importPath.startsWith(".")) continue;
      const targetPath = resolveToManifest(importPath, file.path);
      if (!targetPath) continue;

      const targetContent = readFile(targetPath);
      if (!targetContent || targetContent.trim().length < 30) continue;

      const exported = getExports(targetContent);
      const missing = importedNames.filter((n) => !exported.has(n));
      if (missing.length > 0) {
        issues.push({
          importingFile: file.path,
          targetFile: targetPath,
          missingNames: missing,
        });
      }
    }
  }

  if (issues.length === 0) {
    await p.log(
      "CHK",
      `Integration check PASS — all cross-file imports resolved`,
    );
    return;
  }

  await p.log(
    "CHK",
    `Integration check found ${issues.length} unresolved import(s)`,
  );

  // Cap at 3 fix calls — beyond that the output is too broken for targeted repair
  const MAX_INTEGRATION_FIXES = 3;
  let fixCount = 0;

  for (const issue of issues) {
    if (p.aborted || fixCount >= MAX_INTEGRATION_FIXES) break;

    const { importingFile, targetFile, missingNames } = issue;
    await p.log(
      "CHK",
      `[${importingFile}] imports { ${missingNames.join(", ")} } from '${targetFile}' but those are not exported`,
    );

    const importingContent = readFile(importingFile);
    const targetContent = readFile(targetFile);
    const targetExports = [...getExports(targetContent)].join(", ");

    let userMessage = `Project: ${p.projectName} — ${p.projectDescription}\n\n`;
    userMessage += `Current ${importingFile}:\n${importingContent}\n\n`;
    userMessage += `INTEGRATION ERROR: this file imports { ${missingNames.join(", ")} } from '${targetFile}', but ${targetFile} only exports: ${targetExports || "(nothing)"}\n\n`;
    userMessage += `Fix the import in ${importingFile} to only use what ${targetFile} actually exports. Rewrite the COMPLETE ${importingFile} file.`;
    userMessage = p.withCustomInstructions(userMessage);

    const devResult = await runDeveloper(
      p.model,
      userMessage,
      importingFile,
    );

    if (devResult.block) {
      const { repaired } = autoRepairOutput(
        devResult.block.output,
        importingFile,
      );
      const validation = validateOutput(repaired, importingFile);
      if (validation.valid) {
        await p.writeOutputFile(importingFile, repaired);
        await p.log(
          "CHK",
          `Fixed import in ${importingFile}`,
          undefined,
          devResult.prompt,
          devResult.raw,
        );
        fixCount++;
      } else {
        await p.log(
          "CHK",
          `Integration fix for ${importingFile} failed validation — keeping original`,
        );
      }
    } else {
      await p.log(
        "CHK",
        `Integration fix for ${importingFile} — Developer parse failure`,
      );
    }
  }

  await p.log("CHK", "Integration pass complete");
}
