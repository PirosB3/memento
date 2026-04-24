"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export default function AppNav() {
  const pathname = usePathname();

  if (pathname === "/agents") {
    return null;
  }

  return (
    <nav className="border-b border-[var(--card-border)] bg-[var(--card)]">
      <div className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
        <Link href="/agents" className="flex items-center gap-2.5 group">
          <div className="w-7 h-7 rounded-lg bg-[var(--accent)] flex items-center justify-center">
            <span className="text-white text-xs font-bold font-[family-name:var(--font-outfit)]">M</span>
          </div>
          <span className="font-[family-name:var(--font-outfit)] font-semibold text-sm text-[var(--foreground)] group-hover:text-[var(--accent)] transition-colors">
            Memento Control Plane
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
  );
}
