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
- For a React UI app (any interactive single-page tool): 1-2 files MAXIMUM.
  - ONE main component file (App.tsx or descriptive name like Timer.tsx) that contains ALL the UI and logic.
  - Only add a second file if the spec explicitly describes a reusable component that appears in multiple places.
  - Do NOT create separate service classes, manager classes, or helper .ts files for a React UI task.
  - Do NOT create a Python file for a React/browser task.
  - Do NOT create settings.json, config files, or data files unless the spec explicitly asks for persistent settings.
- For documentation/analysis tasks: 1-2 markdown files
- For multi-file backend/CLI projects: up to 5 files, ordered by dependency
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
  const sanitised = sanitiseManifest(manifest);

  return { manifest: sanitised, raw: text, prompt, tokens, durationMs };
}

/**
 * Post-LLM guardrails: strip files that are clearly wrong for the manifest type.
 *
 * Rules applied when a React/TSX project is detected:
 * - Max 3 files total (model loves generating unnecessary service classes)
 * - Drop .py, .html, .htm files (Python/HTML have no place in a TSX project)
 * - Drop "service", "manager", "player", "factory" .ts files — these are
 *   hallucinated OOP wrappers; all logic should live in the TSX component
 * - Keep the first TSX file, any remaining TSX, and at most one utility .ts
 */
function sanitiseManifest(files: ManifestFile[]): ManifestFile[] {
  const hasTsx = files.some((f) => /\.(tsx|jsx)$/i.test(f.path));
  if (!hasTsx) return files; // Non-React manifests are fine as-is

  // Drop files that never belong in a React UI project
  const SERVICE_PATTERN =
    /(?:service|manager|player|factory|provider|store|slice)\.ts$/i;
  const WRONG_LANG = /\.(py|html?|htm)$/i;

  let kept = files.filter((f) => {
    if (WRONG_LANG.test(f.path)) return false;
    if (SERVICE_PATTERN.test(f.path)) return false;
    return true;
  });

  // Hard cap: keep at most 3 files for React UI tasks
  if (kept.length > 3) {
    // Always keep TSX files first, then TS utilities
    const tsx = kept.filter((f) => /\.(tsx|jsx)$/i.test(f.path));
    const ts = kept.filter((f) => /\.ts$/i.test(f.path));
    const rest = kept.filter((f) => !/\.(tsx|jsx|ts)$/i.test(f.path));
    kept = [...tsx, ...ts, ...rest].slice(0, 3);
  }

  // Fallback: if we stripped everything, keep the original first tsx file
  if (kept.length === 0) {
    const firstTsx = files.find((f) => /\.(tsx|jsx)$/i.test(f.path));
    if (firstTsx) return [firstTsx];
    return files.slice(0, 1);
  }

  return kept;
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
