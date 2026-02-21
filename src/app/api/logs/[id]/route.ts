import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { logs } from "@/db/schema";
import { eq } from "drizzle-orm";

/**
 * GET /api/logs/[id] — Get full log entry including raw prompt/response
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const logId = parseInt(id, 10);

  const log = await db.query.logs.findFirst({
    where: eq(logs.id, logId),
  });

  if (!log) {
    return NextResponse.json({ error: "Log not found" }, { status: 404 });
  }

  return NextResponse.json(log);
}
