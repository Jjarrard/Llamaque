import { NextResponse } from "next/server";

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://localhost:11434";

/**
 * GET /api/models — List locally available Ollama models
 */
export async function GET() {
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      return NextResponse.json(
        { error: "Ollama is not responding" },
        { status: 503 },
      );
    }
    const data = await res.json();
    const models: string[] = (data.models || []).map(
      (m: { name: string }) => m.name,
    );
    // Sort smallest first so tiny models appear at top
    models.sort((a, b) => a.localeCompare(b));
    return NextResponse.json(models);
  } catch {
    return NextResponse.json(
      { error: "Cannot connect to Ollama" },
      { status: 503 },
    );
  }
}
