import { NextResponse, type NextRequest } from "next/server"
import { headers } from "next/headers"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/prisma"

// Persist a freshly generated RepoTree so the next open serves it from cache.
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null)
  if (!body?.full_name || !body?.tree) {
    return NextResponse.json(
      { error: "full_name and tree are required" },
      { status: 400 },
    )
  }

  const session = await auth.api.getSession({ headers: await headers() })
  if (!session) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 })
  }
  const userId = session.user.id

  const row = await prisma.repoAst.upsert({
    where: { userId_fullName: { userId, fullName: body.full_name } },
    create: { userId, fullName: body.full_name, tree: body.tree },
    update: { tree: body.tree },
  })

  return NextResponse.json({ ok: true, updatedAt: row.updatedAt })
}
