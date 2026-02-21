import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { projects } from "@/db/schema";
import { eq } from "drizzle-orm";
import { Pipeline, PipelineStage } from "@/lib/pipeline";
import { checkOllamaHealth } from "@/lib/ollama";

// Track running pipelines
const activePipelines = new Map<number, Pipeline>();

const VALID_STAGES: PipelineStage[] = [
  "all",
  "decompose",
  "breakdown",
  "execute",
];

/**
 * POST /api/projects/[id]/run — Start or resume a project pipeline
 * Body: { stage?: "all" | "decompose" | "breakdown" | "execute" }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const projectId = parseInt(id, 10);

  let stage: PipelineStage = "all";
  let breakdownDepth: number | undefined;
  try {
    const body = await request.json();
    if (body.stage && VALID_STAGES.includes(body.stage)) {
      stage = body.stage;
    }
    if (typeof body.breakdownDepth === "number") {
      breakdownDepth = body.breakdownDepth;
    }
  } catch {
    // No body or invalid JSON — use default
  }

  const project = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
  });

  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  if (project.status === "running") {
    return NextResponse.json(
      { error: "Project is already running" },
      { status: 409 },
    );
  }

  // Health check Ollama
  const healthy = await checkOllamaHealth(project.primaryModel);
  if (!healthy) {
    return NextResponse.json(
      {
        error: `Ollama is not available or model '${project.primaryModel}' is not loaded. Make sure Ollama is running.`,
      },
      { status: 503 },
    );
  }

  // Start pipeline in background
  const pipeline = new Pipeline(
    projectId,
    project.primaryModel,
    () => {}, // Events consumed via SSE endpoint
  );

  activePipelines.set(projectId, pipeline);

  // Fire and forget
  pipeline.run(stage, breakdownDepth).catch(async (err) => {
    console.error(`Pipeline error for project ${projectId}:`, err);
    await db
      .update(projects)
      .set({ status: "paused" })
      .where(eq(projects.id, projectId));
    activePipelines.delete(projectId);
  });

  return NextResponse.json({ status: "started", projectId });
}

/**
 * DELETE /api/projects/[id]/run — Stop a running project pipeline
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const projectId = parseInt(id, 10);

  const pipeline = activePipelines.get(projectId);
  if (pipeline) {
    pipeline.abort();
    activePipelines.delete(projectId);
  }

  await db
    .update(projects)
    .set({ status: "paused" })
    .where(eq(projects.id, projectId));

  return NextResponse.json({ status: "stopped", projectId });
}
