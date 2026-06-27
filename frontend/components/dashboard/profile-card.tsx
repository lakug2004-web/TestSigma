import { MapPinIcon, BuildingIcon, ExternalLinkIcon } from "lucide-react"
import type { GitHubProfile } from "@/lib/github"
import { Card, CardContent } from "@/components/ui/card"
import {
  Avatar,
  AvatarImage,
  AvatarFallback,
} from "@/components/ui/avatar"
import { Separator } from "@/components/ui/separator"

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <div className="text-center">
      <div className="font-mono text-lg font-semibold">
        {value.toLocaleString()}
      </div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  )
}

export function ProfileCard({
  profile,
  contributions,
}: {
  profile: GitHubProfile
  contributions: number
}) {
  return (
    <Card className="h-fit lg:sticky lg:top-24">
      <CardContent className="flex flex-col items-center gap-4 p-6 text-center">
        <Avatar className="size-20">
          <AvatarImage src={profile.avatar_url} alt={profile.login} />
          <AvatarFallback>
            {profile.login.slice(0, 2).toUpperCase()}
          </AvatarFallback>
        </Avatar>

        <div className="space-y-1">
          <h1 className="text-lg font-semibold leading-tight">
            {profile.name ?? profile.login}
          </h1>
          <a
            href={profile.html_url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            @{profile.login}
            <ExternalLinkIcon className="size-3" />
          </a>
        </div>

        {profile.bio ? (
          <p className="text-sm text-balance text-muted-foreground">
            {profile.bio}
          </p>
        ) : null}

        <div className="flex flex-wrap justify-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {profile.company ? (
            <span className="inline-flex items-center gap-1">
              <BuildingIcon className="size-3" />
              {profile.company}
            </span>
          ) : null}
          {profile.location ? (
            <span className="inline-flex items-center gap-1">
              <MapPinIcon className="size-3" />
              {profile.location}
            </span>
          ) : null}
        </div>

        <Separator />

        <div className="grid w-full grid-cols-2 gap-4">
          <Stat value={contributions} label="Contributions" />
          <Stat
            value={profile.public_repos + (profile.total_private_repos ?? 0)}
            label="Repositories"
          />
          <Stat value={profile.followers} label="Followers" />
          <Stat value={profile.following} label="Following" />
        </div>
      </CardContent>
    </Card>
  )
}
