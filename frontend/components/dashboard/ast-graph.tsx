"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import {
  Chart,
  LinearScale,
  PointElement,
  Tooltip,
  type ChartConfiguration,
} from "chart.js"
import { TreeController, EdgeLine } from "chartjs-chart-graph"
import zoomPlugin from "chartjs-plugin-zoom"
import type { RepoTree } from "@/lib/analyze"

Chart.register(LinearScale, PointElement, Tooltip, TreeController, EdgeLine, zoomPlugin)

type NodeKind = "repo" | "file" | "class" | "function" | "method"

type NodeMeta = {
  kind: NodeKind
  label: string
  signature?: string
  subtitle?: string
  description: string
  described: boolean
}

const KIND_COLOR: Record<NodeKind, string> = {
  repo: "#6366f1",
  file: "#0ea5e9",
  class: "#8b5cf6",
  function: "#10b981",
  method: "#14b8a6",
}
const GRAY = "#cbd5e1" // node whose description hasn't streamed in yet

type FlatGraph = {
  nodes: { parent?: number }[]
  labels: string[]
  meta: NodeMeta[]
}

function shortName(path: string): string {
  const parts = path.split("/")
  return parts[parts.length - 1] || path
}

// Flatten RepoTree -> parent-indexed node list for the tree controller.
function flatten(tree: RepoTree): FlatGraph {
  const nodes: { parent?: number }[] = []
  const labels: string[] = []
  const meta: NodeMeta[] = []

  const push = (parent: number | undefined, label: string, m: NodeMeta): number => {
    const idx = nodes.length
    nodes.push({ parent })
    labels.push(label)
    meta.push(m)
    return idx
  }

  const repoIdx = push(undefined, shortName(tree.full_name), {
    kind: "repo",
    label: tree.full_name,
    subtitle: tree.ref || "default branch",
    description: tree.summary || "Repository abstract syntax tree.",
    described: Boolean(tree.summary),
  })

  for (const file of tree.files) {
    const fileIdx = push(repoIdx, shortName(file.path), {
      kind: "file",
      label: file.path,
      subtitle: file.parsed ? `${file.loc} lines` : "parse error",
      description:
        file.description ||
        (file.parsed ? "Awaiting description…" : file.parse_error ?? ""),
      described: Boolean(file.description),
    })

    for (const cls of file.classes) {
      const classIdx = push(fileIdx, cls.name, {
        kind: "class",
        label: cls.name,
        signature: cls.bases.length
          ? `class ${cls.name}(${cls.bases.join(", ")})`
          : `class ${cls.name}`,
        subtitle: file.path,
        description: cls.description || "Awaiting description…",
        described: Boolean(cls.description),
      })
      for (const m of cls.methods) {
        push(classIdx, m.name, {
          kind: "method",
          label: `${cls.name}.${m.name}`,
          signature: `${m.is_async ? "async " : ""}${m.name}(${m.args.join(", ")})`,
          subtitle: `${file.path} · lines ${m.lineno}-${m.end_lineno}`,
          description: m.description || "Awaiting description…",
          described: Boolean(m.description),
        })
      }
    }

    for (const fn of file.functions) {
      push(fileIdx, fn.name, {
        kind: "function",
        label: fn.name,
        signature: `${fn.is_async ? "async " : ""}${fn.name}(${fn.args.join(", ")})`,
        subtitle: `${file.path} · lines ${fn.lineno}-${fn.end_lineno}`,
        description: fn.description || "Awaiting description…",
        described: Boolean(fn.description),
      })
    }
  }

  return { nodes, labels, meta }
}

type TooltipState = { visible: boolean; x: number; y: number; meta: NodeMeta | null }

