import { NextResponse, type NextRequest } from "next/server"
import crypto from "node:crypto"

const SECRET = process.env.GITHUB_WEBHOOK_SECRET ?? ""
const BACKEND_URL = process.env.BACKEND_URL ?? "http://localhost:8000"

// Verify GitHub's HMAC-SHA256 signature over the RAW body. Hashing re-serialized
// JSON would change the bytes and break the check, so we read the raw text.
function verify(raw: string, sigHeader: string | null): boolean {
  if (!SECRET || !sigHeader) return false
  const expected =
    "sha256=" + crypto.createHmac("sha256", SECRET).update(raw).digest("hex")
  const a = Buffer.from(sigHeader)
  const b = Buffer.from(expected)
  // Constant-time compare to avoid timing leaks; lengths must match first.
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

// Receives GitHub App webhook deliveries. Verifies the signature, then for
// opened/synchronize/reopened pull_request events fires the backend /reason
// blast-radius job. Always ACKs fast (GitHub's delivery timeout is ~10s) and
// does the heavy work asynchronously on the backend.
export async function POST(req: NextRequest) {
  const raw = await req.text()

  if (!verify(raw, req.headers.get("x-hub-signature-256"))) {
    return NextResponse.json({ error: "bad signature" }, { status: 401 })
  }

  const event = req.headers.get("x-github-event")
  const delivery = req.headers.get("x-github-delivery")
  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(raw)
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 })
  }

  console.log(`[webhook] event=${event} delivery=${delivery} action=${payload.action}`)

  if (event === "ping") {
    return NextResponse.json({ ok: true, pong: true })
  }

  if (
    event === "pull_request" &&
    typeof payload.action === "string" &&
    ["opened", "synchronize", "reopened"].includes(payload.action)
  ) {
    const pr = payload.pull_request as { number: number } | undefined
    const repo = payload.repository as { full_name: string } | undefined
    const installation = payload.installation as { id: number } | undefined

    if (pr && repo) {
      // Fire-and-forget: don't await the backend, just ACK GitHub in time.
      fetch(`${BACKEND_URL}/reason`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          full_name: repo.full_name,
          pr_number: pr.number,
          installation_id: installation?.id ?? null,
        }),
      }).catch((err) => console.error("[webhook] backend /reason failed:", err))
    }
  }

  return NextResponse.json({ ok: true })
}
