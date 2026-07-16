"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useApp, fmtDim } from "@/lib/store";
import { scanDB } from "@/lib/db";
import type { ScanRecord } from "@/lib/types";

export default function HomePage() {
  const { t, settings } = useApp();
  const [scans, setScans] = useState<ScanRecord[]>([]);

  useEffect(() => {
    scanDB.list().then(setScans).catch(() => {});
  }, []);

  // Project statistics derived from local history. Area statistics only make
  // sense in mm², so they consider calibrated scans.
  const calibrated = scans.filter((s) => s.calibration);
  const areaMm2 = (s: ScanRecord) => s.measurements.areaPx * (s.calibration!.mmPerPx ** 2);
  const avgArea = calibrated.length
    ? calibrated.reduce((sum, s) => sum + areaMm2(s), 0) / calibrated.length
    : null;
  const largest = calibrated.length
    ? calibrated.reduce((a, b) => (areaMm2(a) >= areaMm2(b) ? a : b))
    : null;
  const smallest = calibrated.length
    ? calibrated.reduce((a, b) => (areaMm2(a) <= areaMm2(b) ? a : b))
    : null;
  const p = settings.precision;

  const stats = [
    { label: t.statTotal, value: String(scans.length) },
    { label: t.statAvgArea, value: avgArea != null ? `${avgArea.toFixed(0)} ${t.mm}²` : t.statNoData },
    {
      label: t.statLargest,
      value: largest ? fmtDim(largest.measurements.areaPx, largest.calibration!.mmPerPx, 0, t.mm, t.px, 2) : t.statNoData,
    },
    {
      label: t.statSmallest,
      value: smallest ? fmtDim(smallest.measurements.areaPx, smallest.calibration!.mmPerPx, p, t.mm, t.px, 2) : t.statNoData,
    },
  ];

  const steps = [t.how1, t.how2, t.how3, t.how4];

  return (
    <div className="mx-auto max-w-5xl">
      {/* Hero: a live contour is the thesis of the product */}
      <section className="panel graticule relative overflow-hidden px-6 py-12 md:px-10 md:py-16">
        <svg
          aria-hidden
          viewBox="0 0 200 200"
          className="pointer-events-none absolute -right-8 top-1/2 hidden h-64 w-64 -translate-y-1/2 opacity-70 md:block"
          fill="none"
        >
          {/* A stylised scanned part: outer contour + two holes, colour-coded like exports */}
          <path
            d="M30 60 Q30 30 60 30 L150 40 Q175 45 170 75 L160 150 Q155 172 130 168 L50 158 Q28 154 30 130 Z"
            stroke="#2563eb"
            strokeWidth="2.5"
            strokeDasharray="380"
            strokeDashoffset="0"
          />
          <circle cx="70" cy="75" r="14" stroke="#dc2626" strokeWidth="2" />
          <circle cx="125" cy="120" r="10" stroke="#dc2626" strokeWidth="2" />
          {[30, 60, 150, 170].map((x, i) => (
            <circle key={i} cx={x} cy={i % 2 ? 40 + i * 30 : 60 + i * 20} r="3" fill="#e8a33d" />
          ))}
        </svg>
        <p className="readout mb-3 text-xs uppercase tracking-[0.2em] text-amber">{t.tagline}</p>
        <h1 className="max-w-xl font-display text-4xl font-bold leading-tight md:text-5xl">
          {t.heroTitle}
        </h1>
        <p className="mt-4 max-w-xl text-sm leading-relaxed text-ink/70 dark:text-paper/70 md:text-base">
          {t.heroText}
        </p>
        <div className="mt-7 flex flex-wrap gap-3">
          <Link href="/scanner" className="btn-primary">
            {t.ctaScan}
          </Link>
          <Link href="/history" className="btn-ghost">
            {t.ctaHistory}
          </Link>
        </div>
        <p className="readout mt-6 text-xs text-ink/45 dark:text-paper/45">{t.privacyNote}</p>
      </section>

      {/* Project statistics */}
      <section className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        {stats.map((s) => (
          <div key={s.label} className="panel p-4">
            <p className="text-[11px] uppercase tracking-wide text-ink/50 dark:text-paper/50">
              {s.label}
            </p>
            <p className="readout mt-1 truncate text-xl text-amber" title={s.value}>
              {s.value}
            </p>
          </div>
        ))}
      </section>

      {/* How it works — a real 4-step process, so numbering carries meaning */}
      <section className="mt-10">
        <h2 className="mb-4 font-display text-xl font-bold">{t.howTitle}</h2>
        <ol className="grid gap-3 md:grid-cols-2">
          {steps.map((step, i) => (
            <li key={i} className="panel flex gap-4 p-4">
              <span className="readout text-2xl font-medium text-dye dark:text-dye-bright">
                {i + 1}
              </span>
              <p className="text-sm leading-relaxed text-ink/75 dark:text-paper/75">{step}</p>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
