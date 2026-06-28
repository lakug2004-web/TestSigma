import { NextResponse, type NextRequest } from "next/server"
import { headers } from "next/headers"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/prisma"
import { getGitHubToken, getPullRequests } from "@/lib/github"

// List a repo's pull requests and PERSIST each one. Every PR's GitHub metadata
// is upserted into the same `pr_review` row keyed by (fullName, prNumber) that
// the webhook reasoner writes its blast-radius review into, so the dashboard
// and the bot converge on one row. Returns the stored rows (metadata + any
// review) newest PR first.
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const owner = searchParams.get("owner")
  const repo = searchParams.get("repo")
  if (!owner || !repo) {
    return NextResponse.json(
      { error: "owner and repo are required" },
      { status: 400 },
    )
  }

  const session = await auth.api.getSession({ headers: await headers() })
  if (!session) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 })
  }
  const userId = session.user.id

  const token = await getGitHubToken()
  if (!token) {
    return NextResponse.json({ error: "No GitHub token" }, { status: 401 })
  }

  const fullName = `${owner}/${repo}`

  let pulls
  try {
    pulls = await getPullRequests(token, owner, repo)
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load PRs" },
      { status: 502 },
    )
  }

  try {
    await prisma.$transaction(
      pulls.map((p) =>
        prisma.prReview.upsert({
          where: { fullName_prNumber: { fullName, prNumber: p.number } },
          create: {
            userId,
            fullName,
            prNumber: p.number,
            title: p.title,
            author: p.author,
            state: p.state,
            url: p.html_url,
            headSha: p.headSha,
            baseRef: p.baseRef,
            headRef: p.headRef,
          },
          // Keep the webhook's review fields; only refresh GitHub metadata.
          update: {
            userId,
            title: p.title,
            author: p.author,
            state: p.state,
            url: p.html_url,
            headSha: p.headSha,
            baseRef: p.baseRef,
            headRef: p.headRef,
          },
        }),
      ),
    )
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to persist PRs" },
      { status: 500 },
    )
  }

  const rows = await prisma.prReview.findMany({
    where: { fullName },
    orderBy: { prNumber: "desc" },
  })

  return NextResponse.json({ pulls: rows })
}
