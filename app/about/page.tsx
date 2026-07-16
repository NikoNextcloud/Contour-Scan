"use client";

import { useApp } from "@/lib/store";

const STACK = [
  ["Next.js 15 + React 19", "App Router, static-friendly"],
  ["OpenCV.js (WASM)", "grayscale → threshold → morphology → findContours"],
  ["TypeScript", "strict mode"],
  ["TailwindCSS v4", "design tokens, dark/light"],
  ["IndexedDB", "local scan history"],
  ["DXF R12 / SVG (mm)", "hand-written exporters, CAD-ready"],
];

export default function AboutPage() {
  const { t } = useApp();
  return (
    <div className="mx-auto max-w-xl">
      <h1 className="mb-6 font-display text-2xl font-bold">{t.aboutTitle}</h1>
      <div className="panel p-5">
        <p className="text-sm leading-relaxed text-ink/75 dark:text-paper/75">{t.aboutText}</p>
        <h2 className="mb-2 mt-6 font-display text-sm font-bold uppercase tracking-wider text-ink/60 dark:text-paper/60">
          {t.aboutStack}
        </h2>
        <ul className="space-y-2">
          {STACK.map(([name, desc]) => (
            <li key={name} className="flex items-baseline justify-between gap-4 text-sm">
              <span className="readout">{name}</span>
              <span className="text-right text-xs text-ink/50 dark:text-paper/50">{desc}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
