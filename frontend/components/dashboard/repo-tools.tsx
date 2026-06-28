"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import {
  Loader2Icon,
  DatabaseIcon,
  ExternalLinkIcon,
  CopyIcon,
  CheckIcon,
  CompassIcon,
  PlusIcon,
  Trash2Icon,
  FileTextIcon,
  NetworkIcon,
  LockIcon,
  GlobeIcon,
  FolderGitIcon,
  SearchIcon,
  ChevronRightIcon,
  FileCodeIcon,
  BoxIcon,
  FunctionSquareIcon,
  SparklesIcon,
} from "lucide-react"
import dynamic from "next/dynamic"
import type { GitHubRepo } from "@/lib/github"
import type { RepoTree, GraphInfo, FileInfo } from "@/lib/analyze"
import {
  startAnalysis,
  pollUntilDone,
  saveAst,
  buildGraph,
  treeHasDescriptions,
} from "@/lib/analyze"
import type {
  CrawlResult,
  RouteSpec,
  SavedCrawl,
  ScreenInfo as CrawlScreenInfo,
} from "@/lib/crawl"
import {
  startCrawl,
  pollCrawlUntilDone,
  saveCrawl,
  fetchCrawls,
} from "@/lib/crawl"
import type { IngestResult, Requirement } from "@/lib/ingest"
import {
  startIngest,
  pollIngestUntilDone,
  saveRequirements,
  fetchRequirements,
} from "@/lib/ingest"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"

// chart.js touches `window` at import time → client-only (no SSR).
const CrawlGraph = dynamic(
  () => import("@/components/dashboard/crawl-graph").then((m) => m.CrawlGraph),
  { ssr: false },
)

/**
 * All repository analysis tools, inline on the detail page. Each tool runs in
 * place and opens an interactive details popup with its result:
 *  - Knowledge graph: parses the codebase into an AST behind the scenes, writes
 *    it into Neo4j, then opens an explorer of the graph + per-file symbols.
 *  - Requirements: pulls every .md/.vdk doc from the codebase and ingests them
 *    into searchable, filterable requirements (persisted across visits).
 *  - Live crawl: captures the running app's screens.
 */
