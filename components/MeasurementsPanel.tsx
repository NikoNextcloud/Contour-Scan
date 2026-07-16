"use client";

import { useApp, fmtDim } from "@/lib/store";
import type { Calibration, MeasurementsPx } from "@/lib/types";

/**
 * Caliper-style readouts: mono digits, quiet labels.
 * Shows mm when calibrated, otherwise raw pixels.
 */
export default function MeasurementsPanel({
  m,
  calibration,
}: {
  m: MeasurementsPx;
  calibration: Calibration | null;
}) {
  const { t, settings } = useApp();
  const k = calibration?.mmPerPx ?? null;
  const p = settings.precision;

  const rows: { label: string; value: string }[] = [
    { label: t.measWidth, value: fmtDim(m.widthPx, k, p, t.mm, t.px) },
    { label: t.measHeight, value: fmtDim(m.heightPx, k, p, t.mm, t.px) },
    { label: t.measArea, value: fmtDim(m.areaPx, k, p, t.mm, t.px, 2) },
    { label: t.measPerimeter, value: fmtDim(m.perimeterPx, k, p, t.mm, t.px) },
    {
      label: t.measMinRect,
      value: `${fmtDim(m.minRect.w, k, p, t.mm, t.px)} × ${fmtDim(m.minRect.h, k, p, t.mm, t.px)} · ${m.minRect.angleDeg.toFixed(1)}°`,
    },
    { label: t.measCircle, value: fmtDim(m.circleDiameterPx, k, p, t.mm, t.px) },
    { label: t.measAspect, value: m.aspectRatio.toFixed(2) },
    { label: t.measHoles, value: String(m.holeCount) },
  ];

  return (
    <section className="panel p-4">
      <h2 className="mb-3 font-display text-sm font-bold uppercase tracking-wider text-ink/60 dark:text-paper/60">
        {t.measTitle}
      </h2>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
        {rows.map((r) => (
          <div key={r.label} className="min-w-0">
            <dt className="text-[11px] uppercase tracking-wide text-ink/50 dark:text-paper/50">
              {r.label}
            </dt>
            <dd className="readout truncate text-[15px] text-amber" title={r.value}>
              {r.value}
            </dd>
          </div>
        ))}
      </dl>
      {!k && (
        <p className="mt-3 text-xs text-ink/50 dark:text-paper/50">{t.calibNone}</p>
      )}
    </section>
  );
}
