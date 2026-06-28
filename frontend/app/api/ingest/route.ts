import { NextResponse, type NextRequest } from "next/server"
import { headers } from "next/headers"
import { auth } from "@/lib/auth"
import { getGitHubToken } from "@/lib/github"
import { prisma } from "@/lib/prisma"

const BACKEND_URL = process.env.BACKEND_URL ?? "http://localhost:8000"

// Start a requirements-ingest job, OR return previously ingested requirements
// for this user+repo. The backend parses a PRD/README/spec into structured
// requirements (the "Requirements" layer of the knowledge graph).
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null)
  if (!body?.full_name || !body?.source) {
    return NextResponse.json(
      { error: "full_name and source are required" },
      { status: 400 },
    )
  }

  const session = await auth.api.getSession({ headers: await headers() })
  if (!session) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 })
  }
  const userId = session.user.id

  const refresh = new URL(request.url).searchParams.get("refresh") === "1"
  if (!refresh) {
    const cached = await prisma.repoRequirements.findUnique({
      where: { userId_fullName: { userId, fullName: body.full_name } },
    })
    if (cached) {
      return NextResponse.json({
        cached: true,
        result: {
          source: cached.source,
          source_type: cached.sourceType,
          requirement_count: cached.requirementCount,
          requirements: cached.requirements,
          excerpt: cached.excerpt,
        },
        updatedAt: cached.updatedAt,
      })
    }
  }

  // github_readme on a private repo needs the user's token; harmless otherwise.
  const token = (await getGitHubToken()) ?? ""

  try {
    const res = await fetch(`${BACKEND_URL}/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source_type: body.source_type ?? "url",
        source: body.source,
        token,
      }),
      cache: "no-store",
    })
    const data = await res.json()
    return NextResponse.json({ cached: false, ...data }, { status: res.status })
  } catch (err) {
    return NextResponse.json(
      {
        error:
          err instanceof Error ? err.message : "Failed to reach ingest backend",
      },
      { status: 502 },
    )
  }
}