export function RepoTools({ repo }: { repo: GitHubRepo }) {
  // Knowledge-graph state. `tree` is the AST built behind the scenes.
  const [graphBusy, setGraphBusy] = useState(false)
  const [graphProgress, setGraphProgress] = useState(0)
  const [graphMessage, setGraphMessage] = useState("")
  const [graphError, setGraphError] = useState<string | null>(null)
  const [graphInfo, setGraphInfo] = useState<GraphInfo | null>(null)
  const [tree, setTree] = useState<RepoTree | null>(null)
  const [graphModalOpen, setGraphModalOpen] = useState(false)
  const graphAbortRef = useRef<AbortController | null>(null)

  // Requirements (ingest) state.
  const [ingestState, setIngestState] = useState<
    "idle" | "running" | "done" | "error"
  >("idle")
  const [ingestMessage, setIngestMessage] = useState("")
  const [ingestError, setIngestError] = useState<string | null>(null)
  const [requirements, setRequirements] = useState<IngestResult | null>(null)
  const [ingestModalOpen, setIngestModalOpen] = useState(false)
  const ingestAbortRef = useRef<AbortController | null>(null)

  // Live-app crawl state.
  const [crawlBaseUrl, setCrawlBaseUrl] = useState("")
  const [crawlRoutes, setCrawlRoutes] = useState<RouteSpec[]>([
    { path: "/", authenticated: false },
  ])
  const [loginUrl, setLoginUrl] = useState("")
  const [loginUser, setLoginUser] = useState("")
  const [loginPass, setLoginPass] = useState("")
  const [crawlState, setCrawlState] = useState<
    "idle" | "running" | "done" | "error"
  >("idle")
  const [crawlProgress, setCrawlProgress] = useState(0)
  const [crawlMessage, setCrawlMessage] = useState("")
  const [crawlError, setCrawlError] = useState<string | null>(null)
  const [crawlResult, setCrawlResult] = useState<CrawlResult | null>(null)
  const crawlAbortRef = useRef<AbortController | null>(null)
  const needsLogin = crawlRoutes.some((r) => r.authenticated)
  const [crawlGraphOpen, setCrawlGraphOpen] = useState(false)
  const [selectedScreen, setSelectedScreen] = useState<CrawlScreenInfo | null>(
    null,
  )
  const [savedCrawls, setSavedCrawls] = useState<SavedCrawl[]>([])
  const [crawlSaved, setCrawlSaved] = useState<
    { ok: boolean; error?: string } | null
  >(null)

  // Restore persisted state on mount: saved crawls + the last ingest.
  useEffect(() => {
    let cancelled = false
    fetchCrawls(repo.full_name).then((runs) => {
      if (cancelled || runs.length === 0) return
      setSavedCrawls(runs)
      const latest = runs[0]
      setCrawlResult(latest.result)
      setCrawlState("done")
      setCrawlBaseUrl(latest.result.base_url)
      if (latest.routes.length > 0) setCrawlRoutes(latest.routes)
    })
    fetchRequirements(repo.full_name).then((req) => {
      if (cancelled || !req) return
      setRequirements(req)
      setIngestState("done")
    })
    return () => {
      cancelled = true
    }
  }, [repo])

  useEffect(() => {
    return () => {
      graphAbortRef.current?.abort()
      crawlAbortRef.current?.abort()
      ingestAbortRef.current?.abort()
    }
  }, [])

  /** Build (or reuse cached) the described AST for this repo. */
  async function ensureTree(signal: AbortSignal): Promise<RepoTree | null> {
    if (tree) return tree
    let start = await startAnalysis({
      full_name: repo.full_name,
      owner: repo.owner,
      repo: repo.name,
      buildGraph: false,
    })
    if (start.cached && !treeHasDescriptions(start.tree)) {
      start = await startAnalysis({
        full_name: repo.full_name,
        owner: repo.owner,
        repo: repo.name,
        buildGraph: false,
        refresh: true,
      })
    }
    let result: RepoTree
    if (start.cached) {
      result = start.tree
      setGraphMessage("Loaded AST from cache")
    } else {
      result = await pollUntilDone(
        start.jobId,
        (s) => {
          setGraphProgress(Math.round(s.progress * 100))
          setGraphMessage(s.message)
        },
        signal,
      )
      if (treeHasDescriptions(result)) void saveAst(repo.full_name, result)
    }
    setTree(result)
    return result
  }

  // Generate the knowledge graph: parse the codebase into an AST behind the
  // scenes, write it into Neo4j, then open the interactive details popup.
  async function generateGraph() {
    graphAbortRef.current?.abort()
    const controller = new AbortController()
    graphAbortRef.current = controller
    setGraphBusy(true)
    setGraphError(null)
    setGraphProgress(0)
    setGraphMessage("Parsing codebase…")
    try {
      const t = await ensureTree(controller.signal)
      if (!t) return
      setGraphMessage("Writing knowledge graph…")
      const info = await buildGraph(repo.full_name, t)
      setGraphInfo(info)
      setGraphModalOpen(true)
    } catch (err) {
      if (controller.signal.aborted) return
      setGraphError(err instanceof Error ? err.message : "Graph build failed")
    } finally {
      setGraphBusy(false)
    }
  }

  // Ingest: auto-fetch every .md/.vdk file from the codebase, parse into
  // structured requirements, persist them, and open the details popup.
  async function runIngest() {
    ingestAbortRef.current?.abort()
    const controller = new AbortController()
    ingestAbortRef.current = controller
    setIngestState("running")
    setIngestError(null)
    setIngestMessage("Fetching docs from the codebase…")
    try {
      // Explicit click = regenerate from scratch. The cache is only used to
      // restore on revisit (the mount-time GET); the button always re-runs so a
      // stale row never masks fresh, deeper output.
      const start = await startIngest({
        full_name: repo.full_name,
        source: repo.full_name,
        source_type: "github_repo",
        refresh: true,
      })
      let result: IngestResult
      if (start.cached) {
        result = start.result
        setIngestMessage("Loaded from cache")
      } else {
        result = await pollIngestUntilDone(
          start.jobId,
          (message) => setIngestMessage(message),
          controller.signal,
        )
        await saveRequirements(repo.full_name, result)
      }
      setRequirements(result)
      setIngestState("done")
      setIngestModalOpen(true)
    } catch (err) {
      if (controller.signal.aborted) return
      setIngestError(err instanceof Error ? err.message : "Ingest failed")
      setIngestState("error")
    }
  }

  function addRoute() {
    setCrawlRoutes((r) => [...r, { path: "", authenticated: false }])
  }
  function updateRoute(i: number, patch: Partial<RouteSpec>) {
    setCrawlRoutes((r) => r.map((x, j) => (j === i ? { ...x, ...patch } : x)))
  }
  function removeRoute(i: number) {
    setCrawlRoutes((r) => r.filter((_, j) => j !== i))
  }

  async function runCrawl() {
    const base = crawlBaseUrl.trim()
    const routes = crawlRoutes
      .map((r) => ({ ...r, path: r.path.trim() }))
      .filter((r) => r.path.length > 0)
    if (!base) {
      setCrawlError("Enter the base application URL")
      setCrawlState("error")
      return
    }
    if (routes.length === 0) {
      setCrawlError("Add at least one route to crawl")
      setCrawlState("error")
      return
    }
    if (needsLogin && (!loginUrl.trim() || !loginUser.trim() || !loginPass)) {
      setCrawlError("Authenticated routes need login URL, username and password")
      setCrawlState("error")
      return
    }
    crawlAbortRef.current?.abort()
    const controller = new AbortController()
    crawlAbortRef.current = controller
    setCrawlState("running")
    setCrawlError(null)
    setCrawlResult(null)
    setCrawlProgress(0)
    setCrawlMessage("Launching browser…")
    try {
      const jobId = await startCrawl({
        base_url: base,
        routes,
        login: needsLogin
          ? {
              login_url: loginUrl.trim(),
              username: loginUser.trim(),
              password: loginPass,
            }
          : undefined,
      })
      const result = await pollCrawlUntilDone(
        jobId,
        (s) => {
          setCrawlProgress(Math.round(s.progress * 100))
          setCrawlMessage(s.message)
        },
        controller.signal,
      )
      setCrawlResult(result)
      setCrawlState("done")
      const saved = await saveCrawl(repo.full_name, routes, result)
      setCrawlSaved(saved)
      if (saved.ok) fetchCrawls(repo.full_name).then(setSavedCrawls)
    } catch (err) {
      if (controller.signal.aborted) return
      setCrawlError(err instanceof Error ? err.message : "Crawl failed")
      setCrawlState("error")
    }
  }

  const reqCount = requirements?.requirement_count ?? 0
  const fileCount = requirements?.files?.length ?? 0

  return (
    <>
      <div className="grid gap-4 lg:grid-cols-2">
        {/* Knowledge graph ------------------------------------------------- */}
        <ToolCard
          accent="violet"
          icon={<DatabaseIcon className="size-5" />}
          title="Knowledge graph"
          description="Parse the codebase into an AST and write it straight into the Neo4j knowledge graph."
        >
          <Button
            className="w-full"
            onClick={generateGraph}
            disabled={graphBusy}
          >
            {graphBusy ? (
              <Loader2Icon className="size-4 animate-spin" />
            ) : (
              <SparklesIcon className="size-4" />
            )}
            {graphInfo ? "Regenerate graph" : "Generate knowledge graph"}
          </Button>

          {graphBusy ? (
            <div className="mt-3 space-y-1.5">
              <Progress value={graphProgress} />
              <p className="truncate text-xs text-muted-foreground">
                {graphProgress}% · {graphMessage}
              </p>
            </div>
          ) : null}

          {graphError ? (
            <p className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {graphError}
            </p>
          ) : null}

          {graphInfo && !graphBusy ? (
            <button
              type="button"
              onClick={() => setGraphModalOpen(true)}
              className="mt-3 flex w-full items-center justify-between rounded-lg border border-border bg-muted/40 p-3 text-left transition-colors hover:border-brand/40 hover:bg-brand/5"
            >
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="secondary">
                  {graphInfo.nodes_written} nodes
                </Badge>
                <Badge variant="secondary">
                  {graphInfo.relationships_written} rels
                </Badge>
                {tree ? (
                  <span className="text-xs text-muted-foreground">
                    {tree.python_file_count} files
                  </span>
                ) : null}
              </div>
              <span className="inline-flex items-center gap-1 text-xs font-medium text-brand">
                View details
                <ChevronRightIcon className="size-3.5" />
              </span>
            </button>
          ) : null}
        </ToolCard>

        {/* Requirements (ingest) ------------------------------------------ */}
        <ToolCard
          accent="emerald"
          icon={<FileTextIcon className="size-5" />}
          title="Product requirements"
          description="Pulls every .md / .vdk doc straight from the codebase and parses them into testable, persisted requirements."
        >
          <Button
            variant="secondary"
            className="w-full"
            onClick={runIngest}
            disabled={ingestState === "running"}
          >
            {ingestState === "running" ? (
              <Loader2Icon className="size-4 animate-spin" />
            ) : (
              <FolderGitIcon className="size-4" />
            )}
            {requirements ? "Re-ingest codebase docs" : "Ingest codebase docs"}
          </Button>

          {ingestState === "running" ? (
            <p className="mt-3 flex items-center gap-1.5 truncate text-xs text-muted-foreground">
              <Loader2Icon className="size-3 animate-spin" />
              {ingestMessage}
            </p>
          ) : null}
          {ingestState === "error" ? (
            <p className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {ingestError}
            </p>
          ) : null}

          {requirements && ingestState !== "running" ? (
            <button
              type="button"
              onClick={() => setIngestModalOpen(true)}
              className="mt-3 flex w-full items-center justify-between rounded-lg border border-border bg-muted/40 p-3 text-left transition-colors hover:border-brand/40 hover:bg-brand/5"
            >
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="secondary">{reqCount} requirements</Badge>
                {fileCount > 0 ? (
                  <Badge variant="outline">{fileCount} docs</Badge>
                ) : null}
              </div>
              <span className="inline-flex items-center gap-1 text-xs font-medium text-brand">
                View details
                <ChevronRightIcon className="size-3.5" />
              </span>
            </button>
          ) : null}
        </ToolCard>
      </div>

      {/* Live application crawl -------------------------------------------- */}
      <ToolCard
        accent="sky"
        icon={<CompassIcon className="size-5" />}
        title="Live application crawl"
        description="List the routes to capture and mark each public or authenticated. The browser visits each, captures DOM + screenshot, and maps how the screens connect."
      >
        {savedCrawls.length > 0 ? (
          <div className="mb-3 flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Saved crawls:</span>
            <select
              className="flex-1 rounded-md border border-border bg-background px-2 py-1 text-xs"
              value={crawlResult?.run_id ?? ""}
              onChange={(e) => {
                const run = savedCrawls.find(
                  (r) => r.result.run_id === e.target.value,
                )
                if (!run) return
                setCrawlResult(run.result)
                setCrawlState("done")
                setCrawlBaseUrl(run.result.base_url)
                if (run.routes.length > 0) setCrawlRoutes(run.routes)
              }}
              disabled={crawlState === "running"}
            >
              {savedCrawls.map((r) => (
                <option key={r.id} value={r.result.run_id}>
                  {new Date(r.createdAt).toLocaleString()} ·{" "}
                  {r.result.screen_count} screens
                </option>
              ))}
            </select>
          </div>
        ) : null}

        <div className="grid gap-4 lg:grid-cols-2">
          <div>
            <Input
              type="url"
              inputMode="url"
              placeholder="Base URL — https://app.example.com"
              value={crawlBaseUrl}
              onChange={(e) => setCrawlBaseUrl(e.target.value)}
              disabled={crawlState === "running"}
            />

            <div className="mt-2 space-y-2">
              {crawlRoutes.map((r, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Input
                    placeholder="/route/path"
                    value={r.path}
                    onChange={(e) => updateRoute(i, { path: e.target.value })}
                    disabled={crawlState === "running"}
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant={r.authenticated ? "default" : "outline"}
                    className="shrink-0"
                    onClick={() =>
                      updateRoute(i, { authenticated: !r.authenticated })
                    }
                    disabled={crawlState === "running"}
                    title="Toggle authenticated / public"
                  >
                    {r.authenticated ? (
                      <LockIcon className="size-3.5" />
                    ) : (
                      <GlobeIcon className="size-3.5" />
                    )}
                    {r.authenticated ? "Auth" : "Public"}
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="shrink-0"
                    onClick={() => removeRoute(i)}
                    disabled={crawlState === "running" || crawlRoutes.length === 1}
                  >
                    <Trash2Icon className="size-3.5" />
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={addRoute}
                disabled={crawlState === "running"}
              >
                <PlusIcon className="size-3.5" />
                Add route
              </Button>
            </div>

            {needsLogin ? (
              <div className="mt-2 space-y-2 rounded-lg border border-border bg-muted/40 p-3">
                <p className="flex items-center gap-1.5 text-xs font-medium">
                  <LockIcon className="size-3.5" />
                  Login (used once, session reused for authed routes)
                </p>
                <Input
                  type="url"
                  placeholder="Login page URL"
                  value={loginUrl}
                  onChange={(e) => setLoginUrl(e.target.value)}
                  disabled={crawlState === "running"}
                />
                <div className="flex gap-2">
                  <Input
                    placeholder="Username / email"
                    value={loginUser}
                    onChange={(e) => setLoginUser(e.target.value)}
                    disabled={crawlState === "running"}
                  />
                  <Input
                    type="password"
                    placeholder="Password"
                    value={loginPass}
                    onChange={(e) => setLoginPass(e.target.value)}
                    disabled={crawlState === "running"}
                  />
                </div>
              </div>
            ) : null}

            <Button
              className="mt-3 w-full"
              size="sm"
              onClick={runCrawl}
              disabled={crawlState === "running"}
            >
              {crawlState === "running" ? (
                <Loader2Icon className="size-4 animate-spin" />
              ) : (
                <CompassIcon className="size-4" />
              )}
              Crawl {crawlRoutes.length} route
              {crawlRoutes.length === 1 ? "" : "s"}
            </Button>

            {crawlState === "running" ? (
              <div className="mt-3 space-y-1.5">
                <Progress value={crawlProgress} />
                <p className="truncate text-xs text-muted-foreground">
                  {crawlProgress}% · {crawlMessage}
                </p>
              </div>
            ) : null}

            {crawlState === "error" ? (
              <p className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {crawlError}
              </p>
            ) : null}
          </div>

          {/* Results pane */}
          <div>
            {crawlState === "done" && crawlResult ? (
              <div className="space-y-3 rounded-lg border border-brand/30 bg-brand/5 p-3">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <CompassIcon className="size-4 text-brand" />
                  Crawled {crawlResult.screen_count} screens
                </div>
                <div className="flex flex-wrap gap-2">
                  <Badge variant="secondary">
                    {crawlResult.transitions.length} relationships
                  </Badge>
                  <Badge variant="outline" className="font-mono">
                    {crawlResult.run_id}
                  </Badge>
                  {crawlSaved === null ? (
                    <Badge variant="outline">loaded from DB</Badge>
                  ) : crawlSaved.ok ? (
                    <Badge variant="outline">saved to DB</Badge>
                  ) : (
                    <Badge variant="destructive">
                      save failed: {crawlSaved.error}
                    </Badge>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {crawlResult.screens.map((s) => (
                    <div
                      key={s.screen_id}
                      className="overflow-hidden rounded-md border border-border bg-background"
                    >
                      {s.screenshot_url ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={s.screenshot_url}
                          alt={s.label || s.title || s.url}
                          className="h-24 w-full object-cover object-top"
                        />
                      ) : null}
                      <div className="p-1.5">
                        <p className="truncate text-[11px] font-medium">
                          {s.authenticated ? "🔒" : "🌐"}{" "}
                          {s.label || s.title || s.url}
                        </p>
                        <p className="truncate text-[10px] text-muted-foreground">
                          {s.interactive_count} controls
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="w-full"
                  onClick={() => {
                    setSelectedScreen(crawlResult.screens[0] ?? null)
                    setCrawlGraphOpen(true)
                  }}
                >
                  <NetworkIcon className="size-4" />
                  View screen graph &amp; browser responses
                </Button>
              </div>
            ) : (
              <div className="flex h-full min-h-32 items-center justify-center rounded-lg border border-dashed border-border text-center text-xs text-muted-foreground">
                Crawl results appear here.
              </div>
            )}
          </div>
        </div>
      </ToolCard>

      <GraphDetailsModal
        open={graphModalOpen}
        onOpenChange={setGraphModalOpen}
        info={graphInfo}
        tree={tree}
        repo={repo}
      />

      <IngestDetailsModal
        open={ingestModalOpen}
        onOpenChange={setIngestModalOpen}
        result={requirements}
        repo={repo}
      />

      <Dialog open={crawlGraphOpen} onOpenChange={setCrawlGraphOpen}>
        <DialogContent className="flex h-[90vh] w-[95vw] max-w-[95vw] flex-col sm:max-w-[95vw]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <NetworkIcon className="size-4 text-brand" />
              Screen graph · {crawlResult?.base_url}
            </DialogTitle>
            <DialogDescription>
              Nodes are crawled screens; edges are inferred relationships. Click a
              node to inspect the browser response captured for that screen.
            </DialogDescription>
          </DialogHeader>
          <div className="grid min-h-0 flex-1 grid-cols-[1fr_380px] gap-4">
            <div className="min-h-0">
              {crawlResult ? (
                <CrawlGraph result={crawlResult} onSelect={setSelectedScreen} />
              ) : null}
            </div>
            <ScreenResponsePanel screen={selectedScreen} />
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

const ACCENTS: Record<string, string> = {
  violet: "bg-violet-500/10 text-violet-500",
  emerald: "bg-emerald-500/10 text-emerald-500",
  sky: "bg-sky-500/10 text-sky-500",
}

function ToolCard({
  accent,
  icon,
  title,
  description,
  children,
}: {
  accent: "violet" | "emerald" | "sky"
  icon: React.ReactNode
  title: string
  description: string
  children: React.ReactNode
}) {
  return (
    <section className="rounded-xl border border-border bg-card p-5 shadow-sm transition-shadow hover:shadow-md">
      <div className="flex items-start gap-3">
        <div
          className={`flex size-10 shrink-0 items-center justify-center rounded-lg ${ACCENTS[accent]}`}
        >
          {icon}
        </div>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">{title}</h3>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
            {description}
          </p>
        </div>
      </div>
      <div className="mt-4">{children}</div>
    </section>
  )
}

// --- Knowledge-graph details popup -----------------------------------------
function GraphDetailsModal({
  open,
  onOpenChange,
  info,
  tree,
  repo,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  info: GraphInfo | null
  tree: RepoTree | null
  repo: GitHubRepo
}) {
  const [copied, setCopied] = useState<string | null>(null)
  const [query, setQuery] = useState("")

  const files = useMemo(() => {
    const all = tree?.files ?? []
    const q = query.trim().toLowerCase()
    if (!q) return all
    return all.filter(
      (f) =>
        f.path.toLowerCase().includes(q) ||
        f.description.toLowerCase().includes(q) ||
        f.classes.some((c) => c.name.toLowerCase().includes(q)) ||
        f.functions.some((fn) => fn.name.toLowerCase().includes(q)),
    )
  }, [tree, query])

  function copyQuery(name: string, cypher: string) {
    void navigator.clipboard.writeText(cypher)
    setCopied(name)
    setTimeout(() => setCopied(null), 1500)
  }

  if (!info) return null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[88vh] w-[95vw] max-w-4xl flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl">
        <DialogHeader className="border-b border-border bg-muted/30 px-6 py-4">
          <DialogTitle className="flex items-center gap-2">
            <DatabaseIcon className="size-4 text-brand" />
            Knowledge graph · {repo.full_name}
          </DialogTitle>
          <DialogDescription>
            The codebase parsed into an AST and mirrored into Neo4j. Explore the
            per-file symbols below, or run a scoped query in the Aura console.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2 border-b border-border px-6 py-3">
          <Badge variant="secondary">{info.nodes_written} nodes</Badge>
          <Badge variant="secondary">
            {info.relationships_written} relationships
          </Badge>
          <Badge variant="outline" className="font-mono">
            {info.connector_name}
          </Badge>
          {info.instance_name ? (
            <Badge variant="outline">{info.instance_name}</Badge>
          ) : null}
          <a
            href={info.console_url}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto inline-flex items-center gap-1.5 rounded-md bg-brand px-3 py-1.5 text-xs font-medium text-brand-foreground transition-opacity hover:opacity-90"
          >
            <ExternalLinkIcon className="size-3.5" />
            Open Neo4j console
          </a>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[1fr_320px]">
          {/* Symbol explorer */}
          <div className="flex min-h-0 flex-col border-r border-border">
            <div className="border-b border-border p-3">
              <div className="relative">
                <SearchIcon className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
                <Input
                  placeholder="Search files, classes, functions…"
                  className="pl-8"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-3">
              {files.length === 0 ? (
                <p className="py-10 text-center text-sm text-muted-foreground">
                  {tree ? "No matching files." : "No AST available."}
                </p>
              ) : (
                <ul className="space-y-1.5">
                  {files.map((f) => (
                    <FileRow key={f.path} file={f} />
                  ))}
                </ul>
              )}
            </div>
          </div>

          {/* Queries */}
          <div className="min-h-0 overflow-auto p-4">
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Scoped queries
            </h4>
            <div className="space-y-2">
              {info.queries.map((q) => (
                <div key={q.name} className="rounded-md border border-border p-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] font-medium">{q.name}</span>
                    <button
                      type="button"
                      onClick={() => copyQuery(q.name, q.cypher)}
                      className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
                    >
                      {copied === q.name ? (
                        <CheckIcon className="size-3" />
                      ) : (
                        <CopyIcon className="size-3" />
                      )}
                      {copied === q.name ? "Copied" : "Copy"}
                    </button>
                  </div>
                  <code className="mt-1 block break-all font-mono text-[10px] leading-relaxed text-muted-foreground">
                    {q.cypher}
                  </code>
                </div>
              ))}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function FileRow({ file }: { file: FileInfo }) {
  const [open, setOpen] = useState(false)
  const symbolCount = file.classes.length + file.functions.length
  return (
    <li className="rounded-md border border-border">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-2.5 py-2 text-left"
      >
        <ChevronRightIcon
          className={`size-3.5 shrink-0 text-muted-foreground transition-transform ${
            open ? "rotate-90" : ""
          }`}
        />
        <FileCodeIcon className="size-3.5 shrink-0 text-brand" />
        <span className="min-w-0 flex-1 truncate font-mono text-[11px]">
          {file.path}
        </span>
        <span className="shrink-0 text-[10px] text-muted-foreground">
          {symbolCount} sym
        </span>
      </button>
      {open ? (
        <div className="space-y-2 border-t border-border px-3 py-2">
          {file.description ? (
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {file.description}
            </p>
          ) : null}
          {file.classes.map((c) => (
            <div key={c.name} className="text-[11px]">
              <p className="flex items-center gap-1.5 font-medium">
                <BoxIcon className="size-3 text-violet-500" />
                {c.name}
              </p>
              {c.description ? (
                <p className="ml-4 text-muted-foreground">{c.description}</p>
              ) : null}
            </div>
          ))}
          {file.functions.map((fn) => (
            <div key={fn.name} className="text-[11px]">
              <p className="flex items-center gap-1.5 font-medium">
                <FunctionSquareIcon className="size-3 text-sky-500" />
                {fn.name}()
              </p>
              {fn.description ? (
                <p className="ml-4 text-muted-foreground">{fn.description}</p>
              ) : null}
            </div>
          ))}
          {symbolCount === 0 && !file.description ? (
            <p className="text-[11px] text-muted-foreground">
              No symbols described.
            </p>
          ) : null}
        </div>
      ) : null}
    </li>
  )
}

// --- Ingest details popup ---------------------------------------------------
function IngestDetailsModal({
  open,
  onOpenChange,
  result,
  repo,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  result: IngestResult | null
  repo: GitHubRepo
}) {
  if (!result) return null
  const requirements = result.requirements ?? []

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[88vh] w-[95vw] max-w-3xl flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl">
        <DialogHeader className="border-b border-border bg-muted/30 px-6 py-4">
          <DialogTitle className="flex items-center gap-2">
            <FileTextIcon className="size-4 text-brand" />
            Product requirements · {repo.full_name}
          </DialogTitle>
          <DialogDescription>
            {result.requirement_count} structured requirements parsed from{" "}
            {result.files?.length ?? 0} doc file
            {(result.files?.length ?? 0) === 1 ? "" : "s"} in the codebase.
            Persisted — restored automatically on your next visit.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-auto">
          {/* Whole-codebase overview ------------------------------------- */}
          {result.overview ? (
            <div className="border-b border-border px-6 py-4">
              <h4 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <SparklesIcon className="size-3.5 text-brand" />
                Codebase overview
              </h4>
              <Markdown
                text={result.overview}
                className="text-[13px] leading-relaxed"
              />
            </div>
          ) : null}

          {result.files && result.files.length > 0 ? (
            <div className="flex flex-wrap gap-1.5 border-b border-border px-6 py-3">
              {result.files.map((f) => (
                <span
                  key={f}
                  className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                >
                  <FileCodeIcon className="size-3" />
                  {f}
                </span>
              ))}
            </div>
          ) : null}

          <div className="p-4">
            <h4 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Requirements
            </h4>
            {requirements.length === 0 ? (
              <p className="py-10 text-center text-sm text-muted-foreground">
                No requirements parsed.
              </p>
            ) : (
              <ul className="space-y-2">
                {requirements.map((r) => (
                  <RequirementRow key={r.req_id} req={r} />
                ))}
              </ul>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function RequirementRow({ req }: { req: Requirement }) {
  return (
    <li className="rounded-lg border border-border p-3">
      <p className="text-sm font-medium leading-snug">
        <span className="font-mono text-brand">{req.req_id}</span> {req.title}
      </p>
      {req.description ? (
        <Markdown
          text={req.description}
          className="mt-2 text-[12px] leading-relaxed text-muted-foreground [&_p]:my-2"
        />
      ) : null}
      {req.user_action || req.expected_outcome ? (
        <div className="mt-2 space-y-1 rounded-md bg-muted/40 p-2 text-[11px] leading-relaxed">
          {req.user_action ? (
            <p>
              <span className="font-medium text-foreground">When</span>{" "}
              <span className="text-muted-foreground">{req.user_action}</span>
            </p>
          ) : null}
          {req.expected_outcome ? (
            <p>
              <span className="font-medium text-foreground">Then</span>{" "}
              <span className="text-muted-foreground">
                {req.expected_outcome}
              </span>
            </p>
          ) : null}
        </div>
      ) : null}
      {req.source_anchor ? (
        <p className="mt-1.5 text-[10px] text-muted-foreground">
          source: {req.source_anchor}
        </p>
      ) : null}
    </li>
  )
}

// Minimal markdown renderer (headings / bullets / paragraphs / **bold**) — the
// overview comes back as markdown and we have no markdown dep in this app.
function Markdown({ text, className }: { text: string; className?: string }) {
  const lines = text.split("\n")
  const blocks: React.ReactNode[] = []
  let list: string[] = []
  const flush = () => {
    if (list.length === 0) return
    blocks.push(
      <ul key={`l${blocks.length}`} className="my-1.5 ml-4 list-disc space-y-1">
        {list.map((it, i) => (
          <li key={i}>{renderInline(it)}</li>
        ))}
      </ul>,
    )
    list = []
  }
  for (const raw of lines) {
    const line = raw.trimEnd()
    if (/^\s*[-*]\s+/.test(line)) {
      list.push(line.replace(/^\s*[-*]\s+/, ""))
      continue
    }
    flush()
    if (!line.trim()) continue
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) {
      blocks.push(
        <p key={blocks.length} className="mt-2 mb-1 font-semibold">
          {renderInline(h[2])}
        </p>,
      )
    } else {
      blocks.push(
        <p key={blocks.length} className="my-1.5">
          {renderInline(line)}
        </p>,
      )
    }
  }
  flush()
  return <div className={className}>{blocks}</div>
}

function renderInline(text: string): React.ReactNode {
  // Split on **bold** spans only — enough for the overview's emphasis.
  const parts = text.split(/(\*\*[^*]+\*\*)/g)
  return parts.map((p, i) =>
    p.startsWith("**") && p.endsWith("**") ? (
      <strong key={i} className="font-semibold text-foreground">
        {p.slice(2, -2)}
      </strong>
    ) : (
      <span key={i}>{p}</span>
    ),
  )
}

// Right-hand panel: the raw browser response captured for one screen.
function ScreenResponsePanel({ screen }: { screen: CrawlScreenInfo | null }) {
  if (!screen) {
    return (
      <div className="flex items-center justify-center rounded-lg border border-border bg-card text-sm text-muted-foreground">
        Select a screen
      </div>
    )
  }
  return (
    <div className="flex min-h-0 flex-col gap-3 overflow-hidden rounded-lg border border-border bg-card p-3">
      <div>
        <p className="flex items-center gap-1.5 text-sm font-medium">
          {screen.authenticated ? (
            <LockIcon className="size-3.5" />
          ) : (
            <GlobeIcon className="size-3.5" />
          )}
          {screen.label || screen.title || screen.url}
        </p>
        <p className="truncate text-[11px] text-muted-foreground">
          {screen.url}
        </p>
      </div>

      {screen.screenshot_url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={screen.screenshot_url}
          alt={screen.label || screen.url}
          className="max-h-48 w-full rounded-md border border-border object-cover object-top"
        />
      ) : null}

      {screen.purpose || screen.primary_actions.length ? (
        <div className="rounded-md border border-brand/30 bg-brand/5 p-2 text-[11px]">
          {screen.purpose ? <p className="mb-1.5">{screen.purpose}</p> : null}
          {screen.primary_actions.length ? (
            <div className="mb-1 flex flex-wrap gap-1">
              {screen.primary_actions.map((a, i) => (
                <span
                  key={i}
                  className="rounded bg-brand/15 px-1.5 py-0.5 text-[10px] text-foreground"
                >
                  {a}
                </span>
              ))}
            </div>
          ) : null}
          {screen.key_components.length ? (
            <p className="text-[10px] text-muted-foreground">
              Components: {screen.key_components.join(", ")}
            </p>
          ) : null}
        </div>
      ) : null}

      <p className="text-xs font-medium">Links ({screen.elements.length})</p>
      <div className="min-h-0 flex-1 overflow-auto rounded-md border border-border bg-muted/40 p-2">
        <ul className="space-y-1">
          {screen.elements.map((el, i) => (
            <li key={i} className="font-mono text-[10px] text-muted-foreground">
              {el.text ? (
                <span className="text-foreground">{el.text}</span>
              ) : null}
              {el.href ? ` → ${el.href}` : ""}
            </li>
          ))}
          {screen.elements.length === 0 ? (
            <li className="text-[11px] text-muted-foreground">
              (no links captured)
            </li>
          ) : null}
        </ul>
      </div>
    </div>
  )
}
