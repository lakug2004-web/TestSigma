import {
  BugIcon,
  ShieldAlertIcon,
  FlaskConicalIcon,
  GitPullRequestArrowIcon,
  GaugeIcon,
  MessagesSquareIcon,
} from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"

const features = [
  {
    icon: BugIcon,
    title: "Line-by-line review",
    body: "Every diff gets read in context. PullGuard flags logic bugs, edge cases, and dead code with a concrete fix you can commit in one click.",
  },
  {
    icon: ShieldAlertIcon,
    title: "Security analysis",
    body: "Injection, secrets, unsafe deserialization, broken auth. Catches the OWASP Top 10 before they reach your default branch.",
  },
  {
    icon: FlaskConicalIcon,
    title: "Test simulation",
    body: "Runs your suite against the proposed change in an isolated sandbox and reports failing tests right inside the pull request.",
  },
  {
    icon: GitPullRequestArrowIcon,
    title: "Native to your PR",
    body: "Comments land where you already work — GitHub, GitLab, Bitbucket. No new dashboard to babysit.",
  },
  {
    icon: GaugeIcon,
    title: "Under a minute",
    body: "Reviews start the moment a PR opens and finish before your CI does. Fast feedback keeps authors in flow.",
  },
  {
    icon: MessagesSquareIcon,
    title: "Chat with the review",
    body: "Disagree with a finding? Reply in the thread. PullGuard explains its reasoning and refines the suggestion.",
  },
]

export function Features() {
  return (
    <section id="features" className="mx-auto w-full max-w-6xl px-6 py-24">
      <div className="mx-auto max-w-2xl text-center">
        <p className="text-sm font-semibold text-brand">What it does</p>
        <h2 className="mt-3 text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
          A senior reviewer on every pull request
        </h2>
        <p className="mt-4 text-balance text-muted-foreground">
          Not a linter. PullGuard understands intent across files and tells you
          why something is wrong — then fixes it.
        </p>
      </div>

      <div className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {features.map((f) => (
          <Card
            key={f.title}
            className="border-border/70 transition-colors hover:border-brand/40"
          >
            <CardContent className="flex flex-col gap-3 p-6">
              <span className="flex size-10 items-center justify-center rounded-lg bg-brand/10 text-brand">
                <f.icon className="size-5" />
              </span>
              <h3 className="font-semibold">{f.title}</h3>
              <p className="text-sm leading-relaxed text-muted-foreground">
                {f.body}
              </p>
            </CardContent>
          </Card>
        ))}
      </div>
    </section>
  )
}
