import { NextRequest } from "next/server";
import { db } from "@/db";
import { logs } from "@/db/schema";
import { eq, and, gt, asc } from "drizzle-orm";

/**
 * GET /api/projects/[id]/stream — SSE endpoint for live log updates
 *
 * Polls the logs table and streams new entries to the client.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const projectId = parseInt(id, 10);

  // Support Last-Event-ID so reconnections resume from where they left off
  const lastEventIdHeader = request.headers.get("Last-Event-ID");
  const encoder = new TextEncoder();
  let lastLogId = lastEventIdHeader ? parseInt(lastEventIdHeader, 10) || 0 : 0;
  let closed = false;

  const stream = new ReadableStream({
    async start(controller) {
      // Send initial heartbeat
      controller.enqueue(encoder.encode(": connected\n\n"));

      const poll = async () => {
        if (closed) return;

        try {
          const newLogs = await db
            .select()
            .from(logs)
            .where(
              lastLogId > 0
                ? and(eq(logs.projectId, projectId), gt(logs.id, lastLogId))
                : eq(logs.projectId, projectId),
            )
            .orderBy(asc(logs.id));

          for (const log of newLogs) {
            const event = {
              id: log.id,
              agent: log.agent,
              message: log.message,
              taskId: log.taskId,
              createdAt: log.createdAt,
              hasRaw: !!(log.rawPrompt || log.rawResponse),
            };

            // Include id: field so EventSource tracks last received event
            controller.enqueue(
              encoder.encode(
                `id: ${log.id}\ndata: ${JSON.stringify(event)}\n\n`,
              ),
            );
            lastLogId = log.id;
          }
        } catch (err) {
          // Ignore errors during polling
        }

        if (!closed) {
          setTimeout(poll, 2000); // Poll every 2 seconds
        }
      };

      poll();

      // Handle abort
      request.signal.addEventListener("abort", () => {
        closed = true;
        try {
          controller.close();
        } catch {
          // Already closed
        }
      });
    },
    cancel() {
      closed = true;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
