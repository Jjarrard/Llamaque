import { callOllama } from "@/lib/ollama";

const SYSTEM_PROMPT = `Does this React component work for what was requested?
PASS if it mostly works. REWORK only if broken, missing core features, or completely unstyled.

Reply:
>>REVIEW
verdict: PASS or REWORK
issues:
- (issue per line, or "none")
>>END`;

export interface HolisticReviewResult {
  verdict: "PASS" | "REWORK";
  issues: string[];
  raw: string;
  prompt: string;
  tokens: number;
  durationMs: number;
}

export async function runHolisticReview(
  model: string,
  projectName: string,
  projectDescription: string,
  files: { path: string; content: string }[],
): Promise<HolisticReviewResult> {
  const fileList = files
    .map((f) => `--- ${f.path} ---\n${f.content}`)
    .join("\n\n");

  const userMessage = `Original request: "${projectName}: ${projectDescription}"

Complete project output:
${fileList}

Review this output against the original request:`;

  const { text, prompt, tokens, durationMs } = await callOllama(
    model,
    "reviewer",
    SYSTEM_PROMPT,
    userMessage,
  );

  // Parse the response
  const verdictMatch = text.match(/verdict:\s*(PASS|REWORK)/i);
  const verdict: "PASS" | "REWORK" =
    verdictMatch && verdictMatch[1].toUpperCase() === "REWORK"
      ? "REWORK"
      : "PASS";

  const issues: string[] = [];
  const issuesMatch = text.match(/issues:\s*\n([\s\S]*?)(?:>>END|$)/i);
  if (issuesMatch) {
    const lines = issuesMatch[1].split("\n");
    for (const line of lines) {
      const trimmed = line.replace(/^-\s*/, "").trim();
      if (trimmed && trimmed.toLowerCase() !== "none" && trimmed !== ">>END") {
        issues.push(trimmed);
      }
    }
  }

  return { verdict, issues, raw: text, prompt, tokens, durationMs };
}
