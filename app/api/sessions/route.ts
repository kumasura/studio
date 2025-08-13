export const runtime = 'nodejs'
import { createSession } from '@/lib/runtime'

export async function POST() {
  const id = createSession()
  return new Response(JSON.stringify({ session_id: id }), { headers: { 'content-type': 'application/json' } })
}
