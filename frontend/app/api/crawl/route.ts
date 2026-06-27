import { NextResponse, type NextRequest } from "next/server"
import { headers } from "next/headers"
import { auth } from "@/lib/auth"

const BACKEND_URL = process.env.BACKEND_URL ?? "http://localhost:8000"

// Starts a browser-crawl job against a live application. Auth-gated so only a
// signed-in user can drive the crawler. Any login credentials in the body are
// forwarded straight to the backend and never persisted by the frontend.
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null)
  if (!body?.base_url) {
    return NextResponse.json({ error: "base_url is required" }, { status: 400 })
  }
  if (!Array.isArray(body.routes) || body.routes.length === 0) {
    return NextResponse.json({ error: "at least one route is required" }, { status: 400 })
  }

  const session = await auth.api.getSession({ headers: await headers() })
  if (!session) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 })
  }

  try {
    const res = await fetch(`${BACKEND_URL}/crawl`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        base_url: body.base_url,
        routes: body.routes,
        login: body.login ?? null,
      }),
      cache: "no-store",
    })
    const data = await res.json()
    if (!res.ok) {
      return NextResponse.json(
        { error: data.detail ?? "Failed to start crawl" },
        { status: res.status },
      )
    }
    return NextResponse.json(data, { status: res.status })
  } catch (err) {
    return NextResponse.json(
      {
        error:
          err instanceof Error ? err.message : "Failed to reach crawl backend",
      },
      { status: 502 },
    )
  }
}
