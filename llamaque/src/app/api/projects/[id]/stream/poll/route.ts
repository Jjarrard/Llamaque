import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { logs } from "@/db/schema";
import { eq, and, gt, asc } from "drizzle-orm";

/**
 * GET /api/projects/[id]/stream/poll?after=123
 * Fallback HTTP polling for logs when SSE drops.
 * Returns logs with id > after parameter.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const projectId = parseInt(id, 10);
  const after = parseInt(request.nextUrl.searchParams.get("after") || "0", 10);

  const newLogs = await db
    .select()
    .from(logs)
    .where(
      after > 0
        ? and(eq(logs.projectId, projectId), gt(logs.id, after))
        : eq(logs.projectId, projectId),
    )
    .orderBy(asc(logs.id))
    .limit(200);

  return NextResponse.json({
    logs: newLogs.map((log) => ({
      id: log.id,
      agent: log.agent,
      message: log.message,
      taskId: log.taskId,
      createdAt: log.createdAt,
      hasRaw: !!(log.rawPrompt || log.rawResponse),
    })),
  });
}
