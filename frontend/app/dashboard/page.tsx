import { redirect } from "next/navigation"
import { headers } from "next/headers"
import { auth } from "@/lib/auth"
import {
  getGitHubToken,
  getProfile,
  getRepos,
  getContributions,
} from "@/lib/github"
import { DashboardHeader } from "@/components/dashboard/dashboard-header"
import { ProfileCard } from "@/components/dashboard/profile-card"
import { RepoBrowser } from "@/components/dashboard/repo-browser"
import { TokenMissing } from "@/components/dashboard/token-missing"

export const metadata = { title: "Dashboard — PullGuard" }

export default async function DashboardPage() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session) redirect("/login")

  const token = await getGitHubToken()

  // Token can be absent if GitHub OAuth credentials aren't configured yet.
  if (!token) {
    return (
      <>
        <DashboardHeader name={session.user.name} image={session.user.image} />
        <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-10">
          <TokenMissing />
        </main>
      </>
    )
  }

  const [profile, repos, contributions] = await Promise.all([
    getProfile(token),
    getRepos(token),
    getContributions(token),
  ])

  return (
    <>
      <DashboardHeader name={session.user.name} image={session.user.image} />
      <main className="mx-auto grid w-full max-w-6xl flex-1 gap-8 px-6 py-10 lg:grid-cols-[320px_1fr]">
        <ProfileCard profile={profile} contributions={contributions} />
        <RepoBrowser repos={repos} />
      </main>
    </>
  )
}
