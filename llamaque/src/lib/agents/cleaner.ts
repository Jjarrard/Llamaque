/**
 * Cleaner Agent — extracts valid code from garbled/mixed LLM output.
 *
 * When a model echoes back prompt instructions mixed with code,
 * the cleaner tries to salvage the usable code content.
 */

import { callOllama } from "@/lib/ollama";
import { parseTTM } from "@/lib/protocol";
import { autoRepairOutput } from "@/lib/validate";

const CLEANER_SYSTEM_PROMPT = `You are a code extractor. The user will give you messy text that contains a mix of instructions, explanations, and actual code. Your job is to extract ONLY the valid code and return it.

Rules:
- Extract ONLY actual code — no instructions, no explanations, no numbered steps
- If there are multiple code blocks, combine them into one coherent file
- If no usable code exists, write a minimal valid implementation based on any context clues
- Output ONLY code. No markdown fences. No commentary.

Reply format:
>>RESULT
status: DONE
filePath: {filename}
output: |
  (extracted code only)
>>END`;

export interface CleanerResult {
  cleaned: string | null;
  tokens: number;
  durationMs: number;
  prompt: string;
  raw: string;
}

/**
 * Attempt to extract valid code from garbled LLM output.
 * Uses the LLM itself as a "filter" to separate code from prompt echoes.
 */
export async function runCleaner(
  model: string,
  garbageOutput: string,
  filePath: string,
  projectContext: string,
): Promise<CleanerResult> {
  // Keep the prompt very short — long prompts caused the problem in the first place
  const userMessage = `File: ${filePath}
Project: ${projectContext}

The following text was supposed to be code for ${filePath}, but it contains mixed instructions and code. Extract ONLY the valid code:

---
${garbageOutput.slice(0, 3000)}
---

Return ONLY the extracted code for ${filePath}.`;

  try {
    const result = await callOllama(
      model,
      "editor", // low temperature, deterministic
      CLEANER_SYSTEM_PROMPT,
      userMessage,
    );

    const parsed = parseTTM(result.text);
    if (parsed && "output" in parsed) {
      const block = parsed as { output: string; filePath?: string };
      const { repaired } = autoRepairOutput(block.output, filePath);
      return {
        cleaned: repaired,
        tokens: result.tokens,
        durationMs: result.durationMs,
        prompt: result.prompt,
        raw: result.text,
      };
    }

    // TTM parse failed — try to extract code directly from raw response
    // (the cleaner itself might not follow TTM format perfectly)
    const rawCode = extractCodeFromRaw(result.text, filePath);
    return {
      cleaned: rawCode,
      tokens: result.tokens,
      durationMs: result.durationMs,
      prompt: result.prompt,
      raw: result.text,
    };
  } catch {
    return {
      cleaned: null,
      tokens: 0,
      durationMs: 0,
      prompt: "",
      raw: "",
    };
  }
}

/**
 * Minimal prompt retry — when a full prompt caused echoing,
 * use the absolute minimum prompt to get the model to produce code.
 */
export async function runMinimalRetry(
  model: string,
  filePath: string,
  requirement: string,
  projectName: string,
): Promise<CleanerResult> {
  const ext = filePath.split(".").pop()?.toLowerCase() || "";

  // Extremely short system prompt — no rules, no format examples
  const systemPrompt = `Write code. Output only code. No explanations.

Reply:
>>RESULT
status: DONE
filePath: ${filePath}
output: |
  (code)
>>END`;

  // Extremely short user prompt — just the core ask
  const userMessage = `Write ${filePath} for "${projectName}": ${requirement.slice(0, 300)}`;

  try {
    const result = await callOllama(
      model,
      "developer",
      systemPrompt,
      userMessage,
    );

    const parsed = parseTTM(result.text);
    if (parsed && "output" in parsed) {
      const block = parsed as { output: string };
      const { repaired } = autoRepairOutput(block.output, filePath);
      return {
        cleaned: repaired,
        tokens: result.tokens,
        durationMs: result.durationMs,
        prompt: result.prompt,
        raw: result.text,
      };
    }

    const rawCode = extractCodeFromRaw(result.text, filePath);
    return {
      cleaned: rawCode,
      tokens: result.tokens,
      durationMs: result.durationMs,
      prompt: result.prompt,
      raw: result.text,
    };
  } catch {
    return {
      cleaned: null,
      tokens: 0,
      durationMs: 0,
      prompt: "",
      raw: "",
    };
  }
}

/**
 * Scaffold tactic — ask for just the structure/skeleton, then fill it in.
 * Two calls, each simple enough that the model is unlikely to get confused.
 */
