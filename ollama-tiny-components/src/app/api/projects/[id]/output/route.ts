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
    const componentCode = content
      .replace(/^\s*import\s+.*?from\s+["']react["'];?\s*$/gm, "")
      .replace(/^\s*import\s+React[\s,{].*?;?\s*$/gm, "");

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
  </style>
</head>
<body>
  <div id="root"></div>
  <script type="text/babel" data-type="module">
    const { useState, useEffect, useRef, useCallback, useMemo, useReducer, useContext, createContext, Fragment } = React;

    ${componentCode}

    const root = ReactDOM.createRoot(document.getElementById("root"));
    root.render(React.createElement(typeof Component !== "undefined" ? Component : (typeof App !== "undefined" ? App : () => React.createElement("div", null, "No component found"))));
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
