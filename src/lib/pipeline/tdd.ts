/**
 * TDD phases: generate test files, run them, and repair failing tests.
 */
import { Task } from "@/db/schema";
import { runDeveloper, supportsTDD } from "@/lib/agents/developer";
import { runTestWriter } from "@/lib/agents/test-writer";
import { analyzeComponent, extractRolesTree } from "@/lib/ops/component-analyzer";
import { validateOutput, autoRepairOutput } from "@/lib/validate";
import { runTests, getFirstFailure, TestRunResult } from "@/lib/test-runner";
import { callOllama as callOllamaFn } from "@/lib/ollama";
import { parseTTM } from "@/lib/protocol";
import fs from "fs";
import path from "path";
import type { Pipeline } from ".";
import { MAX_TEST_REPAIR_ATTEMPTS, MAX_TEST_FIX_ROUNDS } from "./types";
import { truncateForPrompt } from "./text-utils";

/**
 * TDD phase: generate test files BEFORE writing code.
 * Only for file types that support TDD.
 */
export async function runTDDPhase(
  p: Pipeline,
  fileSpecs: Record<string, { requirements: string[]; tasks: Task[] }>,
) {
  let testsGenerated = 0;
  for (const filePath of p.getFileOrder()) {
    if (p.aborted) break;
    const spec = fileSpecs[filePath];
    if (!spec || spec.requirements.length === 0) continue;
    if (supportsTDD(filePath)) {
      try {
        const manifestDesc = p.manifest.find(
          (m) => m.path === filePath,
        )?.description;
        await generateTests(p, spec.requirements, filePath, manifestDesc);
        testsGenerated++;
      } catch (err) {
        // A single file failing to generate tests must not crash the pipeline.
        // Log it and move on — the Execute phase will still write code.
        await p.log(
          "TDD",
          `Test generation failed for ${filePath}: ${
            err instanceof Error ? err.message : String(err)
          } — skipping`,
        );
      }
    }
  }
  if (testsGenerated === 0) {
    await p.log("TDD", "No testable files — skipping test generation");
  }
}

/**
 * Extract only the failing test's code block from the full test file.
 * Returns the imports + the specific it() block (or the full file if
 * the test can't be located, truncated to 60 lines).
 */
export function extractRelevantTest(testCode: string, testName: string): string {
  const lines = testCode.split("\n");

  // Always include import lines (first ~10 lines)
  const importLines: string[] = [];
  let importEnd = 0;
  for (let i = 0; i < Math.min(lines.length, 15); i++) {
    if (
      lines[i].trim().startsWith("import") ||
      lines[i].trim() === "" ||
      lines[i].trim().startsWith("//")
    ) {
      importLines.push(lines[i]);
      importEnd = i + 1;
    } else {
      break;
    }
  }

  // Try to find the specific it() block by test name
  const escapedName = testName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const itPattern = new RegExp(`it\\s*\\(\\s*["'\`]${escapedName}`, "i");

  for (let i = importEnd; i < lines.length; i++) {
    if (itPattern.test(lines[i])) {
      // Found the test — extract from here to its closing brace
      let depth = 0;
      let end = i;
      for (let j = i; j < lines.length; j++) {
        for (const ch of lines[j]) {
          if (ch === "{" || ch === "(") depth++;
          if (ch === "}" || ch === ")") depth--;
        }
        end = j;
        if (depth <= 0) break;
      }
      // Include the describe wrapper line if nearby
      const describeLines: string[] = [];
      for (let k = Math.max(importEnd, i - 3); k < i; k++) {
        if (lines[k].includes("describe")) {
          describeLines.push(lines[k]);
        }
      }
      return [
        ...importLines,
        "",
        ...describeLines,
        ...lines.slice(i, end + 1),
        "});", // close describe
      ].join("\n");
    }
  }

  // Couldn't find it — return truncated full file
  return truncateForPrompt(testCode, 60);
}

/**
 * Generate tests from project requirements using the test-writer agent.
 * Called before code generation (TDD: tests first).
 * Only for file types that support TDD.
 */
