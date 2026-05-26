import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { db } from "@/db";
import { tasks } from "@/db/schema";
import { eq, and } from "drizzle-orm";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".jsx": "text/plain",
  ".tsx": "text/plain",
  ".ts": "text/plain",
  ".py": "text/plain",
  ".md": "text/plain",
  ".json": "application/json",
  ".yaml": "text/plain",
  ".yml": "text/plain",
  ".txt": "text/plain",
};

/**
 * GET /api/projects/[id]/output?file=Component.tsx
 * Serves any project output file.
 *
 * For TSX/JSX files, wraps in an HTML page with React CDN + Babel standalone.
 * For HTML files, serves directly.
 * For Markdown, renders to simple HTML.
 * For other files, serves as plain text.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const file = request.nextUrl.searchParams.get("file");

  if (!file || !/^[\w./-]+$/.test(file)) {
    return NextResponse.json(
      { error: "Invalid or missing file parameter" },
      { status: 400 },
    );
  }

  const outputDir = path.join(process.cwd(), "output", id);
  const filePath = path.join(outputDir, file);

  // Prevent directory traversal
  if (!filePath.startsWith(outputDir)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Read from disk if available, otherwise fall back to the DB (tasks.output)
  let content: string | null = null;
  if (fs.existsSync(filePath)) {
    content = fs.readFileSync(filePath, "utf-8");
  } else {
    const projectId = parseInt(id, 10);
    const task = await db.query.tasks.findFirst({
      where: and(eq(tasks.projectId, projectId), eq(tasks.filePath, file)),
    });
    content = task?.output ?? null;
  }

  if (content === null) {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }
  const ext = path.extname(file).toLowerCase();

  // ?raw=1 returns raw source code as plain text (for the code viewer)
  const raw = request.nextUrl.searchParams.get("raw");
  if (raw === "1") {
    return new NextResponse(content, {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  // For TSX files, generate a preview HTML that loads React CDN + Babel standalone
  if (ext === ".tsx" || ext === ".jsx") {
    // If the requested file is a leaf component (not a root file), prefer rendering
    // the root file (App.tsx / index.tsx / main.tsx) so it renders with real props.
    // Leaf components rendered in isolation crash because they have no props.
    const ROOT_NAMES = [
      "App.tsx",
      "App.jsx",
      "app.tsx",
      "index.tsx",
      "index.jsx",
      "main.tsx",
      "Main.tsx",
    ];
    const requestedBasename = path.basename(file);
    const isRootFile = ROOT_NAMES.includes(requestedBasename);
    let previewFile = file;
    let previewContent = content;
    if (!isRootFile) {
      for (const rootName of ROOT_NAMES) {
        const rootPath = path.join(outputDir, rootName);
        if (fs.existsSync(rootPath)) {
          previewFile = rootName;
          previewContent = fs.readFileSync(rootPath, "utf-8");
          break;
        }
      }
    }

    // Strip >> TTM protocol markers that may have leaked into the file
    const cleanedContent = previewContent.replace(/^>>[ \t]?/gm, "");
    // Bundle local sibling imports so <Sibling /> references resolve in the preview.
    // Sibling files are inlined before the main component code.
    const componentCode = bundleLocalImports(cleanedContent, outputDir);

    // Detect the component function name from the source code
    // Handles: export default function Foo(), function Foo(), const Foo =
    const fnNameMatch = cleanedContent.match(
      /export\s+default\s+function\s+(\w+)|(?:^|\n)\s*function\s+(\w+)/,
    );
    const componentName = fnNameMatch?.[1] || fnNameMatch?.[2] || "Component";
    const previewBanner =
      previewFile !== file
        ? `<div style="position:fixed;bottom:0;right:0;background:#1e1e2e;color:#a6e3a1;font:11px monospace;padding:4px 8px;border-radius:4px 0 0 0;opacity:0.85;z-index:9998">preview: ${previewFile}</div>`
        : "";

    // Escape backticks and ${} in user code so they don't break the JS template literal
    const escapedCode = componentCode
      .replace(/\\/g, "\\\\")
      .replace(/`/g, "\\`")
      .replace(/\$\{/g, "\\${");

    const previewHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Component Preview</title>
  <script src="https://unpkg.com/react@18/umd/react.development.js" crossorigin></script>
  <script src="https://unpkg.com/react-dom@18/umd/react-dom.development.js" crossorigin></script>
  <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    #error-display {
      display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0;
      background: #1e1e2e; color: #f38ba8; font-family: monospace; font-size: 14px;
      padding: 24px; overflow: auto; white-space: pre-wrap; z-index: 9999;
    }
    #error-display h2 { color: #f38ba8; margin-bottom: 12px; font-size: 18px; }
    #error-display .msg { color: #cdd6f4; margin-bottom: 16px; }
    #error-display button {
      background: #45475a; color: #cdd6f4; border: none; padding: 8px 16px;
      border-radius: 4px; cursor: pointer; font-size: 13px; margin-right: 8px;
    }
    #error-display button:hover { background: #585b70; }
  </style>
</head>
<body>
  <div id="root"></div>
  ${previewBanner}
  <div id="error-display">
    <h2>Component Error</h2>
    <div class="msg" id="error-message"></div>
    <button onclick="copyError()">Copy Error</button>
    <button onclick="document.getElementById('error-display').style.display='none'">Dismiss</button>
  </div>
  <script>
    function showError(msg) {
      var el = document.getElementById('error-display');
      document.getElementById('error-message').textContent = msg;
      el.style.display = 'block';
    }
    function copyError() {
      var text = document.getElementById('error-message').textContent;
      navigator.clipboard.writeText(text);
    }
    window.onerror = function(msg, src, line, col, err) {
      showError((err && err.stack) || msg);
    };
    window.addEventListener('unhandledrejection', function(e) {
      showError((e.reason && e.reason.stack) || String(e.reason));
    });
  </script>
  <script>
    try {
      var code = ${JSON.stringify(
        `const { useState, useEffect, useRef, useCallback, useMemo, useReducer, useContext, createContext, Fragment } = React;\n\n` +
          componentCode +
          `\n\nclass __ErrorBoundary__ extends React.Component {\n  constructor(props) { super(props); this.state = { err: null }; }\n  static getDerivedStateFromError(e) { return { err: e }; }\n  componentDidCatch(e) {\n    if (typeof showError !== "undefined") showError((e && e.stack) || String(e));\n  }\n  render() {\n    if (this.state.err) return null;\n    return this.props.children;\n  }\n}\n\nvar __Comp__ = typeof ${componentName} !== "undefined" ? ${componentName} : function() { return React.createElement("div", null, "No component found"); };\nvar root = ReactDOM.createRoot(document.getElementById("root"));\nroot.render(React.createElement(__ErrorBoundary__, null, React.createElement(__Comp__)));`,
      )};

      var result = Babel.transform(code, {
        presets: ['react', ['typescript', { isTSX: true, allExtensions: true }]],
        filename: 'Component.tsx'
      });

      var script = document.createElement('script');
      script.textContent = result.code;
      document.body.appendChild(script);
    } catch(e) {
      showError(e.message || String(e));
    }
  </script>
</body>
</html>`;

    return new NextResponse(previewHtml, {
      headers: { "Content-Type": "text/html" },
    });
  }

  // For HTML files, serve directly as-is
  if (ext === ".html" || ext === ".htm") {
    return new NextResponse(content, {
      headers: { "Content-Type": "text/html" },
    });
  }

  // For Markdown files, render basic HTML
  if (ext === ".md" || ext === ".markdown") {
    const rendered = renderMarkdown(content);
    return new NextResponse(rendered, {
      headers: { "Content-Type": "text/html" },
    });
  }

  const contentType = MIME_TYPES[ext] || "text/plain";
  return new NextResponse(content, {
    headers: { "Content-Type": contentType },
  });
}

/**
 * Inline local sibling imports for the Babel standalone preview.
 * Recursively reads ./Sibling.tsx/ts and prepends its stripped code before
 * the main component so <Sibling /> references resolve without a bundler.
 */
