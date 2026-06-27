"use client"

import { useEffect, useMemo, useRef } from "react"
import {
  Chart,
  LinearScale,
  PointElement,
  Tooltip,
  type ChartConfiguration,
} from "chart.js"
import { ForceDirectedGraphController, EdgeLine } from "chartjs-chart-graph"
import zoomPlugin from "chartjs-plugin-zoom"
import type { CrawlResult, ScreenInfo } from "@/lib/crawl"

Chart.register(
  LinearScale,
  PointElement,
  Tooltip,
  ForceDirectedGraphController,
  EdgeLine,
  zoomPlugin,
)

const AUTH_COLOR = "#f59e0b" // authenticated screen
const PUB_COLOR = "#0ea5e9" // public screen

// A force-directed graph of crawled screens. Nodes = screens, edges =
// inferred screen relationships (a link on screen A pointing at screen B).
// Clicking a node selects it so the parent can show that screen's captured
// browser response.
export function CrawlGraph({
  result,
  onSelect,
}: {
  result: CrawlResult
  onSelect?: (s: ScreenInfo) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const chartRef = useRef<Chart | null>(null)
  const screensRef = useRef<ScreenInfo[]>([])

  const graph = useMemo(() => {
    const screens = result.screens
    const idx = new Map(screens.map((s, i) => [s.screen_id, i]))
    const labels = screens.map((s) => s.label || s.title || s.url)
    const edges = result.transitions
      .map((t) => ({ source: idx.get(t.from_screen), target: idx.get(t.to_screen) }))
      .filter((e) => e.source != null && e.target != null) as {
      source: number
      target: number
    }[]
    return { screens, labels, edges }
  }, [result])

  const structureKey = `${result.run_id}:${graph.screens.length}:${graph.edges.length}`

  useEffect(() => {
    if (!canvasRef.current || graph.screens.length === 0) return
    // Set here (not during render): the chart's long-lived tooltip/onClick
    // callbacks read the latest screens via this ref.
    screensRef.current = graph.screens

    const config: ChartConfiguration<"forceDirectedGraph"> = {
      type: "forceDirectedGraph",
      data: {
        labels: graph.labels,
        datasets: [
          {
            data: graph.screens.map(() => ({})) as never,
            edges: graph.edges as never,
            pointRadius: 7,
            pointHoverRadius: 10,
            pointBackgroundColor: graph.screens.map((s) =>
              s.authenticated ? AUTH_COLOR : PUB_COLOR,
            ) as never,
            pointBorderColor: "#ffffff",
            pointBorderWidth: 1.5,
            edgeLineBorderColor: "rgba(148, 163, 184, 0.5)",
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
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (c: { dataIndex: number }) => {
                const s = screensRef.current[c.dataIndex]
                return s ? `${s.authenticated ? "🔒" : "🌐"} ${s.label || s.title || s.url}` : ""
              },
            },
          },
          zoom: {
            pan: { enabled: true, mode: "xy" },
            zoom: { wheel: { enabled: true }, pinch: { enabled: true }, mode: "xy" },
          },
        },
        onClick: (_e: unknown, els: { index: number }[]) => {
          const el = els?.[0]
          if (!el) return
          const s = screensRef.current[el.index]
          if (s) onSelect?.(s)
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

  function resetView() {
    ;(chartRef.current as unknown as { resetZoom?: () => void })?.resetZoom?.()
  }

  return (
    <div className="relative h-full w-full overflow-hidden rounded-lg border border-border bg-card">
      <canvas ref={canvasRef} className="size-full" />

      {graph.screens.length === 0 ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <p className="rounded-md bg-background/80 px-3 py-2 text-sm text-muted-foreground backdrop-blur">
            No screens captured.
          </p>
        </div>
      ) : null}

      <div className="absolute right-3 top-3 flex items-center gap-2">
        <span className="rounded-md border border-border bg-background/80 px-2.5 py-1 text-xs text-muted-foreground backdrop-blur">
          {graph.screens.length} screens · {graph.edges.length} edges
        </span>
        <button
          type="button"
          onClick={resetView}
          className="pointer-events-auto rounded-md border border-border bg-background/80 px-2.5 py-1 text-xs backdrop-blur hover:bg-muted"
        >
          Reset view
        </button>
      </div>

      <div className="absolute bottom-3 left-3 flex flex-wrap gap-3 rounded-md border border-border bg-background/80 px-3 py-2 text-[11px] backdrop-blur">
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2.5 rounded-full" style={{ background: PUB_COLOR }} />
          public
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2.5 rounded-full" style={{ background: AUTH_COLOR }} />
          authenticated
        </span>
        <span className="text-muted-foreground">click a node to inspect</span>
      </div>
    </div>
  )
}
