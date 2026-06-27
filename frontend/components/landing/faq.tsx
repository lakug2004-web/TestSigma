import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "@/components/ui/accordion"

const faqs = [
  {
    q: "Which platforms do you support?",
    a: "GitHub today, with GitLab and Bitbucket in beta. Sign in with GitHub and authorize the repos you want reviewed.",
  },
  {
    q: "Does my code leave my account?",
    a: "Reviews run in an isolated, ephemeral sandbox that is destroyed after each run. We never train on your code or store it beyond the review.",
  },
  {
    q: "How is this different from a linter?",
    a: "Linters match patterns. PullGuard reasons about intent across files, explains why something is wrong, runs your tests against the change, and writes the fix.",
  },
  {
    q: "Will it slow down my pipeline?",
    a: "No. Reviews run in parallel with CI and the first comment typically lands in under a minute.",
  },
  {
    q: "Is there a free tier?",
    a: "PullGuard is free for public repositories and open-source projects. Private repos start a 14-day trial — no card required.",
  },
]

export function Faq() {
  return (
    <section id="faq" className="mx-auto w-full max-w-3xl px-6 py-24">
      <div className="text-center">
        <p className="text-sm font-semibold text-brand">FAQ</p>
        <h2 className="mt-3 text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
          Questions, answered
        </h2>
      </div>

      <Accordion type="single" collapsible className="mt-10 w-full">
        {faqs.map((item) => (
          <AccordionItem key={item.q} value={item.q}>
            <AccordionTrigger className="text-left text-base">
              {item.q}
            </AccordionTrigger>
            <AccordionContent className="text-muted-foreground">
              {item.a}
            </AccordionContent>
          </AccordionItem>
        ))}
      </Accordion>
    </section>
  )
}
