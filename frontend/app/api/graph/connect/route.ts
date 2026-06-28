import { NextResponse, type NextRequest } from "next/server"
import { headers } from "next/headers"
import { auth } from "@/lib/auth"

const BACKEND_URL = process.env.BACKEND_URL ?? "http://localhost:8000"

// Connect the three knowledge-graph layers (Requirements + DOM/UI + Code) for a
// repo. The backend pulls the cached AST, crawl and requirements from Postgres,
// writes the cross-layer edges + absence into Neo4j, and returns a coverage
// summary.
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null)
  if (!body?.full_name) {
    return NextResponse.json({ error: "full_name is required" }, { status: 400 })
  }

  const session = await auth.api.getSession({ headers: await headers() })
  if (!session) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 })
  }

  try {
    const res = await fetch(`${BACKEND_URL}/graph/connect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ full_name: body.full_name }),
      cache: "no-store",
    })
    const data = await res.json()
    return NextResponse.json(data, { status: res.status })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to reach graph backend" },
      { status: 502 },
    )
  }
}
