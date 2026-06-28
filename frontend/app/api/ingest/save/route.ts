import { NextResponse, type NextRequest } from "next/server"
import { headers } from "next/headers"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/prisma"
import type { IngestResult } from "@/lib/ingest"

// Persist ingested requirements so the next open serves them from cache and the
// PR-review (Reason) layer can pull them as the Requirements context.
export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as {
    full_name?: string
    result?: IngestResult
  } | null
  const result = body?.result
  if (!body?.full_name || !result?.source) {
    return NextResponse.json(
      { error: "full_name and result are required" },
      { status: 400 },
    )
  }

  const session = await auth.api.getSession({ headers: await headers() })
  if (!session) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 })
  }
  const userId = session.user.id

  const data = {
    source: result.source,
    sourceType: result.source_type ?? "url",
    requirementCount: result.requirement_count ?? result.requirements.length,
    requirements: result.requirements,
    files: result.files ?? [],
    overview: result.overview ?? "",
    excerpt: result.excerpt ?? "",
  }

  const row = await prisma.repoRequirements.upsert({
    where: { userId_fullName: { userId, fullName: body.full_name } },
    create: { userId, fullName: body.full_name, ...data },
    update: data,
  })

  return NextResponse.json({ ok: true, updatedAt: row.updatedAt })
}
