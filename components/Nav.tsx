"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/", label: "Brief", icon: (a: boolean) => <path d="M5 5h14M5 10h14M5 15h9M5 20h6" strokeWidth={a ? 2.4 : 1.8} /> },
  { href: "/watch", label: "Watch", icon: (a: boolean) => <path d="M3 17l5-6 4 3 5-8 4 5" strokeWidth={a ? 2.4 : 1.8} /> },
  { href: "/research", label: "Research", icon: (a: boolean) => <><circle cx="11" cy="11" r="6" strokeWidth={a ? 2.4 : 1.8} /><path d="M16 16l4.5 4.5" strokeWidth={a ? 2.4 : 1.8} /></> },
];

export function Nav() {
  const path = usePathname();
  return (
    <nav
      aria-label="Main"
      className="fixed inset-x-0 bottom-0 z-40 border-t hair bg-[color-mix(in_oklab,var(--paper)_88%,transparent)] backdrop-blur-xl"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <ul className="mx-auto flex max-w-[560px] justify-around">
        {TABS.map((t) => {
          const active = t.href === "/" ? path === "/" : path.startsWith(t.href);
          return (
            <li key={t.href} className="flex-1">
              <Link
                href={t.href}
                aria-current={active ? "page" : undefined}
                className={`flex h-[60px] flex-col items-center justify-center gap-0.5 text-[12px] font-medium ${active ? "text-ink" : "text-muted"}`}
              >
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
                  {t.icon(active)}
                </svg>
                {t.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
