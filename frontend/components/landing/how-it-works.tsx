const steps = [
  {
    n: "01",
    title: "Connect your repository",
    body: "Authorize PullGuard with GitHub. Pick the repos you want reviewed. Nothing leaves your account.",
  },
  {
    n: "02",
    title: "Open a pull request",
    body: "PullGuard reads the diff in full context, runs your tests in a sandbox, and reasons about intent across files.",
  },
  {
    n: "03",
    title: "Review lands inline",
    body: "Findings, severities, and ready-to-commit fixes appear in the PR thread — before CI finishes.",
  },
]

export function HowItWorks() {
  return (
    <section
      id="how-it-works"
      className="border-y border-border/60 bg-muted/30"
    >
      <div className="mx-auto w-full max-w-6xl px-6 py-24">
        <div className="mx-auto max-w-2xl text-center">
          <p className="text-sm font-semibold text-brand">How it works</p>
          <h2 className="mt-3 text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
            From connect to fix in three steps
          </h2>
        </div>

        <ol className="mt-14 grid gap-8 md:grid-cols-3">
          {steps.map((s) => (
            <li key={s.n} className="relative flex flex-col gap-3">
              <span className="font-mono text-sm font-semibold text-brand">
                {s.n}
              </span>
              <span className="h-px w-12 bg-brand/40" />
              <h3 className="text-lg font-semibold">{s.title}</h3>
              <p className="text-sm leading-relaxed text-muted-foreground">
                {s.body}
              </p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  )
}
