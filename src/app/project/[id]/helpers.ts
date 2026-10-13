import type { FeedbackLedger, ManifestEntry, Task } from "./types";

export function getPrimaryFile(manifestJson: string | null | undefined): string {
  if (!manifestJson) return "output.txt";
  try {
    const files = JSON.parse(manifestJson) as { path: string }[];
    if (!files.length) return "output.txt";
    // Prefer a previewable file: HTML > TSX/JSX > first file
    const html = files.find((f) => /\.(html?|htm)$/i.test(f.path));
    if (html) return html.path;
    const react = files.find((f) => /\.[jt]sx$/i.test(f.path));
    if (react) return react.path;
    return files[0].path;
  } catch {
    return "output.txt";
  }
}

/** Generate human-readable run instructions based on the file manifest */
export function generateRunInstructions(
  manifest: ManifestEntry[],
  projectName: string,
): string {
  if (!manifest || manifest.length === 0) return "No output files yet.";

  const extensions = manifest.map(
    (f) => f.path.split(".").pop()?.toLowerCase() || "",
  );
  const hasReact = extensions.some((e) => ["tsx", "jsx"].includes(e));
  const hasHTML = extensions.some((e) => ["html", "htm"].includes(e));
  const hasPython = extensions.some((e) => e === "py");
  const hasNode = extensions.some((e) => ["js", "ts"].includes(e)) && !hasReact;
  const hasMarkdown = extensions.some((e) => ["md", "markdown"].includes(e));

  const lines: string[] = [`# How to run: ${projectName}\n`];
  lines.push(`Download the project files using the ⬇ Download button above.\n`);

  if (hasReact) {
    lines.push(`## React (TSX/JSX)\n`);
    lines.push(
      `You can preview TSX files directly in the browser using the **Preview** button.\n`,
    );
    lines.push(`To run locally:\n`);
    lines.push(`\`\`\`bash`);
    lines.push(`# Create a new React project`);
    lines.push(`npx create-react-app my-app --template typescript`);
    lines.push(`cd my-app`);
    lines.push(`# Copy the generated .tsx files into src/`);
    lines.push(`# Then run:`);
    lines.push(`npm start`);
    lines.push(`\`\`\`\n`);
    lines.push(`Or use Vite:\n`);
    lines.push(`\`\`\`bash`);
    lines.push(`npm create vite@latest my-app -- --template react-ts`);
    lines.push(`cd my-app`);
    lines.push(`# Copy .tsx files into src/`);
    lines.push(`npm install && npm run dev`);
    lines.push(`\`\`\``);
  }

  if (hasHTML) {
    lines.push(`## HTML\n`);
    lines.push(
      `Open the .html file directly in a browser, or use a local server:\n`,
    );
    lines.push(`\`\`\`bash`);
    lines.push(`npx serve .`);
    lines.push(`# or`);
    lines.push(`python3 -m http.server 8000`);
    lines.push(`\`\`\``);
  }

  if (hasPython) {
    lines.push(`## Python\n`);
    lines.push(`\`\`\`bash`);
    lines.push(
      `python3 ${manifest.find((f) => f.path.endsWith(".py"))?.path || "main.py"}`,
    );
    lines.push(`\`\`\``);
    lines.push(
      `\nInstall dependencies if needed: \`pip install -r requirements.txt\``,
    );
  }

  if (hasNode) {
    lines.push(`## Node.js\n`);
    lines.push(`\`\`\`bash`);
    lines.push(
      `node ${manifest.find((f) => f.path.endsWith(".js") || f.path.endsWith(".ts"))?.path || "index.js"}`,
    );
    lines.push(`\`\`\``);
    lines.push(
      `\nFor TypeScript: \`npx tsx ${manifest.find((f) => f.path.endsWith(".ts"))?.path || "index.ts"}\``,
    );
  }

  if (hasMarkdown && !hasReact && !hasHTML && !hasPython && !hasNode) {
    lines.push(`## Markdown\n`);
    lines.push(`Open the .md files in any Markdown viewer or editor.`);
  }

  lines.push(`\n## Files included\n`);
  for (const f of manifest) {
    lines.push(`- **${f.path}** — ${f.description || f.type || "output file"}`);
  }

  return lines.join("\n");
}

/** Build a tree from flat task list */
export function buildTree(tasks: Task[]) {
  const byParent = new Map<number | null, Task[]>();
  for (const t of tasks) {
    const list = byParent.get(t.parentId) || [];
    list.push(t);
    byParent.set(t.parentId, list);
  }
  return byParent;
}

export function parseLedger(raw: string | null | undefined): FeedbackLedger | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as FeedbackLedger;
  } catch {
    return null;
  }
}

/** Format seconds as "1m 32s" or "45s" */
export function formatElapsed(s: number): string {
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}
