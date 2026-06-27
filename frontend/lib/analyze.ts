// Types mirroring the Python backend's RepoTree / JobStatus, plus small client
// helpers to start an analysis and poll it. The browser only ever talks to the
// Next route handlers under /api/analyze — the GitHub token stays server-side.

export type FunctionInfo = {
  name: string
  args: string[]
  lineno: number
  end_lineno: number
  is_async: boolean
  decorators: string[]
  calls: string[]
  description: string
}

export type ClassInfo = {
  name: string
  lineno: number
  end_lineno: number
  bases: string[]
  decorators: string[]
  methods: FunctionInfo[]
  description: string
}

export type FileInfo = {
  path: string
  language: string
  loc: number
  parsed: boolean
  parse_error: string | null
  imports: string[]
  import_records?: { module: string; names: string[]; level: number }[]
  functions: FunctionInfo[]
  classes: ClassInfo[]
  description: string
}

export type GraphQuery = {
  name: string
  cypher: string
}

export type GraphInfo = {
  console_url: string
  instance_name: string
  database: string
  nodes_written: number
  relationships_written: number
  sample_query: string
  connector_name: string
  queries: GraphQuery[]
}

export type RepoTree = {
  full_name: string
  ref: string
  summary: string
  file_count: number
  python_file_count: number
  files: FileInfo[]
  graph?: GraphInfo | null
}

export type JobState = "pending" | "running" | "done" | "error"

export type JobStatus = {
  job_id: string
  state: JobState
  progress: number
  message: string
  error: string | null
  result: RepoTree | null
}

export type StartArgs = {
  full_name: string
  owner: string
  repo: string
  ref?: string
}

export type StartResult =
  | { cached: true; tree: RepoTree }
  | { cached: false; jobId: string }

/** True if the tree has no Python to describe, or at least one description exists. */
export function treeHasDescriptions(tree: RepoTree): boolean {
  if (tree.python_file_count === 0) return true
  return tree.files.some(
    (f) =>
      f.description ||
      f.functions.some((fn) => fn.description) ||
      f.classes.some((c) => c.description || c.methods.some((m) => m.description)),
  )
}

/**
 * Start an analysis. If this user already has a stored AST for the repo, returns
 * it straight from the database cache; otherwise kicks off a backend job.
 * Pass `refresh` to bypass the cache and force regeneration.
 */
export async function startAnalysis(
  args: StartArgs & { refresh?: boolean; buildGraph?: boolean },
): Promise<StartResult> {
  const res = await fetch(`/api/analyze${args.refresh ? "?refresh=1" : ""}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...args, build_graph: args.buildGraph ?? false }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error ?? `Failed to start analysis (${res.status})`)
  }
  const data = await res.json()
  if (data.cached) return { cached: true, tree: data.tree as RepoTree }
  return { cached: false, jobId: data.job_id as string }
}

/** Persist a generated tree so subsequent opens load from cache. */
export async function saveAst(fullName: string, tree: RepoTree): Promise<void> {
  await fetch("/api/analyze/save", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ full_name: fullName, tree }),
  }).catch(() => {
    /* caching is best-effort; ignore failures */
  })
}

/**
 * Build the Neo4j knowledge graph from an already-generated tree (no refetch /
 * LLM). Returns where to view it in the Aura console.
 */
export async function buildGraph(
  fullName: string,
  tree: RepoTree,
): Promise<GraphInfo> {
  const res = await fetch("/api/analyze/graph", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ full_name: fullName, tree }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error ?? `Failed to build graph (${res.status})`)
  }
  return (await res.json()) as GraphInfo
}

/** Fetch a job's current status. */
export async function fetchStatus(jobId: string): Promise<JobStatus> {
  const res = await fetch(`/api/analyze/${jobId}`)
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error ?? `Failed to fetch status (${res.status})`)
  }
  return (await res.json()) as JobStatus
}

/**
 * Poll until the job reaches a terminal state. Calls `onProgress` on each tick.
 * Returns the final RepoTree, or throws on error / abort.
 */
export async function pollUntilDone(
  jobId: string,
  onProgress: (s: JobStatus) => void,
  signal?: AbortSignal,
  intervalMs = 2000,
): Promise<RepoTree> {
  for (;;) {
    if (signal?.aborted) throw new Error("aborted")
    const status = await fetchStatus(jobId)
    onProgress(status)
    if (status.state === "done" && status.result) return status.result
    if (status.state === "error") {
      throw new Error(status.error ?? "Analysis failed")
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}
