"use client"

import { useEffect, useRef, useState } from "react"
import {
  GitPullRequestIcon,
  GitCommitHorizontalIcon,
  LockIcon,
  GlobeIcon,
  NetworkIcon,
  Loader2Icon,
} from "lucide-react"
import type { GitHubRepo, RepoStats } from "@/lib/github"
import type { RepoTree } from "@/lib/analyze"
import {
  startAnalysis,
  pollUntilDone,
  saveAst,
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

  // Reset AST state whenever a different repo is opened.
  useEffect(() => {
    abortRef.current?.abort()
    abortRef.current = null
    setAstState("idle")
    setAstProgress(0)
    setAstMessage("")
    setAstError(null)
    setTree(null)
    setAstOpen(false)
  }, [repo])

  // Abort any in-flight poll on unmount.
  useEffect(() => () => abortRef.current?.abort(), [])

  async function runAst() {
    if (!repo) return
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setAstState("running")
    setAstError(null)
    setAstProgress(0)
    setAstMessage("Starting…")
    setTree(null)
    setAstOpen(true) // open immediately so the loader is visible
    try {
      let start = await startAnalysis({
        full_name: repo.full_name,
        owner: repo.owner,
        repo: repo.name,
      })

      // Cache hit — serve the stored AST only if it actually has descriptions.
      // A previously failed run (e.g. bad model) cached an empty tree; regenerate.
      if (start.cached) {
        if (treeHasDescriptions(start.tree)) {
          setTree(start.tree)
          setAstState("done")
          setAstMessage("Loaded from cache")
          return
        }
        start = await startAnalysis({
          full_name: repo.full_name,
          owner: repo.owner,
          repo: repo.name,
          refresh: true,
        })
      }

      if (start.cached) {
        // refresh somehow returned cache again; just use it
        setTree(start.tree)
        setAstState("done")
        return
      }

      const result = await pollUntilDone(
        start.jobId,
        (s) => {
          setAstProgress(Math.round(s.progress * 100))
          setAstMessage(s.message)
        },
        controller.signal,
      )
      setTree(result)
      setAstState("done")
      // Persist only when descriptions succeeded, so failures aren't cached.
      if (treeHasDescriptions(result)) void saveAst(repo.full_name, result)
    } catch (err) {
      if (controller.signal.aborted) return
      setAstError(err instanceof Error ? err.message : "Analysis failed")
      setAstState("error")
    }
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
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h4 className="text-sm font-medium">Abstract Syntax Tree</h4>
                  <p className="text-xs text-muted-foreground">
                    Parse the codebase and describe every file, class &amp;
                    function.
                  </p>
                </div>
                <div className="flex gap-2">
                  {tree ? (
                    <Button
                      size="sm"
                      variant={astState === "done" ? "default" : "secondary"}
                      onClick={() => setAstOpen(true)}
                    >
                      <NetworkIcon className="size-4" />
                      View AST
                    </Button>
                  ) : null}
                  {astState !== "done" ? (
                    <Button
                      size="sm"
                      variant={tree ? "ghost" : "default"}
                      onClick={runAst}
                      disabled={astState === "running"}
                    >
                      {astState === "running" ? (
                        <Loader2Icon className="size-4 animate-spin" />
                      ) : (
                        <NetworkIcon className="size-4" />
                      )}
                      {astState === "running" ? "Streaming…" : "Generate AST"}
                    </Button>
                  ) : null}
                </div>
              </div>

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
