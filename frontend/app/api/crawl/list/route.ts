import { NextResponse, type NextRequest } from "next/server"
import { headers } from "next/headers"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/prisma"
import type {
  CrawlResult,
  DomNode,
  InteractiveElement,
  ScreenInfo,
} from "@/lib/crawl"

// List a repo's saved crawls for the current user, newest first. Each run is
// rebuilt into the same CrawlResult shape the live crawl produces, so the
// frontend renders saved runs through the exact same graph / panel code.
export async function GET(request: NextRequest) {
  const fullName = new URL(request.url).searchParams.get("full_name")
  if (!fullName) {
    return NextResponse.json({ error: "full_name is required" }, { status: 400 })
  }

  const session = await auth.api.getSession({ headers: await headers() })
  if (!session) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 })
  }
  const userId = session.user.id

  const runs = await prisma.crawlRun.findMany({
    where: { userId, fullName },
    orderBy: { createdAt: "desc" },
    include: { screens: true },
  })

  const results = runs.map((run) => {
    const screens: ScreenInfo[] = run.screens.map((s) => {
      const a = (s.artifacts ?? {}) as {
        dom?: string
        a11y?: string
        elements?: InteractiveElement[]
        structured_dom?: DomNode[]
        purpose?: string
        primary_actions?: string[]
        key_components?: string[]
      }
      return {
        screen_id: s.screenId,
        url: s.url,
        title: s.title,
        label: s.label,
        authenticated: s.authenticated,
        interactive_count: s.interactiveCount,
        dom_path: "",
        screenshot_path: "",
        a11y_path: "",
        screenshot_url: s.screenshotUrl,
        dom: a.dom ?? "",
        a11y: a.a11y ?? "",
        elements: a.elements ?? [],
        structured_dom: a.structured_dom ?? [],
        purpose: a.purpose ?? "",
        primary_actions: a.primary_actions ?? [],
        key_components: a.key_components ?? [],
      }
    })
    const result: CrawlResult = {
      run_id: run.runId,
      base_url: run.baseUrl,
      artifact_dir: "",
      screen_count: run.screenCount,
      screens,
      transitions: (run.edges ?? []) as CrawlResult["transitions"],
    }
    return {
      id: run.id,
      createdAt: run.createdAt,
      routes: run.routes as { path: string; authenticated: boolean }[],
      result,
    }
  })

  return NextResponse.json({ runs: results })
}
