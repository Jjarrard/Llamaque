import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { tasks } from "@/db/schema";
import { eq } from "drizzle-orm";

/**
 * GET /api/tasks/[id] — Get task details
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const taskId = parseInt(id, 10);

  const task = await db.query.tasks.findFirst({
    where: eq(tasks.id, taskId),
  });

  if (!task) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  return NextResponse.json(task);
}

/**
 * PATCH /api/tasks/[id] — User intervention on a STUCK task
 * Body: { action: "retry" | "skip" | "edit", description?: string }
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const taskId = parseInt(id, 10);
  const body = await request.json();

  const task = await db.query.tasks.findFirst({
    where: eq(tasks.id, taskId),
  });

  if (!task) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  // Approval actions work on awaiting_approval tasks
  if (body.action === "approve") {
    if (task.status !== "awaiting_approval") {
      return NextResponse.json(
        { error: "Can only approve tasks awaiting approval" },
        { status: 400 },
      );
    }
    await db
      .update(tasks)
      .set({ status: "pending" })
      .where(eq(tasks.id, taskId));

    const updated = await db.query.tasks.findFirst({
      where: eq(tasks.id, taskId),
    });
    return NextResponse.json(updated);
  }

  if (body.action === "reject") {
    if (task.status !== "awaiting_approval") {
      return NextResponse.json(
        { error: "Can only reject tasks awaiting approval" },
        { status: 400 },
      );
    }
    await db.delete(tasks).where(eq(tasks.id, taskId));
    return NextResponse.json({ ok: true, deleted: taskId });
  }

  // Stuck actions
  if (task.status !== "stuck") {
    return NextResponse.json(
      { error: "Can only intervene on STUCK tasks" },
      { status: 400 },
    );
  }

  switch (body.action) {
    case "retry":
      await db
        .update(tasks)
        .set({
          status: "pending",
          retryCount: 0,
          editRetryCount: 0,
          parseRetryCount: 0,
          stuckReason: null,
        })
        .where(eq(tasks.id, taskId));
      break;

    case "skip":
      await db
        .update(tasks)
        .set({ status: "done", stuckReason: "Skipped by user" })
        .where(eq(tasks.id, taskId));
      break;

    case "edit":
      if (!body.description) {
        return NextResponse.json(
          { error: "description required for edit action" },
          { status: 400 },
        );
      }
      await db
        .update(tasks)
        .set({
          description: body.description,
          status: "pending",
          retryCount: 0,
          editRetryCount: 0,
          parseRetryCount: 0,
          stuckReason: null,
        })
        .where(eq(tasks.id, taskId));
      break;

    default:
      return NextResponse.json(
        { error: "action must be approve, reject, retry, skip, or edit" },
        { status: 400 },
      );
  }

  const updated = await db.query.tasks.findFirst({
    where: eq(tasks.id, taskId),
  });

  return NextResponse.json(updated);
}
