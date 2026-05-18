import { NextRequest, NextResponse } from "next/server";
import { getStreamSnapshot } from "@/lib/stream-state";

/**
 * GET /api/projects/[id]/stream/current
 *
 * Returns the current in-flight LLM token buffer for a project.
 * Polled every ~400ms by the client to show live model output.
 * Returns 204 when no stream is active.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const projectId = parseInt(id, 10);
  if (isNaN(projectId)) {
    return NextResponse.json({ error: "Invalid project id" }, { status: 400 });
  }

  const snapshot = getStreamSnapshot(projectId);
  if (!snapshot) {
    return new NextResponse(null, { status: 204 });
  }

  return NextResponse.json({
    text: snapshot.text,
    agent: snapshot.agent,
    updatedAt: snapshot.updatedAt,
  });
}
