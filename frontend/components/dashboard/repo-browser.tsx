"use client"

import { useEffect, useMemo, useState } from "react"
import {
  LockIcon,
  GlobeIcon,
  StarIcon,
  GitForkIcon,
  SearchIcon,
  PlusIcon,
  CheckIcon,
} from "lucide-react"
import type { GitHubRepo } from "@/lib/github"
import { cn } from "@/lib/utils"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { RepoStatsDialog } from "@/components/dashboard/repo-stats-dialog"

const STORAGE_KEY = "pullguard:tracked-repos"

export function RepoBrowser({ repos }: { repos: GitHubRepo[] }) {
  const [query, setQuery] = useState("")
  const [tracked, setTracked] = useState<number[]>([])
  const [active, setActive] = useState<GitHubRepo | null>(null)

  // Persist the user's tracked selection across reloads.
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY)
      if (saved) setTracked(JSON.parse(saved))
    } catch {
      /* ignore */
    }
  }, [])

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tracked))
  }, [tracked])

  function toggleTrack(id: number) {
    setTracked((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    )
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return repos
    return repos.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        r.description?.toLowerCase().includes(q),
    )
  }, [repos, query])

  const trackedRepos = repos.filter((r) => tracked.includes(r.id))

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">Repositories</h2>
        <p className="text-sm text-muted-foreground">
          {repos.length} repositories · click a card for review insights, or
          track the ones you want PullGuard to watch.
        </p>
      </div>

      {trackedRepos.length > 0 ? (
        <section className="space-y-3">
          <h3 className="text-sm font-medium text-muted-foreground">
            Tracked ({trackedRepos.length})
          </h3>
          <div className="grid gap-3 sm:grid-cols-2">
            {trackedRepos.map((repo) => (
              <RepoCard
                key={repo.id}
                repo={repo}
                tracked
                onToggle={() => toggleTrack(repo.id)}
                onOpen={() => setActive(repo)}
              />
            ))}
          </div>
        </section>
      ) : null}

      <div className="relative">
        <SearchIcon className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search repositories…"
          className="pl-9"
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {filtered.map((repo) => (
          <RepoCard
            key={repo.id}
            repo={repo}
            tracked={tracked.includes(repo.id)}
            onToggle={() => toggleTrack(repo.id)}
            onOpen={() => setActive(repo)}
          />
        ))}
        {filtered.length === 0 ? (
          <p className="col-span-full py-10 text-center text-sm text-muted-foreground">
            No repositories match &ldquo;{query}&rdquo;.
          </p>
        ) : null}
      </div>

      <RepoStatsDialog
        repo={active}
        open={active !== null}
        onOpenChange={(o) => !o && setActive(null)}
      />
    </div>
  )
}

function RepoCard({
  repo,
  tracked,
  onToggle,
  onOpen,
}: {
  repo: GitHubRepo
  tracked: boolean
  onToggle: () => void
  onOpen: () => void
}) {
  return (
    <Card
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault()
          onOpen()
        }
      }}
      className="cursor-pointer transition-colors hover:border-brand/40 focus-visible:border-brand focus-visible:outline-none"
    >
      <CardContent className="flex flex-col gap-3 p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate font-medium">{repo.name}</span>
              <Badge variant="outline" className="gap-1 text-[10px]">
                {repo.private ? (
                  <LockIcon className="size-2.5" />
                ) : (
                  <GlobeIcon className="size-2.5" />
                )}
                {repo.private ? "Private" : "Public"}
              </Badge>
            </div>
            <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
              {repo.description ?? "No description"}
            </p>
          </div>
          <Button
            variant={tracked ? "secondary" : "ghost"}
            size="icon"
            className={cn("size-7 shrink-0", tracked && "text-brand")}
            onClick={(e) => {
              e.stopPropagation()
              onToggle()
            }}
            aria-label={tracked ? "Untrack repository" : "Track repository"}
          >
            {tracked ? (
              <CheckIcon className="size-4" />
            ) : (
              <PlusIcon className="size-4" />
            )}
          </Button>
        </div>

        <div className="flex items-center gap-4 text-xs text-muted-foreground">
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
        </div>
      </CardContent>
    </Card>
  )
}
