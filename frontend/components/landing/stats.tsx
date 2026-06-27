const stats = [
  { value: "1.2M", label: "PRs reviewed weekly" },
  { value: "<60s", label: "Median time to first comment" },
  { value: "38%", label: "Fewer bugs reaching main" },
  { value: "12k+", label: "Repositories connected" },
]

export function Stats() {
  return (
    <section className="mx-auto w-full max-w-6xl px-6 py-24">
      <div className="grid gap-px overflow-hidden rounded-2xl border border-border bg-border sm:grid-cols-2 lg:grid-cols-4">
        {stats.map((s) => (
          <div key={s.label} className="bg-background p-8 text-center">
            <div className="font-mono text-4xl font-semibold tracking-tight text-brand">
              {s.value}
            </div>
            <p className="mt-2 text-sm text-muted-foreground">{s.label}</p>
          </div>
        ))}
      </div>
    </section>
  )
}