export async function generateTests(
  p: Pipeline,
  requirements: string[],
  targetFile?: string,
  manifestDescription?: string,
) {
  // Store so repairSingleTest can regenerate from scratch if stuck
  p.lastGenerateRequirements = requirements;
  p.lastGenerateManifestDescription = manifestDescription;

  const file = targetFile || p.manifest[0]?.path || "output.txt";
  const ext = file.split(".").pop()?.toLowerCase() || "";
  const testFile = file.replace(
    /\.\w+$/,
    `.test.${ext === "tsx" || ext === "jsx" ? "tsx" : ext}`,
  );

  await p.log("TDD", `Generating tests for ${file}...`);

  // Read the already-written code file to extract the real export name.
  // Tests are now generated after Execute, so the file exists.
  const outDir = p.outputDir();
  let exportName: string | undefined;
  const codePath = path.join(outDir, file);
  let fileContent: string | undefined;
  if (fs.existsSync(codePath)) {
    fileContent = fs.readFileSync(codePath, "utf-8");
    // Match: export default function FooBar or export default class FooBar
    const match = fileContent.match(
      /export\s+default\s+(?:function|class)\s+(\w+)/,
    );
    if (match) exportName = match[1];
  }

  // Deterministically extract component structure from source before asking the LLM.
  // This gives the test writer exact prop shapes, button labels, and input presence
  // without requiring it to read or understand the source code itself.
  const componentAnalysis =
    fileContent && fileContent.trim().length > 50
      ? analyzeComponent(fileContent)
      : undefined;

  // For container components (e.g. App.tsx) that import leaf components, the
  // interactive elements (buttons, inputs) live in the children, not in the
  // container source. Scan local imports and merge child analyses so the test
  // writer knows what accessible names will actually appear in the DOM.
  if (componentAnalysis && fileContent) {
    const localImportRe =
      /import\s+\w+\s+from\s+["']\.\/([^"'./][^"']*?)["']/g;
    let importMatch;
    while ((importMatch = localImportRe.exec(fileContent)) !== null) {
      const importedName = importMatch[1];
      for (const ext of [".tsx", ".jsx", ".ts", ".js"]) {
        const childPath = path.join(outDir, importedName + ext);
        if (fs.existsSync(childPath)) {
          const childContent = fs.readFileSync(childPath, "utf-8");
          const childAnalysis = analyzeComponent(childContent);
          for (const btn of childAnalysis.buttonTexts) {
            if (!componentAnalysis.buttonTexts.includes(btn)) {
              componentAnalysis.buttonTexts.push(btn);
            }
          }
          for (const ph of childAnalysis.inputPlaceholders) {
            if (!componentAnalysis.inputPlaceholders.includes(ph)) {
              componentAnalysis.inputPlaceholders.push(ph);
            }
          }
          for (const al of childAnalysis.ariaLabels) {
            if (!componentAnalysis.ariaLabels.includes(al)) {
              componentAnalysis.ariaLabels.push(al);
            }
          }
          if (childAnalysis.hasInput) {
            componentAnalysis.hasInput = true;
          }
          break;
        }
      }
    }
  }

  if (componentAnalysis) {
    await p.log(
      "TDD",
      `Component analysis: ${componentAnalysis.requiredProps.length} required props, ` +
        `${componentAnalysis.buttonTexts.length} buttons (${componentAnalysis.buttonTexts
          .slice(0, 3)
          .map((b) => `"${b}"`)
          .join(", ")}), ` +
        `hasInput=${componentAnalysis.hasInput}`,
    );
  }

  let result = await runTestWriter(
    p.model,
    p.projectName,
    p.projectDescription,
    requirements,
    file,
    exportName,
    fileContent && fileContent.trim().length > 100 ? fileContent : undefined,
    manifestDescription,
    componentAnalysis,
  );

  if (!result.tests) {
    // Retry once with a slightly different prompt framing before giving up.
    await p.log(
      "TDD",
      "Test writer produced no tests on first attempt — retrying...",
      undefined,
      result.prompt,
      result.raw,
    );
    result = await runTestWriter(
      p.model,
      p.projectName,
      p.projectDescription,
      requirements,
      file,
      exportName,
      fileContent && fileContent.trim().length > 100
        ? fileContent
        : undefined,
      manifestDescription,
      componentAnalysis,
    );
  }

  if (!result.tests) {
    await p.log(
      "TDD",
      "Test writer failed to produce tests after retry — skipping TDD",
      undefined,
      result.prompt,
      result.raw,
    );
    return;
  }

  // Auto-repair the test output (strip fences, trailing text, fix braces)
  const { repaired, fixes } = autoRepairOutput(result.tests, testFile);
  if (fixes.length > 0) {
    await p.log("TDD", `Auto-repaired test file: ${fixes.join(", ")}`);
  }

  // Reject test files that contain no actual tests.
  // The model sometimes generates a full component implementation instead of tests.
  // If there's no describe() or it() call, the file is useless as a test file.
  const hasTests = /\bit\s*\(|\bdescribe\s*\(|\btest\s*\(/.test(repaired);
  if (!hasTests) {
    await p.log(
      "TDD",
      `Generated ${testFile} contains no tests (model wrote implementation code) — discarding`,
      undefined,
      result.prompt,
      result.raw,
    );
    return;
  }

  const testPath = path.join(outDir, testFile);
  // Ensure the target directory exists (handles nested manifest paths)
  fs.mkdirSync(path.dirname(testPath), { recursive: true });
  fs.writeFileSync(testPath, repaired, "utf-8");

  await p.log(
    "TDD",
    `Generated ${testFile} (${result.tokens} tokens, ${result.durationMs}ms)`,
    undefined,
    result.prompt,
    result.raw,
  );
}

// ─────────────────────────────────────────────
//  TDD: TEST-BASED QA (run tests → fix failures one at a time)
// ─────────────────────────────────────────────

/**
 * Run vitest against the test file for the primary code file.
 * For each failing test: feed the error to the Developer agent → fix → re-run.
 * If vitest itself crashes (bad test syntax), repair the test file first.
 * @returns true if all tests pass (or no test file exists), false if failures remain
 */
export async function runTestQA(p: Pipeline, targetFile?: string): Promise<boolean> {
  // Clear per-run repair state so stuck detection doesn't bleed across TDD calls
  p.lastRepairError.clear();
  p.regenerateCount.clear();

  // Determine the primary code file and its test file
  const primaryFile =
    targetFile || p.manifest.find((f) => supportsTDD(f.path))?.path;
  if (!primaryFile) {
    await p.log(
      "TDD",
      "No testable file in manifest — skipping test-based QA",
    );
    return false;
  }

  const ext = primaryFile.split(".").pop()?.toLowerCase() || "";
  const testFileName = primaryFile.replace(
    /\.\w+$/,
    `.test.${ext === "tsx" || ext === "jsx" ? "tsx" : ext}`,
  );

  const outDir = p.outputDir();
  const testPath = path.join(outDir, testFileName);

  if (!fs.existsSync(testPath)) {
    await p.log(
      "TDD",
      `No test file (${testFileName}) found — skipping test-based QA`,
    );
    return false;
  }

  const codePath = path.join(outDir, primaryFile);
  if (!fs.existsSync(codePath)) {
    await p.log(
      "TDD",
      `No code file (${primaryFile}) — skipping test-based QA`,
    );
    return false;
  }

  await p.log("TDD", "Running tests...");

  // Fix import in test file to match the component's actual export name
  await fixTestImport(p, primaryFile);

  // Reconcile placeholder/button text in test to match what the component actually renders
  reconcileTestPlaceholders(p, primaryFile);

  let testResult = runTests(p.projectId, testFileName);

  // If vitest crashed (bad test syntax, missing import), try to repair the test file
  if (testResult.crashed) {
    await p.log(
      "TDD",
      `Tests crashed: ${testResult.crashError || "unknown error"}`,
    );

    const repaired = await repairTestFile(p, testResult, primaryFile);
    if (repaired) {
      testResult = runTests(p.projectId, testFileName);
    }

    if (testResult.crashed) {
      await p.log(
        "TDD",
        "Tests still crashing after repair — removing bad test file",
      );
      // Remove the bad test file so it doesn't interfere
      if (fs.existsSync(testPath)) fs.unlinkSync(testPath);
      return false;
    }
  }

  await p.log(
    "TDD",
    `Initial results: ${testResult.passed} passed, ${testResult.failed} failed, ${testResult.total} total`,
  );

  if (testResult.total === 0 && !testResult.crashed) {
    await p.log(
      "TDD",
      "0 tests ran — test file has import/parse errors. Falling back to LLM QA.",
    );
    return false;
  }

  if (testResult.failed === 0) {
    await p.log("TDD", "All tests passing!");
    return true;
  }

  // Fix failures one at a time
  let round = 0;
  // Track how many times repairSingleTest has been called for each test name.
  // Once a test has been through MAX_TEST_REPAIR_ATTEMPTS repairs without
  // resolving, drop it rather than looping indefinitely.
  const testRepairCount = new Map<string, number>();
  // Track consecutive validation failures per test: if the developer keeps
  // producing syntactically-broken code for the same test, the test itself
  // might be impossible — trigger repairSingleTest instead of spinning.
  const validationFailStreak = new Map<string, number>();
  // Track the auto-repair signature from the previous round. If the same
  // auto-repair fix fires two rounds in a row, the model is stuck in a
  // repeating pattern (e.g. always emitting a trailing brace). Burning 5
  // rounds × 40s on the same mistake is the worst-case time sink — break
  // early and let outer QA passes pick up the slack.
  let lastAutoRepairSig: string | null = null;
  let autoRepairRepeatCount = 0;
  while (round < MAX_TEST_FIX_ROUNDS && !p.aborted) {
    round++;

    const failure = getFirstFailure(testResult);
    if (!failure) {
      await p.log("TDD", "All tests passing!");
      break;
    }

    await p.log(
      "TDD",
      `Round ${round}/${MAX_TEST_FIX_ROUNDS}: fixing "${failure.name}"`,
    );
    await p.log(
      "TDD",
      `Error: ${failure.error?.slice(0, 300) || "unknown"}`,
    );

    // Read current code file
    const currentComponent = fs.readFileSync(
      path.join(outDir, primaryFile),
      "utf-8",
    );
    const currentTest = fs.readFileSync(testPath, "utf-8");

    // Build fix prompt — truncated code + only the failing test + error
    // Small models struggle with huge prompts; keep it focused.
    const truncatedComponent = truncateForPrompt(currentComponent, 100);
    const relevantTest = extractRelevantTest(currentTest, failure.name);

    let userMessage = `Project: ${p.projectName} — ${p.projectDescription}\n\n`;
    userMessage += `Current ${primaryFile}:\n${truncatedComponent}\n\n`;
    userMessage += `Failing test (DO NOT MODIFY TESTS — fix the code):\n${relevantTest}\n\n`;
    userMessage += `FAILING TEST: "${failure.name}"\n`;
    userMessage += `ERROR:\n${(failure.error || "Test failed").slice(0, 500)}\n\n`;
    userMessage += `Fix the ${primaryFile} so this test passes. Output the COMPLETE ${primaryFile}.`;

    userMessage = p.withCustomInstructions(userMessage);
    p.warnIfPromptTooLarge(`TDD fix round ${round}`, userMessage);

    const devResult = await runDeveloper(
      p.model,
      userMessage,
      primaryFile,
    );

    if (!devResult.block) {
      await p.log(
        "TDD",
        `Round ${round}: Developer parse failure — skipping`,
        undefined,
        devResult.prompt,
        devResult.raw,
      );
      // If the component can't be fixed, maybe the test is bad — try fixing the test
      const testFixed = await repairSingleTest(p, 
        failure,
        currentComponent,
        currentTest,
        primaryFile,
      );
      if (testFixed) {
        testResult = runTests(p.projectId, testFileName);
        continue;
      }
      break;
    }

    const { repaired, fixes } = autoRepairOutput(
      devResult.block.output,
      primaryFile,
    );
    if (fixes.length > 0) {
      await p.log("TDD", `Auto-repaired: ${fixes.join(", ")}`);
      // Repeat-signature short-circuit: if the same auto-repair fired
      // last round, the model is stuck in a loop producing the same
      // structural mistake. Break out — outer QA passes are cheaper
      // than another 4 rounds × ~40s of identical failure.
      const sig = fixes.join("|");
      if (sig === lastAutoRepairSig) {
        autoRepairRepeatCount++;
        if (autoRepairRepeatCount >= 1) {
          await p.log(
            "TDD",
            `Round ${round}: same auto-repair fired twice in a row (${sig.slice(0, 60)}) — short-circuiting TDD repair loop`,
          );
          break;
        }
      } else {
        lastAutoRepairSig = sig;
        autoRepairRepeatCount = 0;
      }
    } else {
      lastAutoRepairSig = null;
      autoRepairRepeatCount = 0;
    }

    const validation = validateOutput(repaired, primaryFile);
    if (!validation.valid) {
      await p.log(
        "TDD",
        `Round ${round}: Fix failed validation: ${validation.reason}`,
        undefined,
        devResult.prompt,
        devResult.raw,
      );
      // Track consecutive validation failures for this test. After 2 failures
      // the developer is stuck — the test might be impossible. Try repairing
      // the test instead of continuing to generate broken component code.
      const streak = (validationFailStreak.get(failure.name) ?? 0) + 1;
      validationFailStreak.set(failure.name, streak);
      if (streak >= 2) {
        const repairs = testRepairCount.get(failure.name) ?? 0;
        if (repairs < MAX_TEST_REPAIR_ATTEMPTS) {
          testRepairCount.set(failure.name, repairs + 1);
          validationFailStreak.set(failure.name, 0); // reset streak after repair
          const testFixed = await repairSingleTest(p, 
            failure,
            currentComponent,
            fs.readFileSync(testPath, "utf-8"),
            primaryFile,
          );
          if (testFixed) {
            testResult = runTests(p.projectId, testFileName);
            if (testResult.failed === 0) break;
          }
        }
      }
      continue;
    }
    // Reset streak on a valid fix attempt
    validationFailStreak.set(failure.name, 0);

    // Write the fixed code and re-run tests
    await p.writeOutputFile(primaryFile, repaired);
    const newResult = runTests(p.projectId, testFileName);

    if (newResult.crashed) {
      await p.log(
        "TDD",
        `Round ${round}: Tests crashed after fix — reverting`,
      );
      await p.writeOutputFile(primaryFile, currentComponent);
      // The test might have wrong expectations. Try repairing it, but only
      // up to MAX_TEST_REPAIR_ATTEMPTS times per test name to avoid spinning.
      const repairs = testRepairCount.get(failure.name) ?? 0;
      if (repairs < MAX_TEST_REPAIR_ATTEMPTS) {
        testRepairCount.set(failure.name, repairs + 1);
        // Re-read the test after the crash (it may have been modified by the failed fix)
        const freshTestCode = fs.readFileSync(testPath, "utf-8");
        const testFixed = await repairSingleTest(p, 
          failure,
          currentComponent,
          freshTestCode,
          primaryFile,
        );
        if (testFixed) {
          testResult = runTests(p.projectId, testFileName);
          continue;
        }
      } else {
        await p.log(
          "TDD",
          `Test "${failure.name}" repair limit reached — dropping`,
        );
      }
      testResult.tests = testResult.tests.filter(
        (t) => t.name !== failure.name,
      );
      continue;
    }

    if (newResult.failed < testResult.failed) {
      await p.log(
        "TDD",
        `Round ${round}: Fixed! ${newResult.passed} passed, ${newResult.failed} failed`,
        undefined,
        devResult.prompt,
        devResult.raw,
      );
      testResult = newResult;
    } else if (newResult.failed >= testResult.failed) {
      // Fix didn't help or made things worse
      await p.log(
        "TDD",
        `Round ${round}: Fix didn't reduce failures (was ${testResult.failed}, now ${newResult.failed})`,
        undefined,
        devResult.prompt,
        devResult.raw,
      );
      // If the same test is still failing after component fix attempts,
      // the test itself might be wrong — repair it (capped per test name)
      const sameTestStillFailing = newResult.tests.find(
        (t) => t.name === failure.name && t.status === "fail",
      );
      if (round >= 2 && sameTestStillFailing) {
        const repairs = testRepairCount.get(failure.name) ?? 0;
        if (repairs < MAX_TEST_REPAIR_ATTEMPTS) {
          testRepairCount.set(failure.name, repairs + 1);
          // Use fresh error from the latest run and fresh test content
          const latestFailure = sameTestStillFailing as {
            name: string;
            error?: string;
          };
          const testFixed = await repairSingleTest(p, 
            latestFailure,
            repaired,
            fs.readFileSync(testPath, "utf-8"),
            primaryFile,
          );
          if (testFixed) {
            testResult = runTests(p.projectId, testFileName);
            continue;
          }
        } else {
          await p.log(
            "TDD",
            `Test "${failure.name}" repair limit reached — dropping`,
          );
          newResult.tests = newResult.tests.filter(
            (t) => t.name !== failure.name,
          );
        }
      }
      testResult = newResult;
    }

    if (testResult.failed === 0) break;
  }

  if (round >= MAX_TEST_FIX_ROUNDS && testResult.failed > 0) {
    await p.log(
      "TDD",
      `Hit max fix rounds (${MAX_TEST_FIX_ROUNDS}) with ${testResult.failed} still failing`,
    );
    // Store failure for iterativeQA so it can focus on the same root cause
    const firstFail = getFirstFailure(testResult);
    if (firstFail) {
      p.lastTestFailure = `Test: "${firstFail.name}"\nError: ${(firstFail.error || "").slice(0, 300)}`;
    }
  }

  await p.log(
    "TDD",
    `Test QA complete: ${testResult.passed}/${testResult.total} passing after ${round} rounds`,
  );

  return testResult.failed === 0;
}

/**
 * Reconcile getByPlaceholderText() and getByRole('button', {name:...}) calls in the test
 * with what the component actually renders. Replaces guessed values with actual ones.
 */
export function reconcileTestPlaceholders(p: Pipeline, targetFile: string): void {
  const ext = targetFile.split(".").pop()?.toLowerCase() || "";
  const testFileName = targetFile.replace(
    /\.\w+$/,
    `.test.${ext === "tsx" || ext === "jsx" ? "tsx" : ext}`,
  );

  const outDir = p.outputDir();
  const testPath = path.join(outDir, testFileName);
  const codePath = path.join(outDir, targetFile);

  if (!fs.existsSync(testPath) || !fs.existsSync(codePath)) return;

  const codeContent = fs.readFileSync(codePath, "utf-8");
  let testContent = fs.readFileSync(testPath, "utf-8");

  let changed = false;

  // 1. Extract actual placeholder values from the component
  const placeholderMatches = [
    ...codeContent.matchAll(/placeholder=["']([^"']{3,})["']/g),
  ];
  const actualPlaceholders = placeholderMatches.map((m) => m[1]);

  if (actualPlaceholders.length > 0) {
    // Replace any getByPlaceholderText(/regex/i) or getByPlaceholderText("string") with
    // the actual first placeholder from the component
    const actual = actualPlaceholders[0];
    const patched = testContent.replace(
      /getByPlaceholderText\(\s*(?:\/[^/]+\/[ig]*|["'][^"']*["'])\s*\)/g,
      () => `getByPlaceholderText("${actual}")`,
    );
    if (patched !== testContent) {
      testContent = patched;
      changed = true;
    }
  }

  if (changed) {
    fs.writeFileSync(testPath, testContent, "utf-8");
  }
}

/**
 * Fix the test file import to match the code's actual exported function name.
 * The test-writer might import "Component" but the actual export could be different.
 */
export async function fixTestImport(p: Pipeline, targetFile?: string) {
  const primaryFile =
    targetFile || p.manifest.find((f) => supportsTDD(f.path))?.path;
  if (!primaryFile) return;

  const ext = primaryFile.split(".").pop()?.toLowerCase() || "";
  const testFileName = primaryFile.replace(
    /\.\w+$/,
    `.test.${ext === "tsx" || ext === "jsx" ? "tsx" : ext}`,
  );
  const baseName = primaryFile.replace(/\.\w+$/, "");

  const outDir = p.outputDir();
  const testPath = path.join(outDir, testFileName);
  const codePath = path.join(outDir, primaryFile);

  if (!fs.existsSync(testPath) || !fs.existsSync(codePath)) return;

  const codeContent = fs.readFileSync(codePath, "utf-8");
  const testCode = fs.readFileSync(testPath, "utf-8");

  // Detect the actual export name from the code
  const exportMatch = codeContent.match(
    /export\s+default\s+function\s+(\w+)/,
  );
  if (!exportMatch) return; // Can't determine — leave as is

  const actualName = exportMatch[1];

  // Fix the import in the test file
  // Replace: import X from "./BaseName" → import ActualName from "./BaseName"
  let fixed = testCode
    .replace(
      new RegExp(
        `import\\s+(\\w+)\\s+from\\s+["']\\.\/${baseName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`,
        "g",
      ),
      `import ${actualName} from "./${baseName}"`,
    )
    .replace(
      new RegExp(
        `import\\s+\\{\\s*(\\w+)\\s*\\}\\s+from\\s+["']\\.\/${baseName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`,
        "g",
      ),
      `import ${actualName} from "./${baseName}"`,
    );

  // Replace usage of the old name with the new one
  const importMatch = testCode.match(
    new RegExp(
      `import\\s+(\\w+)\\s+from\\s+["']\\.\/${baseName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`,
    ),
  );
  if (importMatch && importMatch[1] !== actualName) {
    const oldName = importMatch[1];
    const lines = fixed.split("\n");
    fixed = lines
      .map((line) => {
        if (line.match(/^\s*import\s/)) return line;
        return line.replace(new RegExp(`\\b${oldName}\\b`, "g"), actualName);
      })
      .join("\n");
  }

  if (fixed !== testCode) {
    fs.writeFileSync(testPath, fixed, "utf-8");
    await p.log("TDD", `Fixed test import: using ${actualName}`);
  }
}

/**
 * Repair the test file when vitest crashes (syntax error, bad import, etc.).
 * Sends the crash error + test file to the LLM to fix.
 */
export async function repairTestFile(
  p: Pipeline,
  crashResult: TestRunResult,
  targetFile?: string,
): Promise<boolean> {
  const primaryFile =
    targetFile || p.manifest.find((f) => supportsTDD(f.path))?.path;
  if (!primaryFile) return false;

  const ext = primaryFile.split(".").pop()?.toLowerCase() || "";
  const testFileName = primaryFile.replace(
    /\.\w+$/,
    `.test.${ext === "tsx" || ext === "jsx" ? "tsx" : ext}`,
  );
  const baseName = primaryFile.replace(/\.\w+$/, "");
  const isTSX = ext === "tsx" || ext === "jsx";

  const outDir = p.outputDir();
  const testPath = path.join(outDir, testFileName);

  if (!fs.existsSync(testPath)) return false;

  const testCode = fs.readFileSync(testPath, "utf-8");
  const codeContent = fs.existsSync(path.join(outDir, primaryFile))
    ? fs.readFileSync(path.join(outDir, primaryFile), "utf-8")
    : "";

  for (
    let attempt = 1;
    attempt <= MAX_TEST_REPAIR_ATTEMPTS;
    attempt++
  ) {
    await p.log("TDD", `Repairing test file (attempt ${attempt})...`);

    const REPAIR_PROMPT = `Fix this broken test file. It crashes when run with vitest.
Rules:
- Use vitest imports: import { describe, it, expect } from "vitest"
${
isTSX
  ? `- Use @testing-library/react: import { render, screen, fireEvent } from "@testing-library/react"
- Import the component with default import from "./${baseName}"`
  : `- Import the module from "./${baseName}"`
}
- Keep tests simple. No mocking.
- Output ONLY code. No explanations.

Reply:
>>RESULT
status: DONE
filePath: ${testFileName}
output: |
  (fixed test code)
>>END`;

    let userMessage = `The test file crashes with this error:\n${(crashResult.crashError || crashResult.rawOutput.slice(0, 500)).slice(0, 500)}\n\n`;
    userMessage += `Current test file:\n${truncateForPrompt(testCode, 60)}\n\n`;
    if (codeContent) {
      const exportLine =
        codeContent.match(/export\s+default\s+function\s+\w+[^{]*/)?.[0] ||
        "";
      userMessage += `Code export: ${exportLine}\n\n`;
    }
    userMessage += `Fix the test file so it runs without crashing.`;

    const result = await callOllamaFn(
      p.model,
      "qa",
      REPAIR_PROMPT,
      userMessage,
    );

    const parsed = parseTTM(result.text);
    const block =
      parsed && "output" in parsed ? (parsed as { output: string }) : null;

    if (!block) {
      await p.log(
        "TDD",
        `Repair attempt ${attempt}: parse failure`,
        undefined,
        result.prompt,
        result.text,
      );
      continue;
    }

    const { repaired } = autoRepairOutput(block.output, testFileName);
    fs.writeFileSync(testPath, repaired, "utf-8");

    // Try running tests again
    const retryResult = runTests(p.projectId, testFileName);
    if (!retryResult.crashed) {
      await p.log("TDD", "Test file repaired successfully");
      return true;
    }

    await p.log(
      "TDD",
      `Repair attempt ${attempt}: still crashing — ${retryResult.crashError}`,
    );
  }

  return false;
}

/**
 * When a single test keeps failing after component fixes,
 * the test itself might be wrong. Remove or fix it.
 *
 * Escalation strategy (inspired by stuck-detection in autonomous loops):
 *   1st call  → patch mode: fix the specific assertion, keep other tests
 *   2nd call with same error → rewrite mode: rewrite the whole failing test
 *                              block with roles tree prominently featured
 *   3rd call (still stuck)  → regenerate: discard test file, call
 *                              generateTests() from scratch (capped at 1)
 *
 * "If the same evidence appears twice in a row, you have nothing new to act
 *  on — escalate, don't repeat." (autonomous loop check pattern)
 */
export async function repairSingleTest(
  p: Pipeline,
  failure: { name: string; error?: string },
  componentCode: string,
  testCode: string,
  targetFile?: string,
): Promise<boolean> {
  const primaryFile =
    targetFile || p.manifest.find((f) => supportsTDD(f.path))?.path;
  if (!primaryFile) return false;

  const ext = primaryFile.split(".").pop()?.toLowerCase() || "";
  const testFileName = primaryFile.replace(
    /\.\w+$/,
    `.test.${ext === "tsx" || ext === "jsx" ? "tsx" : ext}`,
  );

  const outDir = p.outputDir();
  const testPath = path.join(outDir, testFileName);

  // ── Stuck detection ──────────────────────────────────────────────────────
  // Hash the first 300 chars of the error (enough to distinguish different
  // failures, short enough to avoid false mismatches from pointer addresses).
  const errorFingerprint = (failure.error || "").slice(0, 300);
  const lastError = p.lastRepairError.get(failure.name);
  const isStuck = lastError !== undefined && lastError === errorFingerprint;
  p.lastRepairError.set(failure.name, errorFingerprint);

  // ── Regenerate path (3rd attempt, same error) ────────────────────────────
  if (isStuck) {
    const regenCount = p.regenerateCount.get(failure.name) ?? 0;
    if (regenCount >= 1) {
      await p.log(
        "TDD",
        `Test "${failure.name}" stuck after rewrite — dropping test`,
      );
      return false;
    }
    p.regenerateCount.set(failure.name, regenCount + 1);
    await p.log(
      "TDD",
      `Test "${failure.name}" still failing with same error — regenerating test file from scratch`,
    );
    await generateTests(p, 
      p.lastGenerateRequirements,
      primaryFile,
      p.lastGenerateManifestDescription,
    );
    const regenResult = runTests(p.projectId, testFileName);
    if (!regenResult.crashed && regenResult.failed === 0) {
      await p.log("TDD", "Regenerated test file passes");
      // Update repair tracking so the next call doesn't think we're still stuck
      p.lastRepairError.delete(failure.name);
      return true;
    }
    await p.log(
      "TDD",
      `Regenerated tests: ${regenResult.passed} passed, ${regenResult.failed} failed`,
    );
    return regenResult.failed === 0;
  }

  // ── Mode selection ───────────────────────────────────────────────────────
  // rewriteMode = we've been here before (lastError was set but different, or
  // this is a second repair attempt). Determined by whether lastError existed.
  const rewriteMode = lastError !== undefined;
  await p.log(
    "TDD",
    `Test "${failure.name}" may be wrong — attempting ${rewriteMode ? "full rewrite" : "patch"} repair`,
  );

  // Extract UI hints from the component so the model can fix wrong queries
  // (e.g. getByRole("button", {name: /delete/i}) when the button says "×").
  const componentHints: string[] = [];
  const btnMatches =
    componentCode.match(/<button[^>]*>([^<]*)<\/button>/g) ?? [];
  btnMatches.forEach((m) => {
    const text = m.replace(/<[^>]+>/g, "").trim();
    if (text) componentHints.push(`button text: "${text}"`);
  });
  const ariaLabels =
    componentCode.match(/aria-label=["']([^"']+)["']/g) ?? [];
  ariaLabels.forEach((m) => componentHints.push(m));
  const placeholders =
    componentCode.match(/placeholder=["']([^"']+)["']/g) ?? [];
  placeholders.forEach((m) => componentHints.push(m));
  // Extract text+element patterns (e.g. <p>Label: <strong>{val}</strong></p>)
  // so the repair model knows text is split and cannot be matched by getByText.
  const splitTextPatterns =
    componentCode.match(
      /<(?:p|span|div|h[1-6])[^>]*>[^<]+<(?:strong|span|em|b)[^>]*>/g,
    ) ?? [];
  splitTextPatterns.forEach((m) => {
    const label = m.replace(/<[^>]+>/g, "").trim();
    if (label)
      componentHints.push(
        `split text (label + child element): "${label}..."`,
      );
  });

  // Detect the specific split-text error to give a targeted hint
  const isSplitTextError = (failure.error || "").includes(
    "broken up by multiple elements",
  );

  // Extract what text the test was searching for and find actual text patterns in the component
  let textMismatchHint = "";
  if (isSplitTextError) {
    const searchedMatch =
      /Unable to find an element with the text:\s*([^\n.]+)/i.exec(
        failure.error || "",
      );
    const searchedText = searchedMatch?.[1]?.trim();
    if (searchedText) {
      // Look for the searched label in JSX text patterns like {label} {value} {suffix}
      // e.g. searched "Streak: 12" → component has "Streak: {localStreak} days" → hint: "Streak: X days"
      const labelPrefix = searchedText.replace(/[:]\s*\S+.*$/, "").trim();
      if (labelPrefix) {
        // Find JSX that starts with this label prefix
        const jsxPattern = new RegExp(
          `(${labelPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^<"'\`\n]{1,40})`,
          "i",
        );
        const jsxMatch = jsxPattern.exec(componentCode);
        if (jsxMatch) {
          // Replace template literal expressions like {foo} with "X"
          const exampleText = jsxMatch[1]
            .replace(/\{[^}]+\}/g, "X")
            .replace(/\s+/g, " ")
            .trim();
          textMismatchHint = `\n- The test searched for "${searchedText}" but the component likely renders "${exampleText}". Use the correct text format.`;
        }
      }
    }
  }

  // ── Prompt assembly ──────────────────────────────────────────────────────
  // Extract roles tree first so we know prompt weight before choosing limits.
  const rolesTree = extractRolesTree(failure.error || "");

  // Prompt size guard: small models (~4k context) degrade when the prompt is
  // bloated. Estimate token count as chars/4. If the combined context would
  // exceed ~2000 tokens (8000 chars) for component + test alone, tighten
  // the truncation limits so the actual failure gets more of the budget.
  // Roles tree + error slice always included at full size.
  const rolesTreeLen = rolesTree ? rolesTree.length : 0;
  const errorLen = Math.min((failure.error || "").length, 2000);
  const contextBudgetChars = 8000 - rolesTreeLen - errorLen;
  const componentMaxLines = contextBudgetChars > 4000 ? 40 : 20;
  const testMaxLines = contextBudgetChars > 4000 ? 60 : 20;
  if (componentMaxLines < 40 || testMaxLines < 60) {
    await p.log(
      "TDD",
      `Prompt size guard active — trimming component to ${componentMaxLines} lines, test to ${testMaxLines} lines`,
    );
  }

  const REPAIR_PROMPT = rewriteMode
    ? `A test in this file has failed multiple times and could not be fixed by changing the component code.
Rewrite the ENTIRE failing test block so it tests the actual rendered output.
- Use only accessible roles and names you can see in the "Actual accessible roles" section.
- If there is no accessible name for a button, use getByRole('button') without a name option.
- Do NOT use getByText() for text that mixes static labels with dynamic values — use regex or getByRole.
- If the test is impossible to write correctly, remove it entirely.
- Keep all other passing tests unchanged.
- Output ONLY code. No explanations.

Reply:
>>RESULT
status: DONE
filePath: ${testFileName}
output: |
  (rewritten test file)
>>END`
    : `One test in this file always fails, even after multiple attempts to fix the code.
The test assertions are probably wrong — they reference UI elements that don't exist as written.
Fix the test so it correctly tests the actual behavior of the component.
If the test is testing something impossible, remove it.
- Output ONLY code. No explanations.
- Keep all other tests unchanged.${
        isSplitTextError
          ? `
- CRITICAL: The error says text is "broken up by multiple elements" — but this message appears for ANY text-not-found error. The real issue is that the searched text does not exactly match what the component renders. Check the component code for the actual rendered text.${textMismatchHint}
- If text like "Streak: X days" is spread across child elements, use a regex: getByText(/Streak: \\d+ days/i) or check by role instead.
- Do NOT use getByText() for any text that mixes a static label with a dynamic value unless you use a flexible regex.`
          : ""
      }

Reply:
>>RESULT
status: DONE
filePath: ${testFileName}
output: |
  (fixed test code)
>>END`;

  let userMessage = `Failing test: "${failure.name}"\n`;
  userMessage += `Error: ${(failure.error || "unknown").slice(0, 2000)}\n\n`;

  // Extract the vitest accessible-roles tree if present — this is the actual DOM
  // structure that testing-library sees, produced automatically when getByRole/
  // getByText/etc. fails. It tells the model exactly what roles and names exist.
  if (rolesTree) {
    userMessage += `Actual accessible roles when component renders:\n${rolesTree}\n\n`;
    userMessage += `Use only roles and names that appear in the tree above. Do NOT query for names that are not listed.\n\n`;
  }

  if (componentHints.length > 0) {
    userMessage += `Additional UI hints extracted from component source:\n${componentHints.map((h) => `  - ${h}`).join("\n")}\n\n`;
  }
  userMessage += `Component code (key exports):\n${truncateForPrompt(componentCode, componentMaxLines)}\n\n`;
  userMessage += `Current test file:\n${truncateForPrompt(testCode, testMaxLines)}\n\n`;
  userMessage += `Fix or remove the failing test. Keep all passing tests.`;

  const result = await callOllamaFn(
    p.model,
    "qa",
    REPAIR_PROMPT,
    userMessage,
  );

  const parsed = parseTTM(result.text);
  const block =
    parsed && "output" in parsed ? (parsed as { output: string }) : null;

  if (!block) {
    await p.log(
      "TDD",
      "Test repair: parse failure",
      undefined,
      result.prompt,
      result.text,
    );
    return false;
  }

  const { repaired } = autoRepairOutput(block.output, testFileName);
  fs.writeFileSync(testPath, repaired, "utf-8");

  const retryResult = runTests(p.projectId, testFileName);
  if (retryResult.crashed) {
    // Repair made things worse — restore original
    fs.writeFileSync(testPath, testCode, "utf-8");
    await p.log("TDD", "Test repair made things worse — reverted");
    return false;
  }

  // Only claim success if the specific failing test is now passing.
  // A non-crashing but still-failing test is not a successful repair.
  const stillFailing = retryResult.tests.find(
    (t) => t.name === failure.name && t.status === "fail",
  );
  if (stillFailing) {
    await p.log(
      "TDD",
      `Test repair ${rewriteMode ? "(rewrite)" : "(patch)"} ran but test still fails`,
    );
    // Update the error fingerprint so the next call sees new evidence
    // (the repaired output may produce a different error)
    const newFingerprint = (stillFailing.error || "").slice(0, 300);
    p.lastRepairError.set(failure.name, newFingerprint);
    return false;
  }

  await p.log(
    "TDD",
    `Test repair ${rewriteMode ? "(rewrite)" : "(patch)"} succeeded`,
  );
  return true;
}
