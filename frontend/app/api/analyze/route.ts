import { NextResponse, type NextRequest } from "next/server"
import { headers } from "next/headers"
import { auth } from "@/lib/auth"
import { getGitHubToken } from "@/lib/github"
import { prisma } from "@/lib/prisma"

const BACKEND_URL = process.env.BACKEND_URL ?? "http://localhost:8000"

// Starts an analysis job, OR returns a previously cached AST for this user+repo.
// The GitHub token is resolved server-side and never reaches the browser.
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null)
  if (!body?.full_name || !body?.owner || !body?.repo) {
    return NextResponse.json(
      { error: "full_name, owner and repo are required" },
      { status: 400 },
    )
  }

  const session = await auth.api.getSession({ headers: await headers() })
  if (!session) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 })
  }
  const userId = session.user.id

  // Cache hit: serve the stored RepoTree, skip regeneration (unless ?refresh=1).
  const refresh = new URL(request.url).searchParams.get("refresh") === "1"
  if (!refresh) {
    const cached = await prisma.repoAst.findUnique({
      where: { userId_fullName: { userId, fullName: body.full_name } },
    })
    if (cached) {
      return NextResponse.json({
        cached: true,
        tree: cached.tree,
        updatedAt: cached.updatedAt,
      })
    }
  }

  const token = await getGitHubToken()
  if (!token) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 })
  }

  try {
    const res = await fetch(`${BACKEND_URL}/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        full_name: body.full_name,
        owner: body.owner,
        repo: body.repo,
        ref: body.ref ?? "",
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
          err instanceof Error ? err.message : "Failed to reach analysis backend",
      },
      { status: 502 },
    )
  }
}
