import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { projects } from "@/db/schema";
import { desc, eq, and, gt } from "drizzle-orm";

/**
 * GET /api/projects — List all projects
 */
export async function GET() {
  const allProjects = await db.query.projects.findMany({
    orderBy: [desc(projects.createdAt)],
  });
  return NextResponse.json(allProjects);
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
      primaryModel: body.primaryModel || "qwen3:1.7b",
    })
    .returning();

  return NextResponse.json(result[0], { status: 201 });
}
