import '@/styles/globals.css';
export const metadata = { title: 'Studio on Vercel', description: 'LangGraph Studio–like UI (Next.js only)' };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-zinc-50 text-zinc-900">{children}</body>
    </html>
  );
}
