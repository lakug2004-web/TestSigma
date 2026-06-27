import Link from "next/link"
import { Button } from "@/components/ui/button"
import { GithubMark } from "@/components/landing/github-mark"

export function Cta() {
  return (
    <section id="pricing" className="mx-auto w-full max-w-6xl px-6 pb-24">
      <div className="relative overflow-hidden rounded-3xl border border-brand/20 bg-zinc-950 px-8 py-16 text-center sm:px-16">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(50%_60%_at_50%_0%,var(--brand-muted),transparent_70%)] opacity-30"
        />
        <h2 className="relative text-balance text-3xl font-semibold tracking-tight text-white sm:text-4xl">
          Ship with a reviewer that never sleeps
        </h2>
        <p className="relative mx-auto mt-4 max-w-md text-balance text-zinc-400">
          Connect a repository and get your first review on the next pull
          request. Free for open source.
        </p>
        <div className="relative mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Button
            size="lg"
            asChild
            className="bg-brand text-brand-foreground hover:bg-brand/90"
          >
            <Link href="/login">
              <GithubMark className="size-4" />
              Get started free
            </Link>
          </Button>
          <Button
            size="lg"
            variant="outline"
            asChild
            className="border-white/20 bg-transparent text-white hover:bg-white/10 hover:text-white"
          >
            <Link href="/login">Sign in</Link>
          </Button>
        </div>
      </div>
    </section>
  )
}
