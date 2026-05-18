import { callOllama } from "@/lib/ollama";
import { ManifestFile } from "@/db/schema";

/**
 * Architect agent — analyzes a task description and determines what
 * output files are needed, their types, and build order.
 *
 * This is the first agent called after project creation. It replaces
 * the old hardcoded TEMPLATE_FILES / FILE_ORDER with a dynamic manifest.
 *
 * Supports any output type: code (any language), documents (markdown,
 * text), config files (JSON, YAML), data files, etc.
 */

const SYSTEM_PROMPT = `You are a software architect. Given a project description, decide what output files are needed.
For each file specify: path, type (code/document/config/data), language, description, and which other files it imports from.
Order files by dependency (leaf files with no imports first, root file last).
CRITICAL: Only include files needed for features explicitly described. Do NOT add extra features, pages, or functionality not mentioned.

Guidelines:
- For simple apps or components: 1-3 files max
- For documentation/analysis tasks: 1-2 markdown files
- For multi-file projects: up to 8 files, ordered by dependency
- Use standard file extensions (.tsx, .py, .md, .json, .ts, .css, .html, etc.)
- Keep paths flat (no deep nesting) unless the project specifically needs it
- A React component = one Component.tsx file (type: code, language: typescript)
- A Python script = one main.py file (type: code, language: python)
- A document = one output.md file (type: document, language: markdown)
- Prefer fewer files. Small models work better with fewer targets.
- imports: list ONLY other files in this manifest that this file directly imports. Leave empty if none.
- IMPORTANT: If ANY file in the manifest has a .tsx or .jsx extension, do NOT include an index.html file.
  React components render inside a host app — they do not need a standalone HTML page.
  index.html is only appropriate for projects that have NO .tsx/.jsx files and instead use vanilla JS.

Reply ONLY in this exact format:
>>MANIFEST
- path: "filename.ext" | type: "code" | language: "typescript" | description: "what this file does" | imports: []
- path: "filename.ext" | type: "code" | language: "typescript" | description: "what this file does" | imports: ["OtherFile.tsx"]
>>END`;

export interface ArchitectResult {
  manifest: ManifestFile[];
  raw: string;
  prompt: string;
  tokens: number;
  durationMs: number;
}

export async function runArchitect(
  model: string,
  projectName: string,
  projectDescription: string,
): Promise<ArchitectResult> {
  const userMessage = `Project: ${projectName}\nDescription: ${projectDescription}\n\nWhat files should this project produce?`;

  const { text, prompt, tokens, durationMs } = await callOllama(
    model,
    "architect",
    SYSTEM_PROMPT,
    userMessage,
  );

  const manifest = parseManifest(text);

  return { manifest, raw: text, prompt, tokens, durationMs };
}

/**
 * Parse the >>MANIFEST block from the LLM response.
 * Falls back to a single output.md if parsing fails.
 */
function parseManifest(text: string): ManifestFile[] {
  const files: ManifestFile[] = [];

  // Extract content between >>MANIFEST and >>END
  const blockMatch = text.match(/>>MANIFEST\s*\n([\s\S]*?)>>END/i);
  const content = blockMatch ? blockMatch[1] : text;

  const lines = content.split("\n");

  for (const line of lines) {
    // Match: - path: "X" | type: "Y" | language: "Z" | description: "W" | imports: [...]
    const match = line.match(
      /path:\s*"([^"]+)"\s*\|\s*type:\s*"([^"]+)"\s*\|\s*language:\s*"([^"]+)"\s*\|\s*description:\s*"([^"]+)"/i,
    );
    if (match) {
      const type = match[2].trim().toLowerCase();

      // Extract imports array if present: imports: ["A.tsx", "B.tsx"]
      const importsMatch = line.match(/imports:\s*\[([^\]]*)\]/i);
      const imports: string[] = [];
      if (importsMatch && importsMatch[1].trim()) {
        for (const raw of importsMatch[1].split(",")) {
          const name = raw.trim().replace(/['"]/g, "");
          if (name) imports.push(name);
        }
      }

      files.push({
        path: match[1].trim(),
        type: (["code", "document", "config", "data"].includes(type)
          ? type
          : "code") as ManifestFile["type"],
        language: match[3].trim().toLowerCase(),
        description: match[4].trim(),
        imports: imports.length > 0 ? imports : undefined,
      });
    }
  }

  // Post-parse guard: if any .tsx/.jsx file is present, drop index.html.
  // A React component cannot be loaded from a raw HTML file without a bundler,
  // and the model often writes JSX inside <script> tags when both are present.
  const hasTsx = files.some((f) => /\.(tsx|jsx)$/i.test(f.path));
  if (hasTsx) {
    const before = files.length;
    const filtered = files.filter(
      (f) => !/(?:^|[/\\])index\.(html?|js)$/i.test(f.path),
    );
    if (filtered.length < before) {
      // Keep the filtered list
      files.length = 0;
      files.push(...filtered);
    }
  }

  return files;
}

/**
 * Infer a sensible default manifest when the Architect agent fails
 * or returns an empty manifest. Uses heuristics on the project description.
 */
export function inferDefaultManifest(description: string): ManifestFile[] {
  const lower = description.toLowerCase();

  // React / component keywords
  if (
    lower.includes("react") ||
    lower.includes("component") ||
    lower.includes("app") ||
    lower.includes("ui") ||
    lower.includes("interface") ||
    lower.includes("dashboard") ||
    lower.includes("widget") ||
    lower.includes("form") ||
    lower.includes("page")
  ) {
    return [
      {
        path: "Component.tsx",
        type: "code",
        language: "typescript",
        description: "React component with inline styles",
      },
    ];
  }

  // Python keywords
  if (
    lower.includes("python") ||
    lower.includes("script") ||
    lower.includes("scraper") ||
    lower.includes("crawler")
  ) {
    return [
      {
        path: "main.py",
        type: "code",
        language: "python",
        description: "Main Python script",
      },
    ];
  }

  // HTML/website keywords
  if (
    lower.includes("html") ||
    lower.includes("website") ||
    lower.includes("web page") ||
    lower.includes("landing page")
  ) {
    return [
      {
        path: "index.html",
        type: "code",
        language: "html",
        description: "HTML page with inline CSS and JS",
      },
    ];
  }

  // Document / analysis keywords
  if (
    lower.includes("document") ||
    lower.includes("report") ||
    lower.includes("analysis") ||
    lower.includes("plan") ||
    lower.includes("essay") ||
    lower.includes("guide") ||
    lower.includes("readme") ||
    lower.includes("spec") ||
    lower.includes("write")
  ) {
    return [
      {
        path: "output.md",
        type: "document",
        language: "markdown",
        description: "Project document",
      },
    ];
  }

  // Default: single code file (most common use case)
  return [
    {
      path: "Component.tsx",
      type: "code",
      language: "typescript",
      description: "React component with inline styles",
    },
  ];
}