function bundleLocalImports(
  content: string,
  outputDir: string,
  seen: Set<string> = new Set(),
  depth = 0,
): string {
  if (depth > 3) return content;

  const importedPaths: string[] = [];
  // Collect and remove local (./...) import lines
  let stripped = content.replace(
    /^\s*import\s+(?:[\w*{},\s]+)\s+from\s+["'](\.\/[^"']+)["'];?\s*$/gm,
    (_, p: string) => {
      importedPaths.push(p);
      return "";
    },
  );

  // Strip remaining external imports and export modifiers
  stripped = stripped
    .replace(/^\s*import\s+[\s\S]*?from\s+["'].*?["'];?\s*$/gm, "")
    .replace(/^\s*import\s+["'].*?["'];?\s*$/gm, "")
    .replace(/^\s*export\s+default\s+\w+;\s*$/gm, "") // bare "export default Foo;"
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
        sib = bundleLocalImports(sib, outputDir, seen, depth + 1);
        chunks.push(sib);
        break;
      }
    }
  }

  return chunks.join("\n\n") + "\n\n" + stripped;
}

/** Simple Markdown to HTML renderer (no external deps) */
function renderMarkdown(md: string): string {
  let html = md
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  // Headers
  html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");
  html = html.replace(/^## (.+)$/gm, "<h2>$1</h2>");
  html = html.replace(/^# (.+)$/gm, "<h1>$1</h1>");

  // Bold/italic
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");

  // Code blocks
  html = html.replace(/```\w*\n([\s\S]*?)```/g, "<pre><code>$1</code></pre>");
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");

  // Lists
  html = html.replace(/^\- (.+)$/gm, "<li>$1</li>");
  html = html.replace(/(<li>[\s\S]*?<\/li>\n?)+/g, "<ul>$&</ul>");

  // Paragraphs (double newlines)
  html = html.replace(/\n\n/g, "</p><p>");

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
    body { font-family: -apple-system, system-ui, sans-serif; max-width: 800px; margin: 40px auto; padding: 0 20px; line-height: 1.6; color: #cdd6f4; background: #1e1e2e; }
    h1, h2, h3 { color: #89b4fa; margin-top: 1.5em; } pre { background: #313244; padding: 16px; border-radius: 8px; overflow-x: auto; }
    code { background: #313244; padding: 2px 6px; border-radius: 4px; font-size: 0.9em; } pre code { background: none; padding: 0; }
    ul { padding-left: 24px; } li { margin: 4px 0; } a { color: #89b4fa; }
  </style></head><body><p>${html}</p></body></html>`;
}
