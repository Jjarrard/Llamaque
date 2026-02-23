import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
};

/**
 * GET /api/projects/[id]/output?file=index.html
 * Serves a file from the project's output directory.
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
  const contentType = MIME_TYPES[ext] || "text/plain";

  // For HTML files, rewrite relative CSS/JS links to go through this same API
  if (ext === ".html") {
    const rewritten = content
      .replace(
        /href="style\.css"/g,
        `href="/api/projects/${id}/output?file=style.css"`,
      )
      .replace(
        /src="script\.js"/g,
        `src="/api/projects/${id}/output?file=script.js"`,
      );
    return new NextResponse(rewritten, {
      headers: { "Content-Type": contentType },
    });
  }

  return new NextResponse(content, {
    headers: { "Content-Type": contentType },
  });
}
