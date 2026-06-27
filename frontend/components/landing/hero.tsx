import Link from "next/link"
import { ArrowRightIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ReviewDemo } from "@/components/landing/review-demo"
import { GithubMark } from "@/components/landing/github-mark"

export function Hero() {
  return (
    <section className="relative overflow-hidden">
      {/* ambient brand glow */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 -top-40 h-[420px] bg-[radial-gradient(60%_60%_at_50%_0%,var(--brand-muted),transparent_70%)]"
      />
      <div className="mx-auto grid w-full max-w-6xl items-center gap-12 px-6 py-20 lg:grid-cols-2 lg:py-28">
        <div className="flex flex-col items-start gap-6">
          <span className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-xs font-medium text-muted-foreground">
            <span className="size-1.5 rounded-full bg-brand" />
            Now reviewing 1.2M pull requests / week
          </span>

          <h1 className="text-balance text-4xl font-semibold tracking-tight sm:text-5xl lg:text-6xl">
            The AI reviewer that reads every line
            <span className="text-brand"> before you merge</span>
          </h1>

          <p className="max-w-md text-balance text-lg text-muted-foreground">
            PullGuard reviews pull requests, catches bugs and security holes,
            runs your test suite against the change, and posts the fix inline —
            in under a minute.
          </p>

          <div className="flex flex-col gap-3 sm:flex-row">
            <Button
              size="lg"
              asChild
              className="bg-brand text-brand-foreground hover:bg-brand/90"
            >
              <Link href="/login">
                <GithubMark className="size-4" />
                Connect your repo
              </Link>
            </Button>
            <Button size="lg" variant="outline" asChild>
              <a href="#how-it-works">
                See how it works
                <ArrowRightIcon className="size-4" />
              </a>
            </Button>
          </div>

          <p className="text-sm text-muted-foreground">
            Free for open source · Installs in 2 clicks · No card required
          </p>
        </div>

        <ReviewDemo className="lg:translate-x-6" />
      </div>
    </section>
  )
}
