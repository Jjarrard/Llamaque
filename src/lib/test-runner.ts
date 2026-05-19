/**
 * Test Runner — executes vitest against generated component tests.
 *
 * Runs: npx vitest run --reporter=json output/{projectId}/Component.test.tsx
 * Parses the JSON output to extract pass/fail per test.
 *
 * Used by the pipeline for TDD:
 *   1. After test generation — verify tests are syntactically valid
 *   2. After code generation — run tests, fix failures one at a time
 *   3. After feedback — re-run tests to confirm fixes didn't break things
 */

import { execSync } from "child_process";
import path from "path";
import fs from "fs";

export interface TestResult {
  name: string;
  status: "pass" | "fail";
  error?: string;
  duration?: number;
}

export interface TestRunResult {
  passed: number;
  failed: number;
  total: number;
  tests: TestResult[];
  /** Raw stderr/stdout for logging */
  rawOutput: string;
  /** True if vitest itself crashed (bad syntax, missing import, etc.) */
  crashed: boolean;
  crashError?: string;
}

/**
 * Run vitest against a specific project's test file.
 * Returns structured results with per-test pass/fail info.
 *
 * @param projectId   - project whose output/ directory to use
 * @param testFileName - filename of the test file (e.g. "main.test.tsx");
 *                       defaults to "Component.test.tsx" for backward compat
 */
export function runTests(
  projectId: number,
  testFileName: string = "Component.test.tsx",
): TestRunResult {
  const outputDir = path.join(process.cwd(), "output", String(projectId));
  const testFile = path.join(outputDir, testFileName);

  if (!fs.existsSync(testFile)) {
    return {
      passed: 0,
      failed: 0,
      total: 0,
      tests: [],
      rawOutput: `No test file found (${testFileName})`,
      crashed: false,
    };
  }

  // Derive companion code file by stripping ".test." from the name
  const codeFileName = testFileName.replace(/\.test\.([^.]+)$/, ".$1");
  const componentFile = path.join(outputDir, codeFileName);
  if (!fs.existsSync(componentFile)) {
    return {
      passed: 0,
      failed: 0,
      total: 0,
      tests: [],
      rawOutput: "No Component.tsx found — nothing to test",
      crashed: false,
    };
  }

  const vitestBin = path.join(process.cwd(), "node_modules", ".bin", "vitest");
  const configFile = path.join(process.cwd(), "vitest.config.mts");

  // Run vitest with JSON reporter for structured output
  // Use --run to avoid watch mode, --reporter=json for parseable output
  const cmd = `"${vitestBin}" run --config "${configFile}" --reporter=json "${testFile}" 2>&1`;

  let rawOutput: string;
  let exitCode: number;

  try {
    rawOutput = execSync(cmd, {
      cwd: process.cwd(),
      encoding: "utf-8",
      timeout: 60_000, // 60s timeout
      env: {
        ...process.env,
        NODE_ENV: "test",
      },
    });
    exitCode = 0;
  } catch (err: unknown) {
    const execErr = err as {
      status?: number;
      stdout?: string;
      stderr?: string;
      output?: string[];
    };
    exitCode = execErr.status ?? 1;
    rawOutput =
      execErr.stdout ||
      execErr.stderr ||
      (execErr.output || []).join("\n") ||
      String(err);
  }

  // Try to parse JSON from the output
  // vitest JSON reporter outputs a JSON object — find it in the output
  const jsonMatch = rawOutput.match(/\{[\s\S]*"testResults"[\s\S]*\}/);
  if (!jsonMatch) {
    // vitest crashed before producing JSON — syntax error, import error, etc.
    return {
      passed: 0,
      failed: 0,
      total: 0,
      tests: [],
      rawOutput: rawOutput.slice(0, 3000),
      crashed: true,
      crashError: extractCrashError(rawOutput),
    };
  }

  try {
    const json = JSON.parse(jsonMatch[0]);
    return parseVitestJson(json, rawOutput);
  } catch {
    return {
      passed: 0,
      failed: 0,
      total: 0,
      tests: [],
      rawOutput: rawOutput.slice(0, 3000),
      crashed: true,
      crashError: "Failed to parse vitest JSON output",
    };
  }
}

/**
 * Parse vitest JSON reporter output into structured test results.
 */
function parseVitestJson(
  json: VitestJsonOutput,
  rawOutput: string,
): TestRunResult {
  const tests: TestResult[] = [];

  for (const suite of json.testResults || []) {
    // If the suite has a collection-time error with no assertion results,
    // surface it as a crash so repairTestFile() can fix it.
    if (
      suite.testExecError &&
      (!suite.assertionResults || suite.assertionResults.length === 0)
    ) {
      const errMsg =
        suite.testExecError.message ||
        suite.testExecError.stack ||
        "Suite execution error";
      return {
        passed: 0,
        failed: 0,
        total: 0,
        tests: [],
        rawOutput: rawOutput.slice(0, 3000),
        crashed: true,
        crashError: errMsg.slice(0, 500),
      };
    }
    for (const test of suite.assertionResults || []) {
      const name = test.ancestorTitles
        ? [...test.ancestorTitles, test.title].join(" > ")
        : test.title;

      tests.push({
        name,
        status: test.status === "passed" ? "pass" : "fail",
        error:
          test.failureMessages && test.failureMessages.length > 0
            ? test.failureMessages.join("\n").slice(0, 1000)
            : undefined,
        duration: test.duration,
      });
    }
  }

  const passed = tests.filter((t) => t.status === "pass").length;
  const failed = tests.filter((t) => t.status === "fail").length;

  return {
    passed,
    failed,
    total: tests.length,
    tests,
    rawOutput: rawOutput.slice(0, 3000),
    crashed: false,
  };
}

/**
 * Extract a readable error message from a vitest crash.
 */
function extractCrashError(output: string): string {
  // Look for common error patterns
  const patterns = [
    /SyntaxError:.*$/m,
    /ReferenceError:.*$/m,
    /TypeError:.*$/m,
    /Error:.*$/m,
    /Cannot find module.*$/m,
    /Failed to resolve import.*$/m,
  ];

  for (const pattern of patterns) {
    const match = output.match(pattern);
    if (match) return match[0].slice(0, 500);
  }

  // Grab last few meaningful lines
  const lines = output
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .slice(-5);
  return lines.join("\n").slice(0, 500);
}

/**
 * Get the first N failing tests for targeted fixing.
 */
export function getFirstFailure(result: TestRunResult): TestResult | null {
  return result.tests.find((t) => t.status === "fail") || null;
}

// ── vitest JSON reporter types ──

interface VitestJsonOutput {
  testResults?: VitestSuiteResult[];
  numPassedTests?: number;
  numFailedTests?: number;
  numTotalTests?: number;
}

interface VitestSuiteResult {
  assertionResults?: VitestTestResult[];
  name?: string;
  testExecError?: { message?: string; stack?: string } | null;
  status?: string;
}

interface VitestTestResult {
  ancestorTitles?: string[];
  title: string;
  status: string;
  failureMessages?: string[];
  duration?: number;
}
