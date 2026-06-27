import Link from "next/link"
import { ShieldCheckIcon } from "lucide-react"
import {
  Avatar,
  AvatarImage,
  AvatarFallback,
} from "@/components/ui/avatar"
import { SignOutButton } from "@/components/dashboard/sign-out-button"

export function DashboardHeader({
  name,
  image,
}: {
  name?: string | null
  image?: string | null
}) {
  const initials =
    name
      ?.split(" ")
      .map((p) => p[0])
      .slice(0, 2)
      .join("")
      .toUpperCase() ?? "PG"

  return (
    <header className="sticky top-0 z-50 border-b border-border/60 bg-background/80 backdrop-blur-md">
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-6">
        <Link href="/" className="flex items-center gap-2 font-semibold">
          <span className="flex size-7 items-center justify-center rounded-md bg-brand text-brand-foreground">
            <ShieldCheckIcon className="size-4" />
          </span>
          <span className="tracking-tight">PullGuard</span>
        </Link>

        <div className="flex items-center gap-3">
          <Avatar className="size-8">
            {image ? <AvatarImage src={image} alt={name ?? ""} /> : null}
            <AvatarFallback>{initials}</AvatarFallback>
          </Avatar>
          <SignOutButton />
        </div>
      </div>
    </header>
  )
}
