import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { projects, tasks } from "@/db/schema";
import { desc, eq, and, gt } from "drizzle-orm";
import fs from "fs";
import path from "path";

/**
 * Clean up orphaned output directories (project folder exists on disk
 * but no matching project in the database).
 */
async function cleanOrphanedOutputDirs() {
  const outputRoot = path.join(process.cwd(), "output");
  if (!fs.existsSync(outputRoot)) return;

  const dirs = fs.readdirSync(outputRoot, { withFileTypes: true });
  const allProjects = await db.query.projects.findMany();
  const validIds = new Set(allProjects.map((p) => String(p.id)));

  for (const entry of dirs) {
    if (entry.isDirectory() && !validIds.has(entry.name)) {
      const orphanPath = path.join(outputRoot, entry.name);
      try {
        fs.rmSync(orphanPath, { recursive: true, force: true });
        console.log(`[cleanup] Removed orphaned output dir: ${entry.name}`);
      } catch {
        // Ignore permission or other errors
      }
    }
  }
}

/**
 * GET /api/projects — List all projects
 */
export async function GET() {
  // Run orphan cleanup in background (non-blocking)
  cleanOrphanedOutputDirs().catch(() => {});

  const allProjects = await db.query.projects.findMany({
    orderBy: [desc(projects.createdAt)],
  });

  // Enrich with task progress
  const enriched = await Promise.all(
    allProjects.map(async (p) => {
      const allTasks = await db.query.tasks.findMany({
        where: eq(tasks.projectId, p.id),
      });
      const doneCount = allTasks.filter((t) => t.status === "done").length;
      return {
        ...p,
        taskCount: allTasks.length,
        doneCount,
      };
    }),
  );

  return NextResponse.json(enriched);
}

/**
 * POST /api/projects — Create a new project
 * Body: { name, description, primaryModel? }
 */
export async function POST(request: NextRequest) {
  const body = await request.json();

  if (!body.name || !body.description) {
    return NextResponse.json(
      { error: "name and description are required" },
      { status: 400 },
    );
  }

  // Prevent duplicate projects with the same name created within last 30 seconds
  const recentDuplicate = await db.query.projects.findFirst({
    where: and(
      eq(projects.name, body.name),
      gt(projects.createdAt, new Date(Date.now() - 30000)),
    ),
  });
  if (recentDuplicate) {
    return NextResponse.json(recentDuplicate, { status: 200 });
  }

  const result = await db
    .insert(projects)
    .values({
      name: body.name,
      description: body.description,
      customInstructions: body.customInstructions || null,
      primaryModel: body.primaryModel || "qwen3:1.7b",
    })
    .returning();

  return NextResponse.json(result[0], { status: 201 });
}
