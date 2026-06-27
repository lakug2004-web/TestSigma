import { NextResponse, type NextRequest } from "next/server"
import { headers } from "next/headers"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/prisma"

const BACKEND_URL = process.env.BACKEND_URL ?? "http://localhost:8000"

// Builds the Neo4j knowledge graph from an already-generated RepoTree, then
// folds the returned GraphInfo back into the cached tree so the next open
// shows the graph too. No GitHub token needed — the tree is already parsed.
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null)
  if (!body?.full_name || !body?.tree) {
    return NextResponse.json(
      { error: "full_name and tree are required" },
      { status: 400 },
    )
  }

  const session = await auth.api.getSession({ headers: await headers() })
  if (!session) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 })
  }
  const userId = session.user.id

  try {
    const res = await fetch(`${BACKEND_URL}/graph`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tree: body.tree }),
      cache: "no-store",
    })
    const data = await res.json()
    if (!res.ok) {
      return NextResponse.json(
        { error: data.detail ?? "Failed to build graph" },
        { status: res.status },
      )
    }

    // Persist the tree with its graph result so reopening serves it from cache.
    await prisma.repoAst
      .update({
        where: { userId_fullName: { userId, fullName: body.full_name } },
        data: { tree: { ...body.tree, graph: data } },
      })
      .catch(() => {
        /* caching is best-effort; ignore (e.g. AST not saved yet) */
      })

    return NextResponse.json(data, { status: 200 })
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
