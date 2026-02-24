import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { projects, tasks, logs, references } from "@/db/schema";
import { eq, and, asc } from "drizzle-orm";
import fs from "fs";
import path from "path";

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
 * PATCH /api/projects/[id] — Bulk actions: approve all awaiting tasks, or reset a stage
 * Body: { action: "approve_all" }
 *   or  { action: "reset_stage", stage: "decompose" | "breakdown" | "execute" }
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const projectId = parseInt(id, 10);
  const body = await request.json();

  if (body.action === "set_model") {
    if (!body.model) {
      return NextResponse.json({ error: "model is required" }, { status: 400 });
    }
    await db
      .update(projects)
      .set({ primaryModel: body.model })
      .where(eq(projects.id, projectId));
    return NextResponse.json({ ok: true });
  }

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

  if (body.action === "reset_stage") {
    const stage = body.stage as string;

    // Clear this stage and all downstream stages from completedStages
    const STAGE_ORDER = [
      "architect",
      "decompose",
      "breakdown",
      "execute",
      "qa",
      "feedback",
    ];
    const project = await db.query.projects.findFirst({
      where: eq(projects.id, projectId),
    });
    const current: string[] = JSON.parse(project?.completedStages || "[]");
    const stageIdx = STAGE_ORDER.indexOf(stage);
    if (stageIdx >= 0) {
      const toRemove = new Set(STAGE_ORDER.slice(stageIdx));
      const kept = current.filter((s) => !toRemove.has(s));
      await db
        .update(projects)
        .set({ completedStages: JSON.stringify(kept) })
        .where(eq(projects.id, projectId));
    }

    if (stage === "architect") {
      // Clear manifest and reset everything
      await db.delete(logs).where(eq(logs.projectId, projectId));
      await db.delete(references).where(eq(references.projectId, projectId));
      await db.delete(tasks).where(eq(tasks.projectId, projectId));
      const outputDir = path.join(process.cwd(), "output", id);
      if (fs.existsSync(outputDir)) {
        fs.rmSync(outputDir, { recursive: true, force: true });
      }
      await db
        .update(projects)
        .set({ status: "pending", fileManifest: null, completedStages: "[]" })
        .where(eq(projects.id, projectId));
    } else if (stage === "decompose") {
      // Delete everything and start fresh
      await db.delete(logs).where(eq(logs.projectId, projectId));
      await db.delete(references).where(eq(references.projectId, projectId));
      await db.delete(tasks).where(eq(tasks.projectId, projectId));
      // Remove output files
      const outputDir = path.join(process.cwd(), "output", id);
      if (fs.existsSync(outputDir)) {
        fs.rmSync(outputDir, { recursive: true, force: true });
      }
      await db
        .update(projects)
        .set({ status: "pending" })
        .where(eq(projects.id, projectId));
    } else if (stage === "breakdown") {
      // Delete depth >= 2 tasks (features, work items) and reset depth 1 tasks to pending
      const allTasks = await db.query.tasks.findMany({
        where: eq(tasks.projectId, projectId),
      });
      const toDelete = allTasks.filter((t) => t.depth >= 2).map((t) => t.id);
      for (const tid of toDelete) {
        await db.delete(logs).where(eq(logs.taskId, tid));
        await db.delete(tasks).where(eq(tasks.id, tid));
      }
      // Reset depth 1 tasks back to pending
      for (const t of allTasks.filter((t) => t.depth === 1)) {
        await db
          .update(tasks)
          .set({
            status: "pending",
            output: null,
            qAReason: null,
            stuckReason: null,
            retryCount: 0,
            editRetryCount: 0,
            parseRetryCount: 0,
          })
          .where(eq(tasks.id, t.id));
      }
      await db.delete(references).where(eq(references.projectId, projectId));
      // Remove output files
      const outputDir = path.join(process.cwd(), "output", id);
      if (fs.existsSync(outputDir)) {
        fs.rmSync(outputDir, { recursive: true, force: true });
      }
      await db
        .update(projects)
        .set({ status: "paused" })
        .where(eq(projects.id, projectId));
    } else if (stage === "execute") {
      // Reset all depth >= 3 tasks (work items) back to ready, clear output
      const allTasks = await db.query.tasks.findMany({
        where: eq(tasks.projectId, projectId),
      });
      for (const t of allTasks.filter((t) => t.depth >= 3)) {
        await db
          .update(tasks)
          .set({
            status: "ready",
            output: null,
            qAReason: null,
            stuckReason: null,
            retryCount: 0,
            editRetryCount: 0,
            parseRetryCount: 0,
          })
          .where(eq(tasks.id, t.id));
      }
      await db.delete(references).where(eq(references.projectId, projectId));
      // Remove output files
      const outputDir = path.join(process.cwd(), "output", id);
      if (fs.existsSync(outputDir)) {
        fs.rmSync(outputDir, { recursive: true, force: true });
      }
      await db
        .update(projects)
        .set({ status: "paused" })
        .where(eq(projects.id, projectId));
    } else if (stage === "qa" || stage === "feedback") {
      // QA and Feedback resets just clear the stage marker (done above via STAGE_ORDER).
      // No need to delete tasks or output files.
      await db
        .update(projects)
        .set({ status: "paused" })
        .where(eq(projects.id, projectId));
    } else {
      return NextResponse.json({ error: "Unknown stage" }, { status: 400 });
    }

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

  // Delete output folder
  const outputDir = path.join(process.cwd(), "output", id);
  if (fs.existsSync(outputDir)) {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }

  // Delete in order: logs, references, tasks, project
  await db.delete(logs).where(eq(logs.projectId, projectId));
  await db.delete(references).where(eq(references.projectId, projectId));
  await db.delete(tasks).where(eq(tasks.projectId, projectId));
  await db.delete(projects).where(eq(projects.id, projectId));

  return NextResponse.json({ ok: true });
}
