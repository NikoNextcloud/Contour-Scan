"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useApp } from "@/lib/store";
import { loadOpenCV } from "@/lib/opencv";
import { detectContours, detectContoursFallback, fileToImageData } from "@/lib/pipeline";
import { calibrationFromImageFile } from "@/lib/image-metadata";
import { measure } from "@/lib/geometry";
import { scanDB, newId } from "@/lib/db";
import { setCurrent } from "@/lib/current";
import MeasurementsPanel from "@/components/MeasurementsPanel";
import ExportButtons from "@/components/ExportButtons";
import {
  CALIBRATION_PRESETS,
  DEFAULT_PARAMS,
  type Calibration,
  type ContourSet,
  type PipelineParams,
  type Pt,
  type ScanRecord,
} from "@/lib/types";

type Phase = "idle" | "loadingCV" | "processing" | "ready";

export default function ScannerPage() {
  const { t, toast, settings } = useApp();
  const router = useRouter();

  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [params, setParams] = useState<PipelineParams>(DEFAULT_PARAMS);
  const [contours, setContours] = useState<ContourSet | null>(null);
  const [calibration, setCalibration] = useState<Calibration | null>(null);

  // Calibration line placement
  const [calibMode, setCalibMode] = useState(false);
  const [calibPts, setCalibPts] = useState<Pt[]>([]);
  const [calibDialog, setCalibDialog] = useState<{ distPx: number } | null>(null);
  const [calibMm, setCalibMm] = useState("");
  const [calibPreset, setCalibPreset] = useState("custom");

  // Source image (processing resolution) lives outside React state.
  const imageRef = useRef<{ data: ImageData; canvas: HTMLCanvasElement } | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [drag, setDrag] = useState(false);

  const measurements = useMemo(() => (contours ? measure(contours) : null), [contours]);

  /* ------------------------------ detection ------------------------------ */

  const runDetection = useCallback(
    async (p: PipelineParams) => {
      const img = imageRef.current;
      if (!img) return;
      setError(null);
      try {
        setPhase("loadingCV");
        const cv = await loadOpenCV({ timeoutMs: 4500 }).catch(() => null);
        setPhase("processing");
        // Yield a frame so the spinner paints before the heavy sync work.
        await new Promise((r) => requestAnimationFrame(r));
        const result = cv ? detectContours(cv, img.data, p) : detectContoursFallback(img.data, p);
        setContours(result);
        setPhase("ready");
      } catch (e: any) {
        setContours(null);
        setPhase("ready");
        setError(e?.message === "NO_CONTOUR" ? t.noContour : String(e?.message ?? e));
      }
    },
    [t.noContour]
  );

  const onFile = useCallback(
    async (file: File) => {
      try {
        const { imageData } = await fileToImageData(file);
        const autoCalibration = await calibrationFromImageFile(file, settings.scannerDpi);
        const canvas = document.createElement("canvas");
        canvas.width = imageData.width;
        canvas.height = imageData.height;
        canvas.getContext("2d")!.putImageData(imageData, 0, 0);
        imageRef.current = { data: imageData, canvas };
        setContours(null);
        setCalibration(autoCalibration);
        setCalibPts([]);
        setCalibMode(false);
        await runDetection(params);
      } catch (e: any) {
        setError(String(e?.message ?? t.error));
      }
    },
    [params, runDetection, settings.scannerDpi, t.error]
  );

  // Re-run detection with debounce when parameters change.
  const updateParams = (patch: Partial<PipelineParams>) => {
    const next = { ...params, ...patch };
    setParams(next);
    if (!imageRef.current) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => runDetection(next), 350);
  };

  /* ------------------------------- drawing ------------------------------- */

  const redraw = useCallback(() => {
    const img = imageRef.current;
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!img || !canvas || !wrap) return;

    const displayW = wrap.clientWidth;
    const scale = displayW / img.canvas.width;
    const displayH = Math.round(img.canvas.height * scale);
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(displayW * dpr);
    canvas.height = Math.round(displayH * dpr);
    canvas.style.width = `${displayW}px`;
    canvas.style.height = `${displayH}px`;

    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0);
    ctx.drawImage(img.canvas, 0, 0);

    const drawPoly = (pts: Pt[], color: string) => {
      ctx.beginPath();
      pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.closePath();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2.5 / scale;
      ctx.stroke();
    };

    if (contours) {
      drawPoly(contours.outer, "#2563eb");
      contours.inner.forEach((c) => drawPoly(c, "#dc2626"));
    }

    // Calibration line overlay
    if (calibPts.length > 0) {
      ctx.strokeStyle = "#e8a33d";
      ctx.fillStyle = "#e8a33d";
      ctx.lineWidth = 2 / scale;
      const r = 5 / scale;
      calibPts.forEach((p) => {
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fill();
      });
      if (calibPts.length === 2) {
        ctx.beginPath();
        ctx.moveTo(calibPts[0].x, calibPts[0].y);
        ctx.lineTo(calibPts[1].x, calibPts[1].y);
        ctx.stroke();
      }
    }
  }, [contours, calibPts]);

  useEffect(() => {
    redraw();
    const wrap = wrapRef.current;
    if (!wrap) return;
    const ro = new ResizeObserver(redraw);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [redraw]);

  /* ----------------------------- calibration ----------------------------- */

  const onCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!calibMode || !imageRef.current) return;
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const scale = imageRef.current.canvas.width / rect.width;
    const p: Pt = { x: (e.clientX - rect.left) * scale, y: (e.clientY - rect.top) * scale };
    const next = [...calibPts, p].slice(-2);
    setCalibPts(next);
    if (next.length === 2) {
      const distPx = Math.hypot(next[1].x - next[0].x, next[1].y - next[0].y);
      setCalibDialog({ distPx });
    }
  };

  const applyCalibration = () => {
    if (!calibDialog) return;
    const preset = CALIBRATION_PRESETS.find((c) => c.id === calibPreset);
    const mm = preset ? preset.mm : parseFloat(calibMm.replace(",", "."));
    if (!mm || mm <= 0 || calibDialog.distPx <= 0) return;
    const label = preset
      ? (t as any)[`preset${preset.id[0].toUpperCase()}${preset.id.slice(1)}`] ?? preset.id
      : `${mm} ${t.mm}`;
    setCalibration({ mmPerPx: mm / calibDialog.distPx, source: label });
    setCalibDialog(null);
    setCalibMode(false);
    setCalibMm("");
    setCalibPreset("custom");
  };

  /* ------------------------------- persist ------------------------------- */

  const makeRecord = useCallback((): ScanRecord | null => {
    const img = imageRef.current;
    if (!img || !contours || !measurements) return null;
    // Mid-res JPEG doubles as history thumbnail and editor underlay.
    const maxSide = 1000;
    const s = Math.min(1, maxSide / Math.max(img.canvas.width, img.canvas.height));
    const tc = document.createElement("canvas");
    tc.width = Math.round(img.canvas.width * s);
    tc.height = Math.round(img.canvas.height * s);
    tc.getContext("2d")!.drawImage(img.canvas, 0, 0, tc.width, tc.height);
    return {
      id: newId(),
      name: `scan-${new Date().toISOString().slice(0, 16).replace("T", "-").replace(":", "")}`,
      createdAt: Date.now(),
      thumbnail: tc.toDataURL("image/jpeg", 0.75),
      contours,
      measurements,
      calibration,
      imageSize: { w: img.canvas.width, h: img.canvas.height },
    };
  }, [contours, measurements, calibration]);

  const saveToHistory = async () => {
    const record = makeRecord();
    if (!record) return;
    await scanDB.save(record);
    toast(t.saved);
  };

  const openInEditor = async () => {
    const record = makeRecord();
    if (!record) return;
    await scanDB.save(record);
    setCurrent(record);
    router.push("/editor");
  };

  /* --------------------------------- UI ---------------------------------- */

  // Build the exportable record only when detection settles (not every render).
  const record = useMemo(
    () => (phase === "ready" && contours ? makeRecord() : null),
    [phase, contours, makeRecord]
  );

  return (
    <div className="mx-auto max-w-6xl">
      <h1 className="mb-6 font-display text-2xl font-bold">{t.scannerTitle}</h1>

      {!imageRef.current && (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            const f = e.dataTransfer.files?.[0];
            if (f) onFile(f);
          }}
          className={`panel graticule flex min-h-[340px] flex-col items-center justify-center gap-4 border-2 border-dashed p-8 text-center transition-colors ${
            drag ? "border-dye dark:border-dye-bright" : ""
          }`}
        >
          <svg
            viewBox="0 0 24 24"
            className="h-12 w-12 text-dye dark:text-dye-bright"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M3 8V4a1 1 0 0 1 1-1h4M16 3h4a1 1 0 0 1 1 1v4M21 16v4a1 1 0 0 1-1 1h-4M8 21H4a1 1 0 0 1-1-1v-4" />
            <path d="M8 12c2-3 6-3 8 0s-6 7-8 4 6-7 8-4" strokeWidth="1.2" />
          </svg>
          <p className="text-sm">
            {t.dropHere}{" "}
            <button
              className="font-medium text-dye underline underline-offset-2 dark:text-dye-bright"
              onClick={() => fileInputRef.current?.click()}
            >
              {t.browse}
            </button>
          </p>
          <button className="btn-ghost" onClick={() => cameraInputRef.current?.click()}>
            <svg
              viewBox="0 0 24 24"
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
            >
              <path d="M4 8h3l2-2h6l2 2h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z" />
              <circle cx="12" cy="14" r="3.5" />
            </svg>
            {t.useCamera}
          </button>
          <p className="font-mono text-xs text-ink/40 dark:text-paper/40">{t.formats}</p>
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/bmp,.bmp"
        className="hidden"
        onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
      />
      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
      />

      {imageRef.current && (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
          {/* Canvas column */}
          <div className="min-w-0 space-y-4">
            <div ref={wrapRef} className="panel graticule relative overflow-hidden p-0">
              <canvas
                ref={canvasRef}
                onClick={onCanvasClick}
                className={`block w-full ${calibMode ? "cursor-crosshair" : ""}`}
              />
              {(phase === "loadingCV" || phase === "processing") && (
                <div className="absolute inset-0 flex items-center justify-center bg-ink/50 backdrop-blur-sm">
                  <p className="readout animate-pulse rounded-lg bg-ink px-4 py-2 text-sm text-paper">
                    {phase === "loadingCV" ? t.loadingCV : t.processing}
                  </p>
                </div>
              )}
              {calibMode && (
                <p className="readout absolute left-3 top-3 rounded bg-amber px-2 py-1 text-xs text-ink">
                  {calibPts.length < 1 ? t.calibHow : t.calibPickSecond}
                </p>
              )}
            </div>

            {error && (
              <p className="panel border-red-400 p-3 text-sm text-red-600 dark:text-red-400">
                {error}
              </p>
            )}

            {/* Contour legend */}
            {contours && (
              <div className="flex flex-wrap items-center gap-4 text-xs text-ink/60 dark:text-paper/60">
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-0.5 w-5 bg-contour-outer" /> {t.legendOuter}
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-0.5 w-5 bg-contour-inner" /> {t.legendInner} (
                  {contours.inner.length})
                </span>
                <span className="readout ml-auto">
                  {contours.outer.length} {t.pointCount}
                </span>
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              <button className="btn-ghost" onClick={() => fileInputRef.current?.click()}>
                {t.newImage}
              </button>
              <button
                className="btn-ghost"
                disabled={phase !== "ready"}
                onClick={() => runDetection(params)}
              >
                {t.rerun}
              </button>
              {contours && (
                <>
                  <button className="btn-ghost" onClick={saveToHistory}>
                    {t.saveToHistory}
                  </button>
                  <button className="btn-primary" onClick={openInEditor}>
                    {t.openInEditor}
                  </button>
                </>
              )}
            </div>
          </div>

          {/* Controls column */}
          <div className="space-y-4">
            {/* Calibration */}
            <section className="panel p-4">
              <h2 className="mb-3 font-display text-sm font-bold uppercase tracking-wider text-ink/60 dark:text-paper/60">
                {t.calibTitle}
              </h2>
              {calibration ? (
                <div className="mb-3 text-sm">
                  <span className="rounded bg-amber/15 px-2 py-0.5 font-medium text-amber">
                    {t.calibActive}
                  </span>
                  <p className="readout mt-2 text-xs text-ink/60 dark:text-paper/60">
                    {calibration.source} · {(1 / calibration.mmPerPx).toFixed(2)} px/{t.mm}
                  </p>
                </div>
              ) : (
                <p className="mb-3 text-xs text-ink/50 dark:text-paper/50">{t.calibHow}</p>
              )}
              <div className="flex gap-2">
                <button
                  className={calibMode ? "btn-primary" : "btn-ghost"}
                  onClick={() => {
                    setCalibMode(!calibMode);
                    setCalibPts([]);
                  }}
                >
                  {calibMode ? t.calibCancel : t.calibStart}
                </button>
                {calibration && (
                  <button
                    className="btn-ghost"
                    onClick={() => {
                      setCalibration(null);
                      setCalibPts([]);
                    }}
                  >
                    {t.calibClear}
                  </button>
                )}
              </div>
            </section>

            {/* Pipeline parameters */}
            <section className="panel p-4">
              <h2 className="mb-3 font-display text-sm font-bold uppercase tracking-wider text-ink/60 dark:text-paper/60">
                {t.paramsTitle}
              </h2>
              <div className="space-y-4 text-sm">
                <Slider
                  label={t.paramBlur}
                  min={1}
                  max={15}
                  step={2}
                  value={params.blur}
                  onChange={(v) => updateParams({ blur: v })}
                />
                <div>
                  <label className="mb-1 block text-xs text-ink/60 dark:text-paper/60">
                    {t.paramThreshold}
                  </label>
                  <select
                    className="field"
                    value={params.threshold}
                    onChange={(e) =>
                      updateParams({ threshold: e.target.value as PipelineParams["threshold"] })
                    }
                  >
                    <option value="otsu">{t.paramThresholdOtsu}</option>
                    <option value="adaptive">{t.paramThresholdAdaptive}</option>
                  </select>
                </div>
                <Slider
                  label={t.paramMorph}
                  min={0}
                  max={8}
                  step={1}
                  value={params.morph}
                  onChange={(v) => updateParams({ morph: v })}
                />
                <Slider
                  label={t.paramEpsilon}
                  min={0}
                  max={2}
                  step={0.05}
                  value={params.epsilonPct}
                  onChange={(v) => updateParams({ epsilonPct: v })}
                />
                <Slider
                  label={t.paramMinHole}
                  min={0.1}
                  max={10}
                  step={0.1}
                  value={params.minHolePct}
                  onChange={(v) => updateParams({ minHolePct: v })}
                />
                <div>
                  <label className="mb-1 block text-xs text-ink/60 dark:text-paper/60">
                    {t.paramInvert}
                  </label>
                  <select
                    className="field"
                    value={params.invert}
                    onChange={(e) =>
                      updateParams({ invert: e.target.value as PipelineParams["invert"] })
                    }
                  >
                    <option value="auto">{t.invertAuto}</option>
                    <option value="yes">{t.invertYes}</option>
                    <option value="no">{t.invertNo}</option>
                  </select>
                </div>
              </div>
            </section>

            {measurements && <MeasurementsPanel m={measurements} calibration={calibration} />}
            {record && <ExportButtons record={record} />}
          </div>
        </div>
      )}

      {/* Calibration distance dialog */}
      {calibDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/60 p-4">
          <div className="panel w-full max-w-sm p-5">
            <h3 className="mb-3 font-display font-bold">{t.calibTitle}</h3>
            <p className="readout mb-3 text-xs text-ink/60 dark:text-paper/60">
              {calibDialog.distPx.toFixed(1)} {t.px}
            </p>
            <label className="mb-1 block text-xs text-ink/60 dark:text-paper/60">
              {t.calibPreset}
            </label>
            <select
              className="field mb-3"
              value={calibPreset}
              onChange={(e) => setCalibPreset(e.target.value)}
            >
              <option value="custom">{t.presetCustom}</option>
              {CALIBRATION_PRESETS.map((c) => (
                <option key={c.id} value={c.id}>
                  {(t as any)[`preset${c.id[0].toUpperCase()}${c.id.slice(1)}`] ?? c.id}
                </option>
              ))}
            </select>
            {calibPreset === "custom" && (
              <>
                <label className="mb-1 block text-xs text-ink/60 dark:text-paper/60">
                  {t.calibKnownLength}
                </label>
                <input
                  className="field mb-3 readout"
                  inputMode="decimal"
                  placeholder="85.6"
                  value={calibMm}
                  onChange={(e) => setCalibMm(e.target.value)}
                  autoFocus
                />
              </>
            )}
            <div className="flex justify-end gap-2">
              <button
                className="btn-ghost"
                onClick={() => {
                  setCalibDialog(null);
                  setCalibPts([]);
                }}
              >
                {t.cancel}
              </button>
              <button className="btn-primary" onClick={applyCalibration}>
                {t.calibApply}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Labelled range slider with a mono value readout. */
function Slider({
  label,
  min,
  max,
  step,
  value,
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between">
        <label className="text-xs text-ink/60 dark:text-paper/60">{label}</label>
        <span className="readout text-xs text-amber">{value}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full accent-dye dark:accent-dye-bright"
      />
    </div>
  );
}
