import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".tsx": "text/plain",
  ".ts": "text/plain",
};

/**
 * GET /api/projects/[id]/output?file=Component.tsx
 * Serves the project's Component.tsx file.
 *
 * For TSX files, wraps the component in an HTML page with React CDN + Babel
 * standalone for in-browser rendering (no build step needed).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const file = request.nextUrl.searchParams.get("file");

  if (!file || !/^[\w.-]+$/.test(file)) {
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

  if (!fs.existsSync(filePath)) {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }

  const content = fs.readFileSync(filePath, "utf-8");
  const ext = path.extname(file).toLowerCase();

  // For TSX files, generate a preview HTML that loads React CDN + Babel standalone
  if (ext === ".tsx" || ext === ".jsx") {
    // Strip import statements (React is provided via CDN globals)
    // and export keywords (not valid outside modules)
    const componentCode = content
      .replace(/^\s*import\s+.*?from\s+["'].*?["'];?\s*$/gm, "")
      .replace(/^\s*import\s+React[\s,{].*?;?\s*$/gm, "")
      .replace(/^\s*export\s+default\s+/gm, "")
      .replace(/^\s*export\s+(?=function|const|class)/gm, "");

    // Detect the component function name from the source code
    // Handles: export default function Foo(), function Foo(), const Foo =
    const fnNameMatch = content.match(
      /export\s+default\s+function\s+(\w+)|(?:^|\n)\s*function\s+(\w+)/,
    );
    const componentName = fnNameMatch?.[1] || fnNameMatch?.[2] || "Component";

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
  </script>
  <script>
    try {
      var code = ${JSON.stringify(
        `const { useState, useEffect, useRef, useCallback, useMemo, useReducer, useContext, createContext, Fragment } = React;\n\n` +
          componentCode +
          `\n\nvar root = ReactDOM.createRoot(document.getElementById("root"));\nroot.render(React.createElement(typeof ${componentName} !== "undefined" ? ${componentName} : function() { return React.createElement("div", null, "No component found"); }));`,
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

  const contentType = MIME_TYPES[ext] || "text/plain";
  return new NextResponse(content, {
    headers: { "Content-Type": contentType },
  });
}
