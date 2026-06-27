import { TriangleAlertIcon } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"

export function TokenMissing() {
  return (
    <Card className="border-amber-500/30 bg-amber-500/5">
      <CardContent className="flex items-start gap-4 p-6">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-amber-500/15 text-amber-600">
          <TriangleAlertIcon className="size-5" />
        </span>
        <div className="space-y-2">
          <h2 className="font-semibold">GitHub not connected yet</h2>
          <p className="text-sm text-muted-foreground">
            We couldn&apos;t read a GitHub access token for your account. Set{" "}
            <code className="rounded bg-muted px-1">GITHUB_CLIENT_ID</code> and{" "}
            <code className="rounded bg-muted px-1">GITHUB_CLIENT_SECRET</code>{" "}
            in <code className="rounded bg-muted px-1">.env</code>, then sign out
            and sign in again to grant repository access.
          </p>
        </div>
      </CardContent>
    </Card>
  )
}
