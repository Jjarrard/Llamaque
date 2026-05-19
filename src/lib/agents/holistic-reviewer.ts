import { callOllama } from "@/lib/ollama";

const SYSTEM_PROMPT = `Does this project output work for what was requested?
Check: Are all features implemented? Is the logic correct? Is anything broken or incomplete?
PASS if it mostly works. REWORK only if broken or missing core features.

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
  // Truncate each file to 80 lines so the total prompt stays within a 3-4B
  // model's effective attention range. We only need structure and feature
  // presence — not every line of implementation detail.
  const fileList = files
    .map((f) => {
      const lines = f.content.split("\n");
      const truncated =
        lines.length > 80
          ? lines.slice(0, 80).join("\n") + `\n...(${lines.length - 80} more lines)`
          : f.content;
      return `--- ${f.path} ---\n${truncated}`;
    })
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
