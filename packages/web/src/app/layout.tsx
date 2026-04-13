import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Outfit } from "next/font/google";
import Link from "next/link";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const outfit = Outfit({
  variable: "--font-outfit",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

export const metadata: Metadata = {
  title: "Summon Agents",
  description: "Create AI agents that coordinate people over email",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${outfit.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <nav className="border-b border-[var(--card-border)] bg-[var(--card)]">
          <div className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
            <Link href="/agents" className="flex items-center gap-2.5 group">
              <div className="w-7 h-7 rounded-lg bg-[var(--accent)] flex items-center justify-center">
                <span className="text-white text-xs font-bold font-[family-name:var(--font-outfit)]">S</span>
              </div>
              <span className="font-[family-name:var(--font-outfit)] font-semibold text-sm tracking-tight text-[var(--foreground)] group-hover:text-[var(--accent)] transition-colors">
                Summon
              </span>
            </Link>
            <Link
              href="/agents/new"
              className="text-xs font-medium px-3 py-1.5 rounded-md bg-[var(--accent)] text-white hover:brightness-110 transition-all"
            >
              + New Agent
            </Link>
          </div>
        </nav>
        <main className="flex-1">{children}</main>
      </body>
    </html>
  );
}
