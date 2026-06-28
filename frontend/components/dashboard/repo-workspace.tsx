"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import {
  ArrowLeftIcon,
  LockIcon,
  GlobeIcon,
  StarIcon,
  GitForkIcon,
  ExternalLinkIcon,
  GitPullRequestIcon,
  GitCommitHorizontalIcon,
} from "lucide-react"
import type { GitHubRepo, RepoStats } from "@/lib/github"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { PrList } from "@/components/dashboard/pr-list"
import { RepoTools } from "@/components/dashboard/repo-tools"

export function RepoWorkspace({ repo }: { repo: GitHubRepo }) {
  const [stats, setStats] = useState<RepoStats | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch(
      `/api/github/repo-stats?owner=${encodeURIComponent(
        repo.owner,
      )}&repo=${encodeURIComponent(repo.name)}`,
    )
      .then((res) => (res.ok ? res.json() : null))
      .then((d) => !cancelled && setStats(d))
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [repo])

  return (
    <div className="flex flex-col gap-8">
      <div>
        <Link
          href="/dashboard"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeftIcon className="size-4" />
          All repositories
        </Link>

        <div className="mt-4 flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-2xl font-semibold tracking-tight">
                {repo.full_name}
              </h1>
              <Badge variant="outline" className="gap-1 text-[10px]">
                {repo.private ? (
                  <LockIcon className="size-2.5" />
                ) : (
                  <GlobeIcon className="size-2.5" />
                )}
                {repo.private ? "Private" : "Public"}
              </Badge>
            </div>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              {repo.description ?? "No description"}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
              {repo.language ? (
                <span className="inline-flex items-center gap-1.5">
                  <span className="size-2 rounded-full bg-brand" />
                  {repo.language}
                </span>
              ) : null}
              <span className="inline-flex items-center gap-1">
                <StarIcon className="size-3" />
                {repo.stargazers_count}
              </span>
              <span className="inline-flex items-center gap-1">
                <GitForkIcon className="size-3" />
                {repo.forks_count}
              </span>
              <a
                href={repo.html_url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 hover:text-foreground"
              >
                <ExternalLinkIcon className="size-3" />
                Open on GitHub
              </a>
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:max-w-md">
        <Metric
          icon={<GitPullRequestIcon className="size-4" />}
          label="Pull requests"
          value={stats?.pullRequests}
        />
        <Metric
          icon={<GitCommitHorizontalIcon className="size-4" />}
          label="Commits"
          value={stats?.commits}
        />
      </div>

      <section className="space-y-4">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">
            Analysis tools
          </h2>
          <p className="text-sm text-muted-foreground">
            Build the knowledge graph, ingest the codebase docs, and crawl the
            live app — all inline, right here on the repository.
          </p>
        </div>
        <RepoTools repo={repo} />
      </section>

      <section className="space-y-4">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">
            Pull requests
          </h2>
          <p className="text-sm text-muted-foreground">
            Every PR is fetched from GitHub, persisted to the database, and shown
            with its blast-radius review.
          </p>
        </div>
        <PrList repo={repo} />
      </section>
    </div>
  )
}

function Metric({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode
  label: string
  value?: number
}) {
  return (
    <div className="rounded-lg border border-border p-4">
      <div className="flex items-center gap-1.5 text-muted-foreground">
        {icon}
        <span className="text-xs">{label}</span>
      </div>
      {value === undefined ? (
        <Skeleton className="mt-2 h-7 w-16" />
      ) : (
        <div className="mt-1 font-mono text-2xl font-semibold">
          {value.toLocaleString()}
        </div>
      )}
    </div>
  )
}
