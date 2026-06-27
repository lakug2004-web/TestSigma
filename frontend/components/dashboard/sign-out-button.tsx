"use client"

import { useRouter } from "next/navigation"
import { useState } from "react"
import { LogOutIcon } from "lucide-react"
import { authClient } from "@/lib/auth-client"
import { Button } from "@/components/ui/button"

export function SignOutButton() {
  const router = useRouter()
  const [loading, setLoading] = useState(false)

  async function handleSignOut() {
    setLoading(true)
    await authClient.signOut({
      fetchOptions: {
        onSuccess: () => router.push("/login"),
      },
    })
    setLoading(false)
  }

  return (
    <Button variant="ghost" size="sm" onClick={handleSignOut} disabled={loading}>
      <LogOutIcon className="size-4" />
      {loading ? "Signing out…" : "Sign out"}
    </Button>
  )
}
