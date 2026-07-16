"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useApp, fmtDim } from "@/lib/store";
import { scanDB } from "@/lib/db";
import { setCurrent } from "@/lib/current";
import { download, toDXF } from "@/lib/exporters";
import type { ScanRecord } from "@/lib/types";

export default function HistoryPage() {
  const { t, settings, toast } = useApp();
  const router = useRouter();
  const [scans, setScans] = useState<ScanRecord[] | null>(null);

  useEffect(() => {
    scanDB.list().then(setScans).catch(() => setScans([]));
  }, []);

  const open = (rec: ScanRecord) => {
    setCurrent(rec);
    router.push("/editor");
  };

  const remove = async (id: string) => {
    await scanDB.remove(id);
    setScans((s) => (s ? s.filter((r) => r.id !== id) : s));
    toast(t.deleted);
  };

  const exportDxf = (rec: ScanRecord) => {
    const k = rec.calibration?.mmPerPx ?? 1;
    download(toDXF(rec.contours, k, rec.imageSize.h), `${rec.name}.dxf`, "application/dxf");
  };

  const p = settings.precision;

  return (
    <div className="mx-auto max-w-6xl">
      <h1 className="mb-6 font-display text-2xl font-bold">{t.historyTitle}</h1>

      {scans && scans.length === 0 && (
        <div className="panel graticule flex min-h-[300px] flex-col items-center justify-center gap-2 p-8 text-center">
          <p className="font-medium">{t.historyEmpty}</p>
          <p className="text-sm text-ink/50 dark:text-paper/50">{t.historyEmptyHint}</p>
          <Link href="/scanner" className="btn-primary mt-3">
            {t.ctaScan}
          </Link>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {scans?.map((rec) => {
          const k = rec.calibration?.mmPerPx ?? null;
          const m = rec.measurements;
          return (
            <article key={rec.id} className="panel overflow-hidden">
              <button
                className="block w-full cursor-pointer"
                onClick={() => open(rec)}
                aria-label={`${t.open}: ${rec.name}`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={rec.thumbnail}
                  alt={rec.name}
                  className="aspect-[4/3] w-full object-cover"
                />
              </button>
              <div className="p-4">
                <p className="readout truncate text-sm font-medium">{rec.name}</p>
                <p className="mt-0.5 text-xs text-ink/50 dark:text-paper/50">
                  {t.scanFrom} {new Date(rec.createdAt).toLocaleString()}
                </p>
                <p className="readout mt-2 text-xs text-amber">
                  {fmtDim(m.widthPx, k, p, t.mm, t.px)} × {fmtDim(m.heightPx, k, p, t.mm, t.px)} ·{" "}
                  {fmtDim(m.areaPx, k, 0, t.mm, t.px, 2)}
                </p>
                <div className="mt-3 flex gap-2">
                  <button className="btn-ghost flex-1" onClick={() => open(rec)}>
                    {t.open}
                  </button>
                  <button className="btn-ghost readout" onClick={() => exportDxf(rec)}>
                    DXF
                  </button>
                  <button
                    className="btn-ghost text-red-500 hover:bg-red-500/10"
                    onClick={() => remove(rec.id)}
                    aria-label={t.delete}
                  >
                    <svg
                      viewBox="0 0 24 24"
                      className="h-4 w-4"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                    >
                      <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m3 0-1 13a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1L6 7m4 4v6m4-6v6" />
                    </svg>
                  </button>
                </div>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
