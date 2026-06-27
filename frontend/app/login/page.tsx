import Link from "next/link"
import { ShieldCheckIcon } from "lucide-react"
import { LoginForm } from "@/components/login-form"

export default function LoginPage() {
  return (
    <div className="relative flex min-h-svh flex-col items-center justify-center gap-6 bg-muted/40 p-6 md:p-10">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-64 bg-[radial-gradient(50%_60%_at_50%_0%,var(--brand-muted),transparent_70%)]"
      />
      <Link
        href="/"
        className="relative z-10 flex items-center gap-2 self-center font-semibold"
      >
        <span className="flex size-7 items-center justify-center rounded-md bg-brand text-brand-foreground">
          <ShieldCheckIcon className="size-4" />
        </span>
        PullGuard
      </Link>
      <div className="relative z-10 w-full max-w-xs">
        <LoginForm />
      </div>
    </div>
  )
}
