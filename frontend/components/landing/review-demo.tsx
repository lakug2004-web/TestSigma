import { ShieldCheckIcon, CheckCircle2Icon } from "lucide-react"
import { cn } from "@/lib/utils"

type Line = {
  no: string
  sign?: "+" | "-"
  text: string
}

const diff: Line[] = [
  { no: "12", text: "export async function getUser(id) {" },
  { no: "13", sign: "-", text: "  const res = await db.query(`SELECT * FROM users WHERE id = ${id}`)" },
  { no: "13", sign: "+", text: "  const res = await db.query('SELECT * FROM users WHERE id = $1', [id])" },
  { no: "14", text: "  return res.rows[0]" },
  { no: "15", text: "}" },
]

function lineClasses(sign?: "+" | "-") {
  if (sign === "+") return "bg-emerald-500/10 text-emerald-300"
  if (sign === "-") return "bg-rose-500/10 text-rose-300"
  return "text-zinc-400"
}

export function ReviewDemo({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-xl border border-white/10 bg-zinc-950 shadow-2xl shadow-black/40",
        className,
      )}
    >
      {/* window chrome */}
      <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
        <span className="size-3 rounded-full bg-rose-500/80" />
        <span className="size-3 rounded-full bg-amber-400/80" />
        <span className="size-3 rounded-full bg-emerald-500/80" />
        <span className="ml-3 font-mono text-xs text-zinc-500">
          api/users.ts · #482 Fix SQL injection
        </span>
      </div>

      {/* diff */}
      <div className="font-mono text-[13px] leading-relaxed">
        {diff.map((line, i) => (
          <div
            key={i}
            className={cn("flex gap-4 px-4 py-0.5", lineClasses(line.sign))}
          >
            <span className="w-6 select-none text-right text-zinc-600">
              {line.no}
            </span>
            <span className="w-3 select-none text-zinc-600">{line.sign}</span>
            <span className="whitespace-pre">{line.text}</span>
          </div>
        ))}
      </div>

      {/* inline AI review comment */}
      <div className="m-3 mt-1 rounded-lg border border-brand/30 bg-brand/10 p-3">
        <div className="flex items-center gap-2 text-xs font-medium text-brand">
          <span className="flex size-5 items-center justify-center rounded-md bg-brand text-brand-foreground">
            <ShieldCheckIcon className="size-3" />
          </span>
          PullGuard
          <span className="rounded-full bg-rose-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-rose-300">
            Security
          </span>
        </div>
        <p className="mt-2 text-sm text-zinc-300">
          String interpolation lets a crafted{" "}
          <code className="rounded bg-white/10 px-1 text-zinc-100">id</code> run
          arbitrary SQL. Use a parameterized query so the driver escapes the
          input.
        </p>
        <div className="mt-2 flex items-center gap-1.5 text-xs text-emerald-400">
          <CheckCircle2Icon className="size-3.5" />
          Suggested fix applied · committed to branch
        </div>
      </div>
    </div>
  )
}
