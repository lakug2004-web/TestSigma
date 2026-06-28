"use client"

import { useEffect, useRef, useState } from "react"
import {
  GitPullRequestIcon,
  GitCommitHorizontalIcon,
  LockIcon,
  GlobeIcon,
  NetworkIcon,
  Loader2Icon,
  DatabaseIcon,
  LayersIcon,
  ExternalLinkIcon,
  CopyIcon,
  CheckIcon,
  CompassIcon,
  PlusIcon,
  Trash2Icon,
  FileTextIcon,
  ShieldAlertIcon,
} from "lucide-react"
import type { GitHubRepo, RepoStats } from "@/lib/github"
import type { RepoTree, GraphInfo } from "@/lib/analyze"
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
import type { IngestResult, LayerCoverage } from "@/lib/ingest"
import {
  startIngest,
  pollIngestUntilDone,
  saveRequirements,
  connectLayers,
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
import { Skeleton } from "@/components/ui/skeleton"
import dynamic from "next/dynamic"

// Chart.js + chartjs-plugin-zoom touch `window` at import time, so this view is
// client-only (no SSR).
const AstGraph = dynamic(
  () => import("@/components/dashboard/ast-graph").then((m) => m.AstGraph),
  { ssr: false },
)

// chart.js touches `window` at import time → client-only, like AstGraph.
const CrawlGraph = dynamic(
  () => import("@/components/dashboard/crawl-graph").then((m) => m.CrawlGraph),
  { ssr: false },
)

export function RepoStatsDialog({
  repo,
  open,
  onOpenChange,
}: {
  repo: GitHubRepo | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [stats, setStats] = useState<RepoStats | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // AST analysis state.
  const [astState, setAstState] = useState<
    "idle" | "running" | "done" | "error"
  >("idle")
  const [astProgress, setAstProgress] = useState(0)
  const [astMessage, setAstMessage] = useState("")
  const [astError, setAstError] = useState<string | null>(null)
  const [tree, setTree] = useState<RepoTree | null>(null)
  const [astOpen, setAstOpen] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  // Knowledge-graph state.
  const [graphState, setGraphState] = useState<
    "idle" | "running" | "done" | "error"
  >("idle")
  const [graphInfo, setGraphInfo] = useState<GraphInfo | null>(null)
  const [graphError, setGraphError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  // Live-app crawl state (UI / "what was built" layer).
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
  // Screen-relationship graph view + the selected screen's browser response.
  const [crawlGraphOpen, setCrawlGraphOpen] = useState(false)
  const [selectedScreen, setSelectedScreen] = useState<CrawlScreenInfo | null>(null)
  // Previously saved crawls for this repo (loaded when the popup opens).
  const [savedCrawls, setSavedCrawls] = useState<SavedCrawl[]>([])
  const [crawlSaved, setCrawlSaved] = useState<
    { ok: boolean; error?: string } | null
  >(null)

  // Ingest (Requirements layer) + 3-layer connect state.
  const [specSource, setSpecSource] = useState("")
  const [specType, setSpecType] = useState<"url" | "github_readme">("url")
  const [ingestState, setIngestState] = useState<
    "idle" | "running" | "done" | "error"
  >("idle")
  const [ingestMessage, setIngestMessage] = useState("")
  const [ingestError, setIngestError] = useState<string | null>(null)
  const [requirements, setRequirements] = useState<IngestResult | null>(null)
  const ingestAbortRef = useRef<AbortController | null>(null)
  const [connectState, setConnectState] = useState<
    "idle" | "running" | "done" | "error"
  >("idle")
  const [connectError, setConnectError] = useState<string | null>(null)
  const [coverage, setCoverage] = useState<LayerCoverage | null>(null)

  // Reset AST + graph state whenever a different repo is opened.
  useEffect(() => {
    abortRef.current?.abort()
    abortRef.current = null
    setAstState("idle")
    setAstProgress(0)
    setAstMessage("")
    setAstError(null)
    setTree(null)
    setAstOpen(false)
    setGraphState("idle")
    setGraphInfo(null)
    setGraphError(null)
    setCopied(null)
    crawlAbortRef.current?.abort()
    crawlAbortRef.current = null
    setCrawlBaseUrl("")
    setCrawlRoutes([{ path: "/", authenticated: false }])
    setLoginUrl("")
    setLoginUser("")
    setLoginPass("")
    setCrawlState("idle")
    setCrawlProgress(0)
    setCrawlMessage("")
    setCrawlError(null)
    setCrawlResult(null)
    setCrawlGraphOpen(false)
    setSelectedScreen(null)
    setSavedCrawls([])
    setCrawlSaved(null)
    ingestAbortRef.current?.abort()
    ingestAbortRef.current = null
    setSpecSource("")
    setSpecType("url")
    setIngestState("idle")
    setIngestMessage("")
    setIngestError(null)
    setRequirements(null)
    setConnectState("idle")
    setConnectError(null)
    setCoverage(null)
  }, [repo])

  // Load this repo's saved crawls when the popup opens. The most recent run is
  // shown straight away (and its routes pre-fill the editor) so reopening a repo
  // restores the crawl results — graph, screenshots and browser responses.
  useEffect(() => {
    if (!open || !repo) return
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
    return () => {
      cancelled = true
    }
  }, [open, repo])

  // Abort any in-flight poll on unmount.
  useEffect(() => {
    return () => {
      abortRef.current?.abort()
      crawlAbortRef.current?.abort()
    }
  }, [])

  /**
   * Produce a RepoTree for the active repo: serve the cached AST when it has
   * descriptions, otherwise run a backend job and poll it. `buildGraphInline`
   * asks the backend to also write the Neo4j graph as part of the same job.
   * Returns the tree, or null on failure (state is set accordingly).
   */
  async function runAnalysis(buildGraphInline: boolean): Promise<RepoTree | null> {
    if (!repo) return null
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setAstState("running")
    setAstError(null)
    setAstProgress(0)
    setAstMessage("Starting…")
    try {
      let start = await startAnalysis({
        full_name: repo.full_name,
        owner: repo.owner,
        repo: repo.name,
        buildGraph: buildGraphInline,
      })

      // Cache hit — serve the stored AST only if it actually has descriptions.
      // A previously failed run (e.g. bad model) cached an empty tree; regenerate.
      if (start.cached && !treeHasDescriptions(start.tree)) {
        start = await startAnalysis({
          full_name: repo.full_name,
          owner: repo.owner,
          repo: repo.name,
          buildGraph: buildGraphInline,
          refresh: true,
        })
      }

      let result: RepoTree
      if (start.cached) {
        result = start.tree
        setAstMessage("Loaded from cache")
      } else {
        result = await pollUntilDone(
          start.jobId,
          (s) => {
            setAstProgress(Math.round(s.progress * 100))
            setAstMessage(s.message)
          },
          controller.signal,
        )
        // Persist only when descriptions succeeded, so failures aren't cached.
        if (treeHasDescriptions(result)) void saveAst(repo.full_name, result)
      }

      setTree(result)
      setAstState("done")
      return result
    } catch (err) {
      if (controller.signal.aborted) return null
      setAstError(err instanceof Error ? err.message : "Analysis failed")
      setAstState("error")
      return null
    }
  }

  // Action 1: AST only (no Neo4j write). Opens the AST view.
  async function generateAst() {
    setAstOpen(true)
    await runAnalysis(false)
  }

  // Build the Neo4j graph from a tree, then show the result panel.
  async function graphFromTree(t: RepoTree) {
    if (!repo) return
    setGraphState("running")
    setGraphError(null)
    setGraphInfo(null)
    try {
      const info = await buildGraph(repo.full_name, t)
      setGraphInfo(info)
      setGraphState("done")
    } catch (err) {
      setGraphError(err instanceof Error ? err.message : "Graph build failed")
      setGraphState("error")
    }
  }

  // Action 2: knowledge graph. Reuses the existing tree when present (cheap —
  // no refetch/LLM); otherwise builds the AST first, then the graph.
  async function generateGraph() {
    const t = tree ?? (await runAnalysis(false))
    if (t) await graphFromTree(t)
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

  // Crawl the explicit route list. Authenticated routes are visited in a
  // logged-in browser context (the backend logs in once via the login config
  // and reuses that session). The backend captures DOM/screenshot/a11y per
  // route, infers the screen-relationship graph, and uploads screenshots to
  // Supabase Storage; we then persist the run into Postgres.
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
      // Persist and surface the real outcome (no silent drop), then refresh the
      // saved-crawls list so reopening this repo shows it.
      if (repo) {
        const saved = await saveCrawl(repo.full_name, routes, result)
        setCrawlSaved(saved)
        if (saved.ok) {
          fetchCrawls(repo.full_name).then(setSavedCrawls)
        }
      }
    } catch (err) {
      if (controller.signal.aborted) return
      setCrawlError(err instanceof Error ? err.message : "Crawl failed")
      setCrawlState("error")
    }
  }

  // Action 3: build both — AST view + knowledge graph.
  async function buildAll() {
    setAstOpen(true)
    const t = tree ?? (await runAnalysis(false))
    if (t) await graphFromTree(t)
  }

  // Ingest a product spec (PRD / README / wiki) into structured requirements —
  // the Requirements layer — and persist them for the graph + PR reasoning.
  async function runIngest() {
    if (!repo) return
    const source = specSource.trim()
    if (!source) {
      setIngestError("Enter a spec URL or owner/repo")
      setIngestState("error")
      return
    }
    ingestAbortRef.current?.abort()
    const controller = new AbortController()
    ingestAbortRef.current = controller
    setIngestState("running")
    setIngestError(null)
    setRequirements(null)
    setIngestMessage("Parsing spec…")
    try {
      const start = await startIngest({
        full_name: repo.full_name,
        source,
        source_type: specType,
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
    } catch (err) {
      if (controller.signal.aborted) return
      setIngestError(err instanceof Error ? err.message : "Ingest failed")
      setIngestState("error")
    }
  }

  // Connect Requirements + DOM/UI + Code in Neo4j and report coverage/absence.
  async function runConnect() {
    if (!repo) return
    setConnectState("running")
    setConnectError(null)
    setCoverage(null)
    try {
      const cov = await connectLayers(repo.full_name)
      if (cov.skipped) {
        setConnectError(cov.skipped)
        setConnectState("error")
        return
      }
      setCoverage(cov)
      setConnectState("done")
    } catch (err) {
      setConnectError(err instanceof Error ? err.message : "Connect failed")
      setConnectState("error")
    }
  }

  function copyQuery(name: string, cypher: string) {
    void navigator.clipboard.writeText(cypher)
    setCopied(name)
    setTimeout(() => setCopied(null), 1500)
  }

  useEffect(() => {
    if (!open || !repo) return
    let cancelled = false
    setStats(null)
    setError(null)
    setLoading(true)

    fetch(
      `/api/github/repo-stats?owner=${encodeURIComponent(
        repo.owner,
      )}&repo=${encodeURIComponent(repo.name)}`,
    )
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json()).error ?? "Failed")
        return res.json() as Promise<RepoStats>
      })
      .then((data) => {
        if (!cancelled) setStats(data)
      })
      .catch((err) => {
        if (!cancelled) setError(err.message)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [open, repo])

  return (
    <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {repo?.name}
            {repo ? (
              <Badge variant="outline" className="gap-1 text-[10px]">
                {repo.private ? (
                  <LockIcon className="size-2.5" />
                ) : (
                  <GlobeIcon className="size-2.5" />
                )}
                {repo.private ? "Private" : "Public"}
              </Badge>
            ) : null}
          </DialogTitle>
          <DialogDescription>
            {repo?.description ?? "Review insights for this repository"}
          </DialogDescription>
        </DialogHeader>

        {error ? (
          <p className="py-6 text-center text-sm text-destructive">{error}</p>
        ) : (
          <div className="space-y-5">
            <div className="grid grid-cols-2 gap-3">
              <Metric
                icon={<GitPullRequestIcon className="size-4" />}
                label="Pull requests"
                value={stats?.pullRequests}
                loading={loading}
              />
              <Metric
                icon={<GitCommitHorizontalIcon className="size-4" />}
                label="Commits"
                value={stats?.commits}
                loading={loading}
              />
            </div>

            <div>
              <h4 className="mb-2 text-sm font-medium">Tech stack</h4>
              {loading ? (
                <div className="space-y-2">
                  <Skeleton className="h-3 w-full" />
                  <Skeleton className="h-3 w-3/4" />
                </div>
              ) : stats && stats.languages.length > 0 ? (
                <>
                  <div className="flex h-2 overflow-hidden rounded-full bg-muted">
                    {stats.languages.map((l) => (
                      <span
                        key={l.name}
                        className="h-full bg-brand first:rounded-l-full last:rounded-r-full"
                        style={{
                          width: `${l.percent}%`,
                          opacity: 0.4 + l.percent / 160,
                        }}
                      />
                    ))}
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {stats.languages.map((l) => (
                      <Badge key={l.name} variant="secondary" className="gap-1">
                        {l.name}
                        <span className="text-muted-foreground">
                          {l.percent}%
                        </span>
                      </Badge>
                    ))}
                  </div>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No language data available.
                </p>
              )}
            </div>

            <div className="border-t border-border pt-4">
              <h4 className="text-sm font-medium">Code intelligence</h4>
              <p className="text-xs text-muted-foreground">
                Parse the codebase into an AST and mirror it into a Neo4j
                knowledge graph.
              </p>

              {(() => {
                const busy = astState === "running" || graphState === "running"
                return (
                  <div className="mt-3 grid grid-cols-3 gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={generateAst}
                      disabled={busy}
                    >
                      {astState === "running" && graphState !== "running" ? (
                        <Loader2Icon className="size-4 animate-spin" />
                      ) : (
                        <NetworkIcon className="size-4" />
                      )}
                      AST
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={generateGraph}
                      disabled={busy}
                    >
                      {graphState === "running" ? (
                        <Loader2Icon className="size-4 animate-spin" />
                      ) : (
                        <DatabaseIcon className="size-4" />
                      )}
                      Graph
                    </Button>
                    <Button size="sm" onClick={buildAll} disabled={busy}>
                      {busy ? (
                        <Loader2Icon className="size-4 animate-spin" />
                      ) : (
                        <LayersIcon className="size-4" />
                      )}
                      Build all
                    </Button>
                  </div>
                )
              })()}

              {astState === "running" ? (
                <div className="mt-3 space-y-1.5">
                  <Progress value={astProgress} />
                  <p className="truncate text-xs text-muted-foreground">
                    {astProgress}% · {astMessage}
                  </p>
                </div>
              ) : null}

              {astState === "error" ? (
                <p className="mt-3 text-xs text-destructive">{astError}</p>
              ) : null}

              {tree && astState === "done" ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-3 w-full"
                  onClick={() => setAstOpen(true)}
                >
                  <NetworkIcon className="size-4" />
                  View AST graph
                </Button>
              ) : null}

              {graphState === "error" ? (
                <p className="mt-3 text-xs text-destructive">{graphError}</p>
              ) : null}

              {graphState === "done" && graphInfo ? (
                <div className="mt-3 space-y-3 rounded-lg border border-brand/30 bg-brand/5 p-3">
                  <div>
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <DatabaseIcon className="size-4 text-brand" />
                      Connector ·{" "}
                      <span className="font-mono">
                        {graphInfo.connector_name}
                      </span>
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      This codebase&apos;s own isolated subgraph. Paste a query
                      below into the Neo4j console&apos;s Query tab.
                    </p>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <Badge variant="secondary">
                      {graphInfo.nodes_written} nodes
                    </Badge>
                    <Badge variant="secondary">
                      {graphInfo.relationships_written} relationships
                    </Badge>
                    {graphInfo.instance_name ? (
                      <Badge variant="outline">{graphInfo.instance_name}</Badge>
                    ) : null}
                  </div>

                  <div className="space-y-1.5">
                    {graphInfo.queries.map((q) => (
                      <div key={q.name} className="rounded-md bg-muted/60 p-2">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[11px] font-medium">
                            {q.name}
                          </span>
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
                        <code className="mt-1 block break-all font-mono text-[11px] leading-relaxed text-muted-foreground">
                          {q.cypher}
                        </code>
                      </div>
                    ))}
                  </div>

                  <a
                    href={graphInfo.console_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex w-full items-center justify-center gap-1.5 rounded-md bg-brand px-3 py-2 text-sm font-medium text-brand-foreground transition-opacity hover:opacity-90"
                  >
                    <ExternalLinkIcon className="size-4" />
                    Open Neo4j console
                  </a>
                </div>
              ) : null}

              {/* Requirements layer: ingest a product spec into structured
                  requirements, then connect all three graph layers. */}
              <div className="mt-4 border-t border-border pt-4">
                <h4 className="text-sm font-medium">Product spec &amp; layers</h4>
                <p className="text-xs text-muted-foreground">
                  Ingest a PRD / README / wiki into requirements (the
                  &quot;intended&quot; layer), then connect Requirements + UI +
                  Code in Neo4j to see coverage and gaps.
                </p>

                <div className="mt-3 flex gap-2">
                  <select
                    className="rounded-md border border-border bg-background px-2 py-1 text-xs"
                    value={specType}
                    onChange={(e) =>
                      setSpecType(e.target.value as "url" | "github_readme")
                    }
                    disabled={ingestState === "running"}
                  >
                    <option value="url">URL</option>
                    <option value="github_readme">README</option>
                  </select>
                  <Input
                    placeholder={
                      specType === "github_readme"
                        ? "owner/repo"
                        : "https://…/spec or PRD URL"
                    }
                    value={specSource}
                    onChange={(e) => setSpecSource(e.target.value)}
                    disabled={ingestState === "running"}
                  />
                </div>

                <div className="mt-2 grid grid-cols-2 gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={runIngest}
                    disabled={ingestState === "running"}
                  >
                    {ingestState === "running" ? (
                      <Loader2Icon className="size-4 animate-spin" />
                    ) : (
                      <FileTextIcon className="size-4" />
                    )}
                    Ingest spec
                  </Button>
                  <Button
                    size="sm"
                    onClick={runConnect}
                    disabled={connectState === "running"}
                  >
                    {connectState === "running" ? (
                      <Loader2Icon className="size-4 animate-spin" />
                    ) : (
                      <LayersIcon className="size-4" />
                    )}
                    Connect 3 layers
                  </Button>
                </div>

                {ingestState === "running" ? (
                  <p className="mt-2 truncate text-xs text-muted-foreground">
                    {ingestMessage}
                  </p>
                ) : null}
                {ingestState === "error" ? (
                  <p className="mt-2 text-xs text-destructive">{ingestError}</p>
                ) : null}
                {ingestState === "done" && requirements ? (
                  <div className="mt-3 rounded-lg border border-brand/30 bg-brand/5 p-3">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <FileTextIcon className="size-4 text-brand" />
                      {requirements.requirement_count} requirements
                    </div>
                    <ul className="mt-2 space-y-1">
                      {requirements.requirements.slice(0, 6).map((r) => (
                        <li
                          key={r.req_id}
                          className="truncate text-[11px] text-muted-foreground"
                        >
                          <span className="font-mono text-foreground">
                            {r.req_id}
                          </span>{" "}
                          {r.title}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {connectState === "error" ? (
                  <p className="mt-2 text-xs text-destructive">{connectError}</p>
                ) : null}
                {connectState === "done" && coverage ? (
                  <div className="mt-3 space-y-2 rounded-lg border border-brand/30 bg-brand/5 p-3">
                    <div className="flex flex-wrap gap-2">
                      <Badge variant="secondary">
                        {coverage.requirements} requirements
                      </Badge>
                      <Badge variant="secondary">
                        {coverage.screens} screens
                      </Badge>
                      <Badge variant="outline">
                        {coverage.covered_by_ui.length} UI-covered
                      </Badge>
                    </div>
                    {coverage.uncovered_requirements.length > 0 ? (
                      <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2">
                        <p className="flex items-center gap-1.5 text-[11px] font-medium text-amber-600">
                          <ShieldAlertIcon className="size-3.5" />
                          {coverage.uncovered_requirements.length} requirements
                          with no captured UI (absence)
                        </p>
                        <p className="mt-1 font-mono text-[10px] text-muted-foreground">
                          {coverage.uncovered_requirements.join(", ")}
                        </p>
                      </div>
                    ) : (
                      <p className="text-[11px] text-muted-foreground">
                        Every requirement maps to a captured screen.
                      </p>
                    )}
                    <code className="block break-all rounded bg-muted/60 p-1.5 font-mono text-[10px] text-muted-foreground">
                      {coverage.absence_query}
                    </code>
                  </div>
                ) : null}
              </div>

              {/* Live-app crawl: explicit route list with per-route auth. The
                  backend visits each route, captures DOM/screenshot/a11y, and
                  persists everything for the future PR blast-radius step. */}
              <div className="mt-4 border-t border-border pt-4">
                <h4 className="text-sm font-medium">Live application crawl</h4>
                <p className="text-xs text-muted-foreground">
                  List the routes to capture and mark each public or
                  authenticated. The browser visits each, captures DOM +
                  screenshot, and maps how the screens connect.
                </p>

                {savedCrawls.length > 0 ? (
                  <div className="mt-3 flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">
                      Saved crawls:
                    </span>
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

                <Input
                  type="url"
                  inputMode="url"
                  placeholder="Base URL — https://app.example.com"
                  className="mt-3"
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
                  <p className="mt-3 text-xs text-destructive">{crawlError}</p>
                ) : null}

                {crawlState === "done" && crawlResult ? (
                  <div className="mt-3 space-y-3 rounded-lg border border-brand/30 bg-brand/5 p-3">
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
                ) : null}
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>

      <Dialog open={astOpen} onOpenChange={setAstOpen}>
        <DialogContent className="flex h-[90vh] w-[95vw] max-w-[95vw] flex-col sm:max-w-[95vw]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <NetworkIcon className="size-4 text-brand" />
              AST · {repo?.full_name}
              {astState === "running" ? (
                <span className="inline-flex items-center gap-1.5 text-xs font-normal text-muted-foreground">
                  <Loader2Icon className="size-3.5 animate-spin" />
                  {astProgress}% · {astMessage}
                </span>
              ) : null}
            </DialogTitle>
            <DialogDescription>
              {tree?.summary ??
                "Building the abstract syntax tree — nodes turn from gray to color as descriptions stream in. Scroll to zoom, drag to pan."}
            </DialogDescription>
          </DialogHeader>
          {astState === "error" ? (
            <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {astError}
            </p>
          ) : null}
          <div className="min-h-0 flex-1">
            {tree ? (
              <AstGraph tree={tree} />
            ) : astState === "running" ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
                <Loader2Icon className="size-8 animate-spin text-brand" />
                <p className="text-sm font-medium">Building AST · {astProgress}%</p>
                <p className="text-xs">{astMessage}</p>
              </div>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={crawlGraphOpen} onOpenChange={setCrawlGraphOpen}>
        <DialogContent className="flex h-[90vh] w-[95vw] max-w-[95vw] flex-col sm:max-w-[95vw]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <NetworkIcon className="size-4 text-brand" />
              Screen graph · {crawlResult?.base_url}
            </DialogTitle>
            <DialogDescription>
              Nodes are crawled screens; edges are inferred relationships (a link
              on one screen pointing at another). Click a node to inspect the
              browser response captured for that screen.
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

// Right-hand panel: the raw browser response captured for one screen —
// screenshot, rendered DOM, accessibility tree, and interactive elements.
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
        <p className="truncate text-[11px] text-muted-foreground">{screen.url}</p>
      </div>

      {screen.screenshot_url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={screen.screenshot_url}
          alt={screen.label || screen.url}
          className="max-h-48 w-full rounded-md border border-border object-cover object-top"
        />
      ) : null}

      {/* browser-use's structured summary of the screen. */}
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
              {el.text ? <span className="text-foreground">{el.text}</span> : null}
              {el.href ? ` → ${el.href}` : ""}
            </li>
          ))}
          {screen.elements.length === 0 ? (
            <li className="text-[11px] text-muted-foreground">(no links captured)</li>
          ) : null}
        </ul>
      </div>
    </div>
  )
}

function Metric({
  icon,
  label,
  value,
  loading,
}: {
  icon: React.ReactNode
  label: string
  value?: number
  loading: boolean
}) {
  return (
    <div className="rounded-lg border border-border p-4">
      <div className="flex items-center gap-1.5 text-muted-foreground">
        {icon}
        <span className="text-xs">{label}</span>
      </div>
      {loading ? (
        <Skeleton className="mt-2 h-7 w-16" />
      ) : (
        <div className="mt-1 font-mono text-2xl font-semibold">
          {(value ?? 0).toLocaleString()}
        </div>
      )}
    </div>
  )
}