export function AstGraph({ tree }: { tree: RepoTree | null }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const chartRef = useRef<Chart | null>(null)
  const metaRef = useRef<NodeMeta[]>([])
  const [tip, setTip] = useState<TooltipState>({
    visible: false,
    x: 0,
    y: 0,
    meta: null,
  })

  const flat = useMemo(() => (tree ? flatten(tree) : null), [tree])
  // Keep the latest meta available to the (long-lived) chart tooltip + colors.
  metaRef.current = flat?.meta ?? []

  // Re-create the chart only when the *structure* changes (node count), so
  // streaming description updates don't reset pan/zoom.
  const structureKey = `${tree?.full_name ?? ""}:${flat?.nodes.length ?? 0}`
  // Bump on each new description so colors refresh without a rebuild.
  const describedKey = flat?.meta.filter((m) => m.described).length ?? 0

  useEffect(() => {
    if (!canvasRef.current || !flat || flat.nodes.length === 0) return

    const colorFor = (i: number) => {
      const m = metaRef.current[i]
      return m?.described ? KIND_COLOR[m.kind] : GRAY
    }

    function externalTooltip(ctx: {
      chart: Chart
      tooltip: import("chart.js").TooltipModel<"graph">
    }) {
      const model = ctx.tooltip
      if (model.opacity === 0) {
        setTip((t) => (t.visible ? { ...t, visible: false } : t))
        return
      }
      const dp = model.dataPoints?.[0]
      if (!dp) return
      setTip({
        visible: true,
        x: model.caretX,
        y: model.caretY,
        meta: metaRef.current[dp.dataIndex] ?? null,
      })
    }

    const config: ChartConfiguration<"tree"> = {
      type: "tree",
      data: {
        labels: flat.labels,
        datasets: [
          {
            data: flat.nodes,
            pointRadius: 5,
            pointHoverRadius: 8,
            pointBackgroundColor: (c: { dataIndex: number }) => colorFor(c.dataIndex),
            pointBorderColor: "#ffffff",
            pointBorderWidth: 1,
            edgeLineBorderColor: "rgba(148, 163, 184, 0.45)",
            edgeLineBorderWidth: 1,
            directed: true,
          } as never,
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        layout: { padding: 32 },
        tree: { orientation: "horizontal" },
        plugins: {
          legend: { display: false },
          tooltip: {
            enabled: false,
            position: "nearest",
            external: externalTooltip as never,
          },
          zoom: {
            pan: { enabled: true, mode: "xy" },
            zoom: {
              wheel: { enabled: true },
              pinch: { enabled: true },
              mode: "xy",
            },
          },
        },
      } as never,
    }

    chartRef.current = new Chart(canvasRef.current, config as never)
    return () => {
      chartRef.current?.destroy()
      chartRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structureKey])

  // Streaming color refresh: descriptions arrived -> recolor in place.
  useEffect(() => {
    chartRef.current?.update("none")
  }, [describedKey])

  function resetView() {
    // chartjs-plugin-zoom augments the instance with resetZoom().
    ;(chartRef.current as unknown as { resetZoom?: () => void })?.resetZoom?.()
  }

  return (
    <div className="relative h-full w-full overflow-hidden rounded-lg border border-border bg-card">
      <canvas ref={canvasRef} className="size-full" />

      {!tree || (flat && flat.nodes.length <= 1) ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <p className="rounded-md bg-background/80 px-3 py-2 text-sm text-muted-foreground backdrop-blur">
            {!tree
              ? "Waiting for AST…"
              : "No Python files found in this repository."}
          </p>
        </div>
      ) : null}

      <div className="absolute right-3 top-3 flex items-center gap-2">
        {flat && flat.nodes.length > 0 ? (
          <span className="rounded-md border border-border bg-background/80 px-2.5 py-1 text-xs text-muted-foreground backdrop-blur">
            {flat.nodes.length} nodes · {describedKey} described
          </span>
        ) : null}
        <button
          type="button"
          onClick={resetView}
          className="pointer-events-auto rounded-md border border-border bg-background/80 px-2.5 py-1 text-xs backdrop-blur hover:bg-muted"
        >
          Reset view
        </button>
      </div>

      {tip.visible && tip.meta ? (
        <div
          className="pointer-events-none absolute z-10 w-72 max-w-[80%] -translate-x-1/2 -translate-y-full rounded-lg border border-border bg-popover p-3 shadow-lg"
          style={{ left: tip.x, top: tip.y - 12 }}
        >
          <div className="mb-1 flex items-center gap-2">
            <span
              className="size-2.5 rounded-full"
              style={{ background: tip.meta.described ? KIND_COLOR[tip.meta.kind] : GRAY }}
            />
            <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              {tip.meta.kind}
            </span>
            {!tip.meta.described ? (
              <span className="text-[10px] text-muted-foreground">· describing…</span>
            ) : null}
          </div>
          <p className="break-words font-mono text-sm font-semibold">{tip.meta.label}</p>
          {tip.meta.signature ? (
            <p className="mt-0.5 break-words font-mono text-[11px] text-muted-foreground">
              {tip.meta.signature}
            </p>
          ) : null}
          {tip.meta.subtitle ? (
            <p className="mt-0.5 break-words text-[11px] text-muted-foreground">
              {tip.meta.subtitle}
            </p>
          ) : null}
          <p className="mt-2 text-xs leading-relaxed text-foreground/90">
            {tip.meta.description}
          </p>
        </div>
      ) : null}

      <div className="absolute bottom-3 left-3 flex flex-wrap gap-3 rounded-md border border-border bg-background/80 px-3 py-2 text-[11px] backdrop-blur">
        {(Object.keys(KIND_COLOR) as NodeKind[]).map((k) => (
          <span key={k} className="inline-flex items-center gap-1.5">
            <span className="size-2.5 rounded-full" style={{ background: KIND_COLOR[k] }} />
            {k}
          </span>
        ))}
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2.5 rounded-full" style={{ background: GRAY }} />
          pending
        </span>
      </div>
    </div>
  )
}
