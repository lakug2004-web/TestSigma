"use client"

import { useEffect, useState } from "react"
import {
  GitPullRequestIcon,
  GitCommitHorizontalIcon,
  LockIcon,
  GlobeIcon,
} from "lucide-react"
import type { GitHubRepo, RepoStats } from "@/lib/github"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"

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
          </div>
        )}
      </DialogContent>
    </Dialog>
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
