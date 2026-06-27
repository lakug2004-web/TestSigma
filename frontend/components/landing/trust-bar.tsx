const logos = ["Northwind", "Acme", "Globex", "Hooli", "Initech", "Umbrella"]

export function TrustBar() {
  return (
    <section className="border-y border-border/60 bg-muted/30">
      <div className="mx-auto w-full max-w-6xl px-6 py-10">
        <p className="text-center text-xs font-medium uppercase tracking-widest text-muted-foreground">
          Trusted by engineering teams shipping every day
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-x-12 gap-y-4">
          {logos.map((name) => (
            <span
              key={name}
              className="text-lg font-semibold tracking-tight text-muted-foreground/70"
            >
              {name}
            </span>
          ))}
        </div>
      </div>
    </section>
  )
}
