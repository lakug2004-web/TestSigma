"use client"

import { useEffect, useState } from "react"
import {
  GitPullRequestIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  Loader2Icon,
  ExternalLinkIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  MessageSquareIcon,
} from "lucide-react"
import type { GitHubRepo, GitHubPullDetail } from "@/lib/github"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"

// A persisted pr_review row as returned by /api/github/pulls. Holds GitHub
// metadata plus the webhook reasoner's blast-radius review (when reviewed).
export type PrRow = {
  id: string
  prNumber: number
  title: string
  author: string
  state: "open" | "closed" | "merged"
  url: string
  headRef: string
  baseRef: string
  reviewed: boolean
  verdict: string
  risk: string
  goodEnough: boolean
  summary: string
  blastRadius: BlastRadius
  reviewedAt: string | null
  updatedAt: string
}

type BlastRadius = {
  changes_made?: string[]
  ui_at_risk?: string[]
  flows_affected?: string[]
  requirements_at_risk?: string[]
  issues_addressed?: string[]
  suggestions?: string[]
}

const STATE_META: Record<
  PrRow["state"],
  { icon: typeof GitPullRequestIcon; label: string; cls: string }
> = {
  open: { icon: GitPullRequestIcon, label: "Open", cls: "text-emerald-500" },
  merged: { icon: GitMergeIcon, label: "Merged", cls: "text-violet-500" },
  closed: { icon: GitPullRequestClosedIcon, label: "Closed", cls: "text-red-500" },
}

function riskVariant(risk: string): "default" | "secondary" | "destructive" {
  if (risk === "high") return "destructive"
  if (risk === "medium") return "secondary"
  return "default"
}

export function PrList({ repo }: { repo: GitHubRepo }) {
  const [rows, setRows] = useState<PrRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [active, setActive] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false
    setRows(null)
    setError(null)
    fetch(
      `/api/github/pulls?owner=${encodeURIComponent(
        repo.owner,
      )}&repo=${encodeURIComponent(repo.name)}`,
    )
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json()).error ?? "Failed")
        return res.json() as Promise<{ pulls: PrRow[] }>
      })
      .then((d) => {
        if (cancelled) return
        setRows(d.pulls)
        if (d.pulls.length > 0) setActive(d.pulls[0].prNumber)
      })
      .catch((e) => !cancelled && setError(e.message))
    return () => {
      cancelled = true
    }
  }, [repo])

  if (error) {
    return (
      <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-6 text-center text-sm text-destructive">
        {error}
      </p>
    )
  }

  if (!rows) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-full" />
        ))}
      </div>
    )
  }

  if (rows.length === 0) {
    return (
      <p className="rounded-lg border border-border px-4 py-10 text-center text-sm text-muted-foreground">
        No pull requests found for this repository.
      </p>
    )
  }

  const reviewed = rows.filter((r) => r.reviewed).length

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,360px)_1fr]">
      <div className="flex flex-col gap-2">
        <p className="text-xs text-muted-foreground">
          {rows.length} pull requests · {reviewed} reviewed · persisted in DB
        </p>
        {rows.map((pr) => {
          const meta = STATE_META[pr.state]
          const Icon = meta.icon
          return (
            <button
              key={pr.id}
              type="button"
              onClick={() => setActive(pr.prNumber)}
              className={`rounded-lg border p-3 text-left transition-colors ${
                active === pr.prNumber
                  ? "border-brand bg-brand/5"
                  : "border-border hover:border-brand/40"
              }`}
            >
              <div className="flex items-start gap-2">
                <Icon className={`mt-0.5 size-4 shrink-0 ${meta.cls}`} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{pr.title}</p>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    #{pr.prNumber} · {pr.author || "unknown"} · {pr.headRef} →{" "}
                    {pr.baseRef}
                  </p>
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    <Badge variant="outline" className="text-[10px]">
                      {meta.label}
                    </Badge>
                    {pr.reviewed ? (
                      <Badge
                        variant={riskVariant(pr.risk)}
                        className="gap-1 text-[10px]"
                      >
                        <ShieldAlertIcon className="size-2.5" />
                        {pr.risk || "reviewed"}
                      </Badge>
                    ) : (
                      <Badge variant="secondary" className="text-[10px]">
                        not reviewed
                      </Badge>
                    )}
                  </div>
                </div>
              </div>
            </button>
          )
        })}
      </div>

      <PrDetail repo={repo} number={active} row={rows.find((r) => r.prNumber === active) ?? null} />
    </div>
  )
}

