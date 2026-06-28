import { NextResponse, type NextRequest } from "next/server"
import { headers } from "next/headers"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/prisma"
import { getGitHubToken, getPullDetail } from "@/lib/github"

// One PR's full detail: live GitHub diff stats + the persisted review row
// (verdict / risk / blast radius) the webhook reasoner wrote, if any.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ number: string }> },
) {
  const { number } = await params
  const prNumber = Number(number)
  const { searchParams } = new URL(request.url)
  const owner = searchParams.get("owner")
  const repo = searchParams.get("repo")
  if (!owner || !repo || !Number.isFinite(prNumber)) {
    return NextResponse.json(
      { error: "owner, repo and a numeric PR number are required" },
      { status: 400 },
    )
  }

  const session = await auth.api.getSession({ headers: await headers() })
  if (!session) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 })
  }

  const token = await getGitHubToken()
  if (!token) {
    return NextResponse.json({ error: "No GitHub token" }, { status: 401 })
  }

  const fullName = `${owner}/${repo}`

  try {
    const [detail, review] = await Promise.all([
      getPullDetail(token, owner, repo, prNumber),
      prisma.prReview.findUnique({
        where: { fullName_prNumber: { fullName, prNumber } },
      }),
    ])
    return NextResponse.json({ detail, review })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load PR" },
      { status: 502 },
    )
  }
}
