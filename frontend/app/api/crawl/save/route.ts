import { NextResponse, type NextRequest } from "next/server"
import { headers } from "next/headers"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/prisma"
import type { CrawlResult } from "@/lib/crawl"

// Persist a finished crawl into Supabase Postgres: one CrawlRun + its screens.
// The screen-relationship graph (edges) is stored as JSON on the run; per-screen
// DOM / a11y / elements go into the screen's `artifacts` JSON. Screenshots are
// referenced by their Supabase Storage URL (or data: URI fallback).
export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as {
    full_name?: string
    routes?: { path: string; authenticated: boolean }[]
    result?: CrawlResult
  } | null
  const result = body?.result
  if (!result?.run_id || !result.base_url) {
    return NextResponse.json({ error: "result with run_id is required" }, { status: 400 })
  }
  if (!body?.full_name) {
    return NextResponse.json({ error: "full_name is required" }, { status: 400 })
  }

  const session = await auth.api.getSession({ headers: await headers() })
  if (!session) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 })
  }
  const userId = session.user.id

  try {
    const run = await prisma.crawlRun.create({
      data: {
        userId,
        fullName: body.full_name,
        baseUrl: result.base_url,
        routes: body.routes ?? [],
        runId: result.run_id,
        screenCount: result.screen_count,
        edges: result.transitions,
        screens: {
          create: result.screens.map((s) => ({
            screenId: s.screen_id,
            url: s.url,
            title: s.title,
            label: s.label,
            authenticated: s.authenticated,
            screenshotUrl: s.screenshot_url,
            interactiveCount: s.interactive_count,
            artifacts: {
              dom: s.dom,
              a11y: s.a11y,
              elements: s.elements,
              structured_dom: s.structured_dom,
              purpose: s.purpose,
              primary_actions: s.primary_actions,
              key_components: s.key_components,
            },
          })),
        },
      },
    })
    return NextResponse.json({ ok: true, id: run.id })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to persist crawl" },
      { status: 500 },
    )
  }
}
