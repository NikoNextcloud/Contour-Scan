"use client";

import { useApp } from "@/lib/store";
import { download, toCSV, toDXF, toJSON, toPNG, toSVG } from "@/lib/exporters";
import type { ScanRecord } from "@/lib/types";

/** One row of export actions — DXF and SVG use real mm when calibrated. */
export default function ExportButtons({ record }: { record: ScanRecord }) {
  const { t } = useApp();
  const mmPerPx = record.calibration?.mmPerPx ?? 1; // 1 => raw pixel units
  const base = record.name.replace(/[^\wа-яА-Я-]+/g, "_") || "contour";

  const actions: { label: string; run: () => void }[] = [
    {
      label: "DXF",
      run: () =>
        download(
          toDXF(record.contours, mmPerPx, record.imageSize.h),
          `${base}.dxf`,
          "application/dxf"
        ),
    },
    {
      label: "SVG",
      run: () =>
        download(toSVG(record.contours, mmPerPx, record.imageSize), `${base}.svg`, "image/svg+xml"),
    },
    {
      label: "PNG",
      run: async () => download(await toPNG(record.contours, record.imageSize), `${base}.png`),
    },
    { label: "JSON", run: () => download(toJSON(record), `${base}.json`, "application/json") },
    { label: "CSV", run: () => download(toCSV(record), `${base}.csv`, "text/csv") },
  ];

  return (
    <section className="panel p-4">
      <h2 className="mb-3 font-display text-sm font-bold uppercase tracking-wider text-ink/60 dark:text-paper/60">
        {t.exportTitle}
      </h2>
      <div className="flex flex-wrap gap-2">
        {actions.map((a) => (
          <button key={a.label} className="btn-ghost readout" onClick={a.run}>
            <svg
              viewBox="0 0 24 24"
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 3v12m0 0 4-4m-4 4-4-4M4 17v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
            </svg>
            {a.label}
          </button>
        ))}
      </div>
    </section>
  );
}