export async function runScaffoldTactic(
  model: string,
  filePath: string,
  requirement: string,
  projectName: string,
): Promise<CleanerResult> {
  const ext = filePath.split(".").pop()?.toLowerCase() || "";

  // Phase 1: ask for skeleton only
  const skeletonSystem = `You write code skeletons. Output only code with stub implementations (comments or placeholder returns). No explanations.\n\nReply:\n>>RESULT\nstatus: DONE\nfilePath: ${filePath}\noutput: |\n  (skeleton code)\n>>END`;

  const skeletonUser = `Write the skeleton/structure for ${filePath} in project "${projectName}": imports, function signatures, class outlines. Stubs only. Requirement: ${requirement.slice(0, 200)}`;

  try {
    const skelResult = await callOllama(
      model,
      "editor",
      skeletonSystem,
      skeletonUser,
    );
    let skeleton: string | null = null;

    const skelParsed = parseTTM(skelResult.text);
    if (skelParsed && "output" in skelParsed) {
      skeleton = (skelParsed as { output: string }).output;
    } else {
      skeleton = extractCodeFromRaw(skelResult.text, filePath);
    }

    if (!skeleton || skeleton.trim().length < 20) {
      return {
        cleaned: null,
        tokens: skelResult.tokens,
        durationMs: skelResult.durationMs,
        prompt: skelResult.prompt,
        raw: skelResult.text,
      };
    }

    // Phase 2: fill in the skeleton
    const fillSystem = `You complete code. Given a skeleton, fill in the real implementations. Output the complete file. No explanations.\n\nReply:\n>>RESULT\nstatus: DONE\nfilePath: ${filePath}\noutput: |\n  (complete code)\n>>END`;

    const fillUser = `Complete this skeleton for ${filePath}:\n\n${skeleton.slice(0, 2000)}\n\nFill in all stubs with real working implementations. Output the entire file.`;

    const fillResult = await callOllama(
      model,
      "developer",
      fillSystem,
      fillUser,
    );
    const totalTokens = skelResult.tokens + fillResult.tokens;
    const totalMs = skelResult.durationMs + fillResult.durationMs;

    const fillParsed = parseTTM(fillResult.text);
    if (fillParsed && "output" in fillParsed) {
      const { repaired } = autoRepairOutput(
        (fillParsed as { output: string }).output,
        filePath,
      );
      return {
        cleaned: repaired,
        tokens: totalTokens,
        durationMs: totalMs,
        prompt: fillUser,
        raw: fillResult.text,
      };
    }

    const rawCode = extractCodeFromRaw(fillResult.text, filePath);
    return {
      cleaned: rawCode,
      tokens: totalTokens,
      durationMs: totalMs,
      prompt: fillUser,
      raw: fillResult.text,
    };
  } catch {
    return { cleaned: null, tokens: 0, durationMs: 0, prompt: "", raw: "" };
  }
}

/**
 * Reframe tactic — completely different prompt style.
 * Uses a "file generator" persona with the absolute minimum framing.
 * When instruction-style prompts cause echoing, a roleplay framing can break the pattern.
 */
export async function runReframeTactic(
  model: string,
  filePath: string,
  requirement: string,
  projectName: string,
): Promise<CleanerResult> {
  // Completely different persona and framing style
  const systemPrompt = `You are a file generator. You receive a filename and a brief description. You respond with ONLY the file contents. Nothing else — no explanations, no markdown, no commentary. Just the raw file contents as if opened in an editor.`;

  const userMessage = `Filename: ${filePath}\nProject: ${projectName}\nDescription: ${requirement.slice(0, 250)}\n\nGenerate the file contents:`;

  try {
    const result = await callOllama(model, "editor", systemPrompt, userMessage);

    // This tactic intentionally does NOT use TTM format — the model just outputs raw code
    let code = result.text.trim();

    // Strip markdown fences if the model adds them anyway
    const fenceMatch = code.match(/^```\w*\n([\s\S]*?)```$/m);
    if (fenceMatch) code = fenceMatch[1].trim();

    // Strip any TTM wrapper if the model tries to use it from training
    const ttmParsed = parseTTM(result.text);
    if (ttmParsed && "output" in ttmParsed) {
      code = (ttmParsed as { output: string }).output;
    }

    if (code.length < 20) {
      return {
        cleaned: null,
        tokens: result.tokens,
        durationMs: result.durationMs,
        prompt: result.prompt,
        raw: result.text,
      };
    }

    const { repaired } = autoRepairOutput(code, filePath);
    return {
      cleaned: repaired,
      tokens: result.tokens,
      durationMs: result.durationMs,
      prompt: result.prompt,
      raw: result.text,
    };
  } catch {
    return { cleaned: null, tokens: 0, durationMs: 0, prompt: "", raw: "" };
  }
}

/**
 * Last-resort raw code extraction from LLM text that didn't follow TTM format.
 * Looks for code fences, or large blocks of code-like lines.
 */
function extractCodeFromRaw(text: string, filePath: string): string | null {
  // Try markdown code fences first
  const fenceMatch = text.match(/```\w*\n([\s\S]*?)```/);
  if (fenceMatch && fenceMatch[1].trim().length > 30) {
    const { repaired } = autoRepairOutput(fenceMatch[1], filePath);
    return repaired;
  }

  // Try to find a block that looks like code (has braces, semicolons, keywords)
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  const codeSignals =
    ext === "py"
      ? /\b(def |class |import |from |if |for |while |return )/
      : ext === "md"
        ? /^#|^\*|^\-/m
        : /\b(function |const |let |var |import |export |class |return |if |for )/;

  const lines = text.split("\n");
  const codeLines: string[] = [];
  let inCodeBlock = false;

  for (const line of lines) {
    if (codeSignals.test(line) || (inCodeBlock && line.trim().length > 0)) {
      codeLines.push(line);
      inCodeBlock = true;
    } else if (inCodeBlock && line.trim() === "") {
      codeLines.push(line); // preserve blank lines within code
    } else if (inCodeBlock && !codeSignals.test(line)) {
      // Might be exiting code block — check if next lines are also non-code
      inCodeBlock = false;
    }
  }

  if (codeLines.length > 5) {
    const extracted = codeLines.join("\n");
    const { repaired } = autoRepairOutput(extracted, filePath);
    return repaired;
  }

  return null;
}
