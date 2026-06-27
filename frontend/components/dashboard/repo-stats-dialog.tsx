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
  }, [repo])

  // Abort any in-flight poll on unmount.
  useEffect(() => () => abortRef.current?.abort(), [])

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

  // Action 3: build both — AST view + knowledge graph.
  async function buildAll() {
    setAstOpen(true)
    const t = tree ?? (await runAnalysis(false))
    if (t) await graphFromTree(t)
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
    </>
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
