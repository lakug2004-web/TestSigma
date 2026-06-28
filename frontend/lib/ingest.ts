// Types mirroring the backend's IngestResult / Requirement, plus client helpers
// to start an ingest, poll it, and persist the result. The browser only talks to
// the /api/ingest route handlers; tokens stay server-side.

import { fetchStatus } from "@/lib/analyze"

export type Requirement = {
  req_id: string
  title: string
  user_action: string
  expected_outcome: string
  priority: string
  source_anchor: string
}

export type IngestResult = {
  source: string
  source_type: string
  requirement_count: number
  requirements: Requirement[]
  excerpt: string
}

export type StartIngestArgs = {
  full_name: string
  source: string
  source_type?: "url" | "text" | "github_readme"
  refresh?: boolean
}

export type StartIngestResult =
  | { cached: true; result: IngestResult }
  | { cached: false; jobId: string }

/** Start an ingest, or return previously ingested requirements from cache. */
export async function startIngest(
  args: StartIngestArgs,
): Promise<StartIngestResult> {
  const res = await fetch(`/api/ingest${args.refresh ? "?refresh=1" : ""}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error ?? `Failed to start ingest (${res.status})`)
  }
  const data = await res.json()
  if (data.cached) return { cached: true, result: data.result as IngestResult }
  return { cached: false, jobId: data.job_id as string }
}

/** Persist ingested requirements so subsequent opens / the reviewer can use them. */
export async function saveRequirements(
  fullName: string,
  result: IngestResult,
): Promise<void> {
  await fetch("/api/ingest/save", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ full_name: fullName, result }),
  }).catch(() => {
    /* best-effort */
  })
}

export type LayerCoverage = {
  requirements: number
  screens: number
  covered_by_ui: string[]
  implemented_in_code: string[]
  uncovered_requirements: string[]
  nodes_created: number
  relationships_created: number
  absence_query: string
  skipped?: string
}

/** Connect the three knowledge-graph layers for a repo; returns coverage. */
export async function connectLayers(fullName: string): Promise<LayerCoverage> {
  const res = await fetch("/api/graph/connect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ full_name: fullName }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error ?? `Failed to connect layers (${res.status})`)
  }
  return (await res.json()) as LayerCoverage
}

/** Poll the shared job status endpoint until the ingest result lands. */
export async function pollIngestUntilDone(
  jobId: string,
  onProgress: (message: string, progress: number) => void,
  signal?: AbortSignal,
  intervalMs = 2000,
): Promise<IngestResult> {
  for (;;) {
    if (signal?.aborted) throw new Error("aborted")
    const status = (await fetchStatus(jobId)) as unknown as {
      state: string
      message: string
      progress: number
      error: string | null
      ingest_result: IngestResult | null
    }
    onProgress(status.message, status.progress)
    if (status.state === "done" && status.ingest_result) {
      return status.ingest_result
    }
    if (status.state === "error") {
      throw new Error(status.error ?? "Ingest failed")
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}
