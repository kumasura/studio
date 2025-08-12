import Link from 'next/link'
export default function Page() {
  return (
    <main className="p-6 max-w-3xl mx-auto">
      <h1 className="text-2xl font-bold mb-2">LangGraph Studio–like UI (All-in-Vercel)</h1>
      <p className="text-zinc-600 mb-6">Canvas + palette + SSE runtime on Next.js API routes.</p>
      <Link href="/studio" className="inline-block px-4 py-2 rounded-xl bg-black text-white">Open Studio</Link>
    </main>
  )
}
