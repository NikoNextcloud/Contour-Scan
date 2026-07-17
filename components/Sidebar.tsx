"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useApp } from "@/lib/store";

/** Simple inline stroke icons — no icon library needed. */
const icons: Record<string, React.ReactNode> = {
  home: <path d="M3 11 12 3l9 8v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z" />,
  scanner: (
    <>
      <path d="M3 8V4a1 1 0 0 1 1-1h4M16 3h4a1 1 0 0 1 1 1v4M21 16v4a1 1 0 0 1-1 1h-4M8 21H4a1 1 0 0 1-1-1v-4" />
      <circle cx="12" cy="12" r="4" />
    </>
  ),
  editor: <path d="m4 20 4-1L20.5 6.5a2.1 2.1 0 0 0-3-3L5 16zM14 5l3 3" />,
  history: (
    <>
      <path d="M12 8v4l3 2" />
      <path d="M3.5 12a8.5 8.5 0 1 1 2.5 6M3 13l.5-1 1 .8" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.5-2.3 1a7 7 0 0 0-2.1-1.2L14 3h-4l-.5 2.6a7 7 0 0 0-2.1 1.2l-2.3-1-2 3.5 2 1.5a7 7 0 0 0 0 2.4l-2 1.5 2 3.5 2.3-1a7 7 0 0 0 2.1 1.2L10 21h4l.5-2.6a7 7 0 0 0 2.1-1.2l2.3 1 2-3.5-2-1.5A7 7 0 0 0 19 12z" />
    </>
  ),
  about: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8h.01M11 12h1v4h1" />
    </>
  ),
};

export default function Sidebar() {
  const { t } = useApp();
  const pathname = usePathname();

  const items = [
    { href: "/scanner", label: t.navScanner, icon: "scanner" },
    { href: "/editor", label: t.navEditor, icon: "editor" },
    { href: "/history", label: t.navHistory, icon: "history" },
    { href: "/settings", label: t.navSettings, icon: "settings" },
    { href: "/about", label: t.navAbout, icon: "about" },
  ];

  return (
    <aside className="sticky top-0 z-40 flex shrink-0 flex-row items-center gap-1 border-b border-paper-3 bg-paper-2/90 px-2 py-2 backdrop-blur dark:border-ink-3 dark:bg-ink-2/90 md:h-screen md:w-56 md:flex-col md:items-stretch md:gap-0 md:border-b-0 md:border-r md:px-0 md:py-0">
      {/* Wordmark + ruler ticks: the app's visual signature */}
      <Link href="/scanner" className="hidden items-baseline gap-2 px-5 pb-2 pt-6 md:flex">
        <span className="font-display text-lg font-bold tracking-tight">
          Contour<span className="text-dye dark:text-dye-bright">Scan</span>
        </span>
      </Link>
      <div
        aria-hidden
        className="mx-5 mb-4 hidden h-2 md:block"
        style={{
          backgroundImage:
            "repeating-linear-gradient(to right, currentColor 0 1px, transparent 1px 8px)",
          opacity: 0.35,
        }}
      />

      <nav className="flex flex-1 flex-row gap-1 overflow-x-auto md:flex-col md:gap-0.5 md:px-3">
        {items.map((item) => {
          const active = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${
                active
                  ? "bg-dye/10 font-medium text-dye dark:bg-dye-bright/15 dark:text-dye-bright"
                  : "text-ink/70 hover:bg-ink/5 hover:text-ink dark:text-paper/70 dark:hover:bg-paper/5 dark:hover:text-paper"
              }`}
            >
              <svg
                viewBox="0 0 24 24"
                className="h-[18px] w-[18px] shrink-0"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                {icons[item.icon]}
              </svg>
              <span className="whitespace-nowrap">{item.label}</span>
            </Link>
          );
        })}
      </nav>

      <p className="hidden px-5 pb-5 font-mono text-[11px] text-ink/40 dark:text-paper/40 md:block">
        100% client-side · OpenCV.js
      </p>
    </aside>
  );
}
