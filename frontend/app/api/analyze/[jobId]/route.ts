import { NextResponse, type NextRequest } from "next/server"

const BACKEND_URL = process.env.BACKEND_URL ?? "http://localhost:8000"

// Proxies a job-status poll to the Python backend.
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await params
  try {
    const res = await fetch(`${BACKEND_URL}/analyze/${jobId}`, {
      cache: "no-store",
    })
    const data = await res.json()
    return NextResponse.json(data, { status: res.status })
  } catch (err) {
    return NextResponse.json(
      {
        error:
          err instanceof Error ? err.message : "Failed to reach analysis backend",
      },
      { status: 502 },
    )
  }
}
