// Types mirroring the Python backend's crawl layer (CrawlResult / ScreenInfo)
// plus client helpers to start a crawl and poll it. The browser only talks to
// the Next route handler under /api/crawl; credentials never reach the client
// store beyond the single request that starts the job.

import type { JobState } from "./analyze"

export type InteractiveElement = {
  kind: string
  role: string
  text: string
  selector: string
  href: string
}

export type DomNode = {
  tag: string
  role?: string
  name?: string
  attrs?: Record<string, string>
  children?: DomNode[]
}

export type ScreenInfo = {
  screen_id: string
  url: string
  title: string
  authenticated: boolean
  interactive_count: number
  dom_path: string
  screenshot_path: string
  a11y_path: string
  screenshot_url: string
  dom: string
  a11y: string
  elements: InteractiveElement[]
  structured_dom: DomNode[]
  label: string
  purpose: string
  primary_actions: string[]
  key_components: string[]
}

export type Transition = {
  from_screen: string
  to_screen: string
  action: string
  element_text: string
  selector: string
}

export type CrawlResult = {
  run_id: string
  base_url: string
  artifact_dir: string
  screen_count: number
  screens: ScreenInfo[]
  transitions: Transition[]
}

// JobStatus as returned by the shared /analyze/{job_id} poll, narrowed to the
// fields a crawl job populates.
export type CrawlJobStatus = {
  job_id: string
  state: JobState
  progress: number
  message: string
  error: string | null
  crawl_result: CrawlResult | null
}

export type LoginConfig = {
  login_url: string
  username: string
  password: string
  username_selector?: string
  password_selector?: string
  submit_selector?: string
  logged_out_marker?: string
}

export type RouteSpec = {
  path: string
  authenticated: boolean
}

export type StartCrawlArgs = {
  base_url: string
  routes: RouteSpec[]
  login?: LoginConfig
}

/** Kick off a crawl job; returns the job id to poll. */
export async function startCrawl(args: StartCrawlArgs): Promise<string> {
  const res = await fetch("/api/crawl", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error ?? `Failed to start crawl (${res.status})`)
  }
  const data = await res.json()
  return data.job_id as string
}

/**
 * Poll the shared job endpoint until the crawl reaches a terminal state.
 * Returns the CrawlResult, or throws on error / abort.
 */
export async function pollCrawlUntilDone(
  jobId: string,
  onProgress: (s: CrawlJobStatus) => void,
  signal?: AbortSignal,
  intervalMs = 2000,
): Promise<CrawlResult> {
  for (;;) {
    if (signal?.aborted) throw new Error("aborted")
    const res = await fetch(`/api/analyze/${jobId}`)
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(body.error ?? `Failed to fetch status (${res.status})`)
    }
    const status = (await res.json()) as CrawlJobStatus
    onProgress(status)
    if (status.state === "done" && status.crawl_result) return status.crawl_result
    if (status.state === "error") throw new Error(status.error ?? "Crawl failed")
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

/**
 * Persist a finished crawl (run + screens + edges) into Supabase Postgres.
 * Returns ok/error so the caller can surface failures instead of silently
 * dropping them (a dropped save = nothing to reload next time).
 */
export async function saveCrawl(
  fullName: string,
  routes: RouteSpec[],
  result: CrawlResult,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch("/api/crawl/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ full_name: fullName, routes, result }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      return { ok: false, error: body.error ?? `save failed (${res.status})` }
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "save failed" }
  }
}

export type SavedCrawl = {
  id: string
  createdAt: string
  routes: RouteSpec[]
  result: CrawlResult
}

/** Fetch this repo's saved crawls (newest first) for the current user. */
export async function fetchCrawls(fullName: string): Promise<SavedCrawl[]> {
  const res = await fetch(
    `/api/crawl/list?full_name=${encodeURIComponent(fullName)}`,
  )
  if (!res.ok) return []
  const data = await res.json()
  return (data.runs ?? []) as SavedCrawl[]
}
