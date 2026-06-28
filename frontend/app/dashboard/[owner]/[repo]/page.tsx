import { redirect } from "next/navigation"
import { headers } from "next/headers"
import { auth } from "@/lib/auth"
import { getGitHubToken, getRepo } from "@/lib/github"
import { DashboardHeader } from "@/components/dashboard/dashboard-header"
import { TokenMissing } from "@/components/dashboard/token-missing"
import { RepoWorkspace } from "@/components/dashboard/repo-workspace"

export const metadata = { title: "Repository — PullGuard" }

export default async function RepoPage({
  params,
}: {
  params: Promise<{ owner: string; repo: string }>
}) {
  const { owner, repo } = await params
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session) redirect("/login")

  const token = await getGitHubToken()
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

  let repoData
  try {
    repoData = await getRepo(token, owner, repo)
  } catch {
    redirect("/dashboard")
  }

  return (
    <>
      <DashboardHeader name={session.user.name} image={session.user.image} />
      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-10">
        <RepoWorkspace repo={repoData} />
      </main>
    </>
  )
}