function PrDetail({
  repo,
  number,
  row,
}: {
  repo: GitHubRepo
  number: number | null
  row: PrRow | null
}) {
  const [detail, setDetail] = useState<GitHubPullDetail | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (number === null) return
    let cancelled = false
    setDetail(null)
    setLoading(true)
    fetch(
      `/api/github/pulls/${number}?owner=${encodeURIComponent(
        repo.owner,
      )}&repo=${encodeURIComponent(repo.name)}`,
    )
      .then((res) => res.json())
      .then((d) => !cancelled && setDetail(d.detail ?? null))
      .catch(() => {})
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [repo, number])

  if (!row || number === null) {
    return (
      <div className="flex items-center justify-center rounded-lg border border-border text-sm text-muted-foreground">
        Select a pull request
      </div>
    )
  }

  const br = row.blastRadius ?? {}

  return (
    <div className="min-h-0 space-y-4 rounded-lg border border-border p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-base font-semibold leading-tight">{row.title}</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            #{row.prNumber} · {row.author} · {row.headRef} → {row.baseRef}
          </p>
        </div>
        <a
          href={row.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
        >
          <ExternalLinkIcon className="size-3.5" />
          GitHub
        </a>
      </div>

      <div className="flex flex-wrap gap-3">
        <Stat label="Commits" value={loading ? null : detail?.commits} />
        <Stat label="Files" value={loading ? null : detail?.changed_files} />
        <Stat
          label="+Added"
          value={loading ? null : detail?.additions}
          cls="text-emerald-500"
        />
        <Stat
          label="-Removed"
          value={loading ? null : detail?.deletions}
          cls="text-red-500"
        />
        <Stat label="Comments" value={loading ? null : detail?.comments} />
      </div>

      {detail?.body ? (
        <div>
          <h4 className="mb-1 text-xs font-medium text-muted-foreground">
            Description
          </h4>
          <p className="max-h-32 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/40 p-2 text-xs">
            {detail.body}
          </p>
        </div>
      ) : null}

      {/* Blast-radius review from the webhook reasoner (when present). */}
      {row.reviewed ? (
        <div className="space-y-3 rounded-lg border border-brand/30 bg-brand/5 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <ShieldCheckIcon className="size-4 text-brand" />
            <span className="text-sm font-medium">PullGuard review</span>
            {row.verdict ? (
              <Badge variant="outline" className="text-[10px]">
                {row.verdict.replace("_", " ")}
              </Badge>
            ) : null}
            <Badge variant={riskVariant(row.risk)} className="text-[10px]">
              {row.risk || "—"} risk
            </Badge>
            <Badge
              variant={row.goodEnough ? "default" : "secondary"}
              className="text-[10px]"
            >
              {row.goodEnough ? "good enough" : "needs work"}
            </Badge>
          </div>
          {row.summary ? <p className="text-xs">{row.summary}</p> : null}
          <BlastSection title="Changes made" items={br.changes_made} />
          <BlastSection title="UI at risk" items={br.ui_at_risk} />
          <BlastSection title="Flows affected" items={br.flows_affected} />
          <BlastSection
            title="Requirements at risk"
            items={br.requirements_at_risk}
          />
          <BlastSection title="Issues addressed" items={br.issues_addressed} />
          <BlastSection title="Suggestions" items={br.suggestions} />
        </div>
      ) : (
        <p className="flex items-center gap-1.5 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          <MessageSquareIcon className="size-3.5" />
          Not yet reviewed. Open or update this PR to trigger the webhook
          blast-radius reasoner.
        </p>
      )}
    </div>
  )
}

function Stat({
  label,
  value,
  cls,
}: {
  label: string
  value?: number | null
  cls?: string
}) {
  return (
    <div className="rounded-md border border-border px-3 py-2">
      <p className="text-[10px] text-muted-foreground">{label}</p>
      {value === null ? (
        <Loader2Icon className="mt-1 size-4 animate-spin text-muted-foreground" />
      ) : (
        <p className={`font-mono text-sm font-semibold ${cls ?? ""}`}>
          {(value ?? 0).toLocaleString()}
        </p>
      )}
    </div>
  )
}

function BlastSection({ title, items }: { title: string; items?: string[] }) {
  if (!items || items.length === 0) return null
  return (
    <div>
      <h4 className="mb-1 text-[11px] font-medium text-muted-foreground">
        {title}
      </h4>
      <ul className="space-y-1">
        {items.map((it, i) => (
          <li key={i} className="text-[11px] leading-relaxed">
            • {it}
          </li>
        ))}
      </ul>
    </div>
  )
}
