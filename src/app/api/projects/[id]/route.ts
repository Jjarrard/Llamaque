import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { projects, tasks, logs, references } from "@/db/schema";
import { eq, and, asc } from "drizzle-orm";

/**
 * GET /api/projects/[id] — Get project details with task tree
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const projectId = parseInt(id, 10);

  const project = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
  });

  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const allTasks = await db.query.tasks.findMany({
    where: eq(tasks.projectId, projectId),
    orderBy: [asc(tasks.depth), asc(tasks.sortOrder)],
  });

  return NextResponse.json({ project, tasks: allTasks });
}

/**
 * PATCH /api/projects/[id] — Bulk actions: approve all awaiting tasks
 * Body: { action: "approve_all" }
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const projectId = parseInt(id, 10);
  const body = await request.json();

  if (body.action === "approve_all") {
    await db
      .update(tasks)
      .set({ status: "pending" })
      .where(
        and(
          eq(tasks.projectId, projectId),
          eq(tasks.status, "awaiting_approval"),
        ),
      );
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}

/**
 * DELETE /api/projects/[id] — Delete a project and all related data
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const projectId = parseInt(id, 10);

  // Delete in order: logs, references, tasks, project
  await db.delete(logs).where(eq(logs.projectId, projectId));
  await db.delete(references).where(eq(references.projectId, projectId));
  await db.delete(tasks).where(eq(tasks.projectId, projectId));
  await db.delete(projects).where(eq(projects.id, projectId));

  return NextResponse.json({ ok: true });
}
