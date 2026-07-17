"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useApp } from "@/lib/store";
import { loadOpenCV } from "@/lib/opencv";
import {
  DEFAULT_IMAGE_OPTIONS,
  applyImageOptions,
  detectContours,
  detectContoursFallback,
  fileToImageData,
  type ImageOptions,
} from "@/lib/pipeline";
import { calibrationFromImageFile } from "@/lib/image-metadata";
import { measure, mirrorContourSet, smoothContourSet } from "@/lib/geometry";
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
  const [imageOptions, setImageOptions] = useState<ImageOptions>(DEFAULT_IMAGE_OPTIONS);
  const [contours, setContours] = useState<ContourSet | null>(null);
  const [calibration, setCalibration] = useState<Calibration | null>(null);

  // Calibration line placement
  const [calibMode, setCalibMode] = useState(false);
  const [calibPts, setCalibPts] = useState<Pt[]>([]);
  const [calibDialog, setCalibDialog] = useState<{ distPx: number } | null>(null);
  const [calibMm, setCalibMm] = useState("");
  const [calibPreset, setCalibPreset] = useState("custom");

  // Source image (processing resolution) lives outside React state.
  const imageRef = useRef<{ data: ImageData; original: ImageData; canvas: HTMLCanvasElement } | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [drag, setDrag] = useState(false);
  const [scanView, setScanView] = useState({ zoom: 1, tx: 0, ty: 0 });
  const [fullScreenScanner, setFullScreenScanner] = useState(false);
  const scanPanRef = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);

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
        const raw = cv ? detectContours(cv, img.data, p) : detectContoursFallback(img.data, p);
        const mirrored = mirrorContourSet(raw, p.mirrorMode);
        const result = smoothContourSet(mirrored, p.smoothIterations);
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

  const applyImageOptionsToCurrent = useCallback(
    async (nextOptions: ImageOptions, nextParams = params) => {
      const img = imageRef.current;
      if (!img) return;
      const adjusted = applyImageOptions(img.original, nextOptions);
      const canvas = document.createElement("canvas");
      canvas.width = adjusted.width;
      canvas.height = adjusted.height;
      canvas.getContext("2d")!.putImageData(adjusted, 0, 0);
      imageRef.current = { ...img, data: adjusted, canvas };
      await runDetection(nextParams);
    },
    [params, runDetection]
  );

  const onFile = useCallback(
    async (file: File) => {
      try {
        const { imageData } = await fileToImageData(file);
        const autoCalibration = await calibrationFromImageFile(file, settings.scannerDpi);
        const adjusted = applyImageOptions(imageData, imageOptions);
        const canvas = document.createElement("canvas");
        canvas.width = adjusted.width;
        canvas.height = adjusted.height;
        canvas.getContext("2d")!.putImageData(adjusted, 0, 0);
        imageRef.current = { data: adjusted, original: imageData, canvas };
        setContours(null);
        setCalibration(autoCalibration);
        setCalibPts([]);
        setCalibMode(false);
        setScanView({ zoom: 1, tx: 0, ty: 0 });
        await runDetection(params);
      } catch (e: any) {
        setError(String(e?.message ?? t.error));
      }
    },
    [params, runDetection, settings.scannerDpi, imageOptions, t.error]
  );

  // Re-run detection with debounce when parameters change.
  const updateParams = (patch: Partial<PipelineParams>) => {
    const next = { ...params, ...patch };
    setParams(next);
    if (!imageRef.current) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => runDetection(next), 350);
  };

  const applyMaxAccuracy = () => {
    const next: PipelineParams = {
      ...params,
      blur: 1,
      morph: 0,
      epsilonPct: 0.01,
      smoothIterations: 0,
      minHolePct: 0.1,
      threshold: "adaptive",
    };
    setParams(next);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (imageRef.current) runDetection(next);
  };

  const updateImageOptions = (patch: Partial<ImageOptions>) => {
    const next = { ...imageOptions, ...patch };
    setImageOptions(next);
    if (!imageRef.current) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => applyImageOptionsToCurrent(next), 350);
  };

  /* ------------------------------- drawing ------------------------------- */

  const redraw = useCallback(() => {
    const img = imageRef.current;
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!img || !canvas || !wrap) return;

    const displayW = wrap.clientWidth;
    const displayH = wrap.clientHeight || Math.min(window.innerHeight - 180, 860);
    const scale = scanView.zoom;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(displayW * dpr);
    canvas.height = Math.round(displayH * dpr);
    canvas.style.width = `${displayW}px`;
    canvas.style.height = `${displayH}px`;

    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, displayW, displayH);
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * scanView.tx, dpr * scanView.ty);
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
  }, [contours, calibPts, scanView]);

  const onScanWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    setScanView((view) => {
      const zoom = Math.max(0.1, Math.min(8, view.zoom * factor));
      const k = zoom / view.zoom;
      return { zoom, tx: mx - (mx - view.tx) * k, ty: my - (my - view.ty) * k };
    });
  };

  const centerScanView = () => {
    const img = imageRef.current;
    const wrap = wrapRef.current;
    if (!img || !wrap) return;
    setScanView((view) => ({
      ...view,
      tx: (wrap.clientWidth - img.canvas.width * view.zoom) / 2,
      ty: (wrap.clientHeight - img.canvas.height * view.zoom) / 2,
    }));
  };

  const setOneToOneView = () => {
    setScanView({ zoom: 1, tx: 0, ty: 0 });
  };

  const fitScanToScreen = () => {
    const img = imageRef.current;
    const wrap = wrapRef.current;
    if (!img || !wrap) return;
    const pad = 24;
    const zoom = Math.min(
      (wrap.clientWidth - pad * 2) / img.canvas.width,
      (wrap.clientHeight - pad * 2) / img.canvas.height
    );
    const nextZoom = Math.max(0.1, Math.min(8, zoom));
    setScanView({
      zoom: nextZoom,
      tx: (wrap.clientWidth - img.canvas.width * nextZoom) / 2,
      ty: (wrap.clientHeight - img.canvas.height * nextZoom) / 2,
    });
  };

  const stepZoom = (factor: number) => {
    setScanView((view) => ({ ...view, zoom: Math.max(0.1, Math.min(8, view.zoom * factor)) }));
  };

  const onScanPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!imageRef.current) return;
    (e.target as Element).setPointerCapture(e.pointerId);
    scanPanRef.current = { x: e.clientX, y: e.clientY, tx: scanView.tx, ty: scanView.ty };
  };

  const onScanPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const pan = scanPanRef.current;
    if (!pan) return;
    setScanView((view) => ({ ...view, tx: pan.tx + e.clientX - pan.x, ty: pan.ty + e.clientY - pan.y }));
  };

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
    const scale = scanView.zoom;
    const p: Pt = {
      x: (e.clientX - rect.left - scanView.tx) / scale,
      y: (e.clientY - rect.top - scanView.ty) / scale,
    };
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
    // Keep the editor underlay at the full scan size so the template stays visually 1:1.
    const s = 1;
    const tc = document.createElement("canvas");
    tc.width = Math.round(img.canvas.width * s);
    tc.height = Math.round(img.canvas.height * s);
    tc.getContext("2d")!.drawImage(img.canvas, 0, 0, tc.width, tc.height);
    return {
      id: newId(),
      name: `scan-${new Date().toISOString().slice(0, 16).replace("T", "-").replace(":", "")}`,
      createdAt: Date.now(),
      thumbnail: tc.toDataURL("image/jpeg", 0.92),
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
    <div
      className={
        fullScreenScanner
          ? "fixed inset-0 z-[100] overflow-hidden bg-paper p-3 text-ink dark:bg-ink dark:text-paper"
          : "mx-auto max-w-[1760px]"
      }
    >
      <div className={fullScreenScanner ? "mb-3 flex items-center justify-between gap-3" : ""}>
        <h1 className={fullScreenScanner ? "font-display text-xl font-bold" : "mb-6 font-display text-2xl font-bold"}>
          {t.scannerTitle}
        </h1>
        {fullScreenScanner && (
          <button className="btn-primary" onClick={() => setFullScreenScanner(false)}>
            Изход от цял екран
          </button>
        )}
      </div>

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
        <div
          className={
            fullScreenScanner
              ? "grid h-[calc(100vh-76px)] gap-3 lg:grid-cols-[minmax(0,1fr)_380px]"
              : "grid h-[calc(100vh-116px)] min-h-[760px] gap-4 lg:grid-cols-[minmax(0,1fr)_360px]"
          }
        >
          {/* Canvas column */}
          <div className={fullScreenScanner ? "flex min-h-0 min-w-0 flex-col gap-3" : "sticky top-3 flex min-h-0 min-w-0 flex-col gap-3 self-start"}>
            <div
              ref={wrapRef}
              className={
                fullScreenScanner
                  ? "panel graticule relative min-h-0 flex-1 overflow-hidden p-0"
                  : "panel graticule relative h-[calc(100vh-170px)] min-h-[720px] overflow-hidden p-0"
              }
            >
              <canvas
                ref={canvasRef}
                onClick={onCanvasClick}
                onWheel={onScanWheel}
                onPointerDown={onScanPointerDown}
                onPointerMove={onScanPointerMove}
                onPointerUp={() => (scanPanRef.current = null)}
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

            <div className="hidden flex-wrap gap-2">
              <button className="btn-primary" onClick={() => setFullScreenScanner(true)}>
                Цял екран
              </button>
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
          <div className={fullScreenScanner ? "min-h-0 space-y-3 overflow-y-auto pr-1" : "min-h-0 space-y-4 overflow-y-auto pr-1"}>
            <section className="panel p-4">
              <h2 className="mb-3 font-display text-sm font-bold uppercase tracking-wider text-ink/60 dark:text-paper/60">
                Инструменти
              </h2>
              <div className="grid grid-cols-2 gap-2">
                <ActionButton icon="expand" label="Цял екран" onClick={() => setFullScreenScanner(true)} />
                <ActionButton icon="one" label="1:1 реален" active={Math.abs(scanView.zoom - 1) < 0.001} onClick={setOneToOneView} />
                <ActionButton icon="fit" label="Побери" onClick={fitScanToScreen} />
                <ActionButton icon="center" label="Центрирай" onClick={centerScanView} />
                <ActionButton icon="zoomIn" label="Увеличи" onClick={() => stepZoom(1.18)} />
                <ActionButton icon="zoomOut" label="Намали" onClick={() => stepZoom(1 / 1.18)} />
                <ActionButton icon="image" label="Нова снимка" onClick={() => fileInputRef.current?.click()} />
                <ActionButton icon="refresh" label="Обнови" disabled={phase !== "ready"} onClick={() => runDetection(params)} />
                <ActionButton icon="save" label="Запази" disabled={!contours} onClick={saveToHistory} />
                <ActionButton icon="edit" label="Редактор" primary disabled={!contours} onClick={openInEditor} />
              </div>
              <button className="btn-primary mt-3 w-full" onClick={applyMaxAccuracy}>
                <ScannerSvgIcon name="spark" /> Макс. точност на контура
              </button>
              <div className="mt-3 rounded-lg border border-paper-3 p-3 text-xs dark:border-ink-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-ink/60 dark:text-paper/60">Мащаб</span>
                  <strong className="readout text-amber">{Math.round(scanView.zoom * 100)}%</strong>
                </div>
                <input
                  type="range"
                  min={0.1}
                  max={8}
                  step={0.05}
                  value={scanView.zoom}
                  onChange={(e) => setScanView((view) => ({ ...view, zoom: parseFloat(e.target.value) }))}
                  className="mt-2 w-full accent-dye dark:accent-dye-bright"
                />
                <p className="mt-2 text-ink/50 dark:text-paper/50">
                  Скенът се зарежда 1:1. Влачи с мишката за местене, скролирай за zoom.
                </p>
              </div>
            </section>

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

            <section className="panel p-4">
              <h2 className="mb-3 font-display text-sm font-bold uppercase tracking-wider text-ink/60 dark:text-paper/60">
                A3 2400S Scanner
              </h2>
              <p className="mb-3 text-xs text-ink/55 dark:text-paper/55">
                Директно управление на TWAIN/WIA скенер от Vercel браузър не е разрешено от Windows/Chrome.
                Сканирай с A3 2400S Panel към Desktop\Скенер като BMP 300 DPI, после зареди файла тук.
              </p>
              <button className="btn-ghost w-full" onClick={() => fileInputRef.current?.click()}>
                Зареди последния BMP скан
              </button>
            </section>

            {/* Pipeline parameters */}
            <section className="panel p-4">
              <h2 className="mb-3 font-display text-sm font-bold uppercase tracking-wider text-ink/60 dark:text-paper/60">
                {t.paramsTitle}
              </h2>
              <div className="space-y-4 text-sm">
                <Slider
                  label="Мащаб"
                  min={0.25}
                  max={6}
                  step={0.05}
                  value={scanView.zoom}
                  onChange={(v) => setScanView((view) => ({ ...view, zoom: v }))}
                />
                <div className="rounded-lg border border-paper-3 p-3 dark:border-ink-3">
                  <p className="mb-3 text-xs font-bold uppercase tracking-wider text-ink/60 dark:text-paper/60">
                    Опции на изображението
                  </p>
                  <Slider label="Контраст" min={-100} max={100} step={1} value={imageOptions.contrast} onChange={(v) => updateImageOptions({ contrast: v })} />
                  <Slider label="Яркост" min={-100} max={100} step={1} value={imageOptions.brightness} onChange={(v) => updateImageOptions({ brightness: v })} />
                  <Slider label="Гама" min={0.2} max={3} step={0.05} value={imageOptions.gamma} onChange={(v) => updateImageOptions({ gamma: v })} />
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <ToggleButton active={imageOptions.invert} label="Инверт" icon="invert" onClick={() => updateImageOptions({ invert: !imageOptions.invert })} />
                    <ToggleButton active={imageOptions.grayscale} label="Черно-бяло" icon="gray" onClick={() => updateImageOptions({ grayscale: !imageOptions.grayscale })} />
                    <ToggleButton active={imageOptions.borderEnabled} label="Рамка" icon="border" onClick={() => updateImageOptions({ borderEnabled: !imageOptions.borderEnabled })} />
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    <ToggleButton active={imageOptions.borderShape === "rect"} label="Правоъгълна" icon="rect" onClick={() => updateImageOptions({ borderShape: "rect" })} />
                    <ToggleButton active={imageOptions.borderShape === "oval"} label="Овална" icon="circle" onClick={() => updateImageOptions({ borderShape: "oval" })} />
                  </div>
                  <Slider label="Дебелина на рамката" min={0} max={80} step={1} value={imageOptions.borderWidth} onChange={(v) => updateImageOptions({ borderWidth: v })} />
                </div>
                <Slider
                  label={t.paramBlur}
                  min={1}
                  max={15}
                  step={1}
                  value={params.blur}
                  onChange={(v) => updateParams({ blur: v })}
                />
                <div>
                  <label className="mb-1 block text-xs text-ink/60 dark:text-paper/60">
                    {t.paramThreshold}
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    <ToggleButton active={params.threshold === "otsu"} label="Равен фон" icon="auto" onClick={() => updateParams({ threshold: "otsu" })} />
                    <ToggleButton active={params.threshold === "adaptive"} label="Неравен фон" icon="spark" onClick={() => updateParams({ threshold: "adaptive" })} />
                  </div>
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
                  min={0.005}
                  max={2}
                  step={0.005}
                  value={params.epsilonPct}
                  onChange={(v) => updateParams({ epsilonPct: v })}
                />
                <Slider
                  label="Плавност на скана"
                  min={0}
                  max={4}
                  step={1}
                  value={params.smoothIterations}
                  onChange={(v) => updateParams({ smoothIterations: v })}
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
                  <div className="grid grid-cols-3 gap-2">
                    <ToggleButton active={params.invert === "auto"} label="Авто" icon="auto" onClick={() => updateParams({ invert: "auto" })} />
                    <ToggleButton active={params.invert === "yes"} label="Да" icon="invert" onClick={() => updateParams({ invert: "yes" })} />
                    <ToggleButton active={params.invert === "no"} label="Не" icon="eye" onClick={() => updateParams({ invert: "no" })} />
                  </div>
                </div>
                <div>
                  <label className="mb-1 block text-xs text-ink/60 dark:text-paper/60">
                    Mirror от едната страна
                  </label>
                  <select
                    className="field"
                    value={params.mirrorMode}
                    onChange={(e) =>
                      updateParams({ mirrorMode: e.target.value as PipelineParams["mirrorMode"] })
                    }
                  >
                    <option value="off">Изключено</option>
                    <option value="leftToRight">Лява страна → дясна mirror</option>
                    <option value="rightToLeft">Дясна страна → лява mirror</option>
                    <option value="topToBottom">Горна страна → долна mirror</option>
                    <option value="bottomToTop">Долна страна → горна mirror</option>
                  </select>
                  <p className="mt-1 text-xs text-ink/50 dark:text-paper/50">
                    Ползвай това за симетрични детайли, когато едната страна е по-чиста от другата.
                  </p>
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

type ScannerIcon =
  | "expand"
  | "one"
  | "fit"
  | "center"
  | "zoomIn"
  | "zoomOut"
  | "image"
  | "refresh"
  | "save"
  | "edit"
  | "invert"
  | "gray"
  | "border"
  | "rect"
  | "circle"
  | "auto"
  | "spark"
  | "eye"
  | "mirror";

function ActionButton({
  icon,
  label,
  active,
  primary,
  disabled,
  onClick,
}: {
  icon: ScannerIcon;
  label: string;
  active?: boolean;
  primary?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={`inline-flex min-h-12 items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        primary || active
          ? "border-dye bg-dye text-white dark:border-dye-bright dark:bg-dye-bright dark:text-ink"
          : "border-paper-3 bg-paper-2 hover:bg-ink/5 dark:border-ink-3 dark:bg-ink-2 dark:hover:bg-paper/5"
      }`}
      disabled={disabled}
      onClick={onClick}
      title={label}
    >
      <ScannerSvgIcon name={icon} />
      <span>{label}</span>
    </button>
  );
}

function ToggleButton({
  icon,
  label,
  active,
  onClick,
}: {
  icon: ScannerIcon;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={`inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border px-2 py-2 text-xs font-medium transition-colors ${
        active
          ? "border-dye bg-dye/12 text-dye dark:border-dye-bright dark:bg-dye-bright/15 dark:text-dye-bright"
          : "border-paper-3 bg-paper-2 hover:bg-ink/5 dark:border-ink-3 dark:bg-ink-2 dark:hover:bg-paper/5"
      }`}
      onClick={onClick}
      type="button"
      title={label}
    >
      <ScannerSvgIcon name={icon} />
      <span>{label}</span>
    </button>
  );
}

function ScannerSvgIcon({ name }: { name: ScannerIcon }) {
  const common = {
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0" aria-hidden>
      {name === "expand" && <path {...common} d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />}
      {name === "one" && <path {...common} d="M7 4h10v16H7zM11 8l2-1v10" />}
      {name === "fit" && <path {...common} d="M5 5h14v14H5zM9 9h6v6H9z" />}
      {name === "center" && <path {...common} d="M12 3v18M3 12h18M8 8l8 8M16 8l-8 8" />}
      {name === "zoomIn" && <path {...common} d="M10 5a5 5 0 1 0 0 10 5 5 0 0 0 0-10zM10 8v4M8 10h4M14 14l5 5" />}
      {name === "zoomOut" && <path {...common} d="M10 5a5 5 0 1 0 0 10 5 5 0 0 0 0-10zM8 10h4M14 14l5 5" />}
      {name === "image" && <path {...common} d="M4 6h16v12H4zM8 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM4 16l5-5 4 4 2-2 5 5" />}
      {name === "refresh" && <path {...common} d="M20 7v5h-5M4 17v-5h5M18 9a7 7 0 0 0-12-2M6 15a7 7 0 0 0 12 2" />}
      {name === "save" && <path {...common} d="M5 4h12l2 2v14H5zM8 4v6h8M8 20v-6h8v6" />}
      {name === "edit" && <path {...common} d="M4 20h4l11-11-4-4L4 16v4zM13 7l4 4" />}
      {name === "invert" && <path {...common} d="M12 4a8 8 0 1 0 0 16V4z" />}
      {name === "gray" && <path {...common} d="M5 5h14v14H5zM5 12h14" />}
      {name === "border" && <path {...common} d="M5 5h14v14H5zM8 8h8v8H8z" />}
      {name === "rect" && <rect {...common} x="5" y="7" width="14" height="10" rx="1" />}
      {name === "circle" && <circle {...common} cx="12" cy="12" r="7" />}
      {name === "auto" && <path {...common} d="M5 12a7 7 0 0 1 12-5M19 5v5h-5M19 12a7 7 0 0 1-12 5M5 19v-5h5" />}
      {name === "spark" && <path {...common} d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3zM18 15l.8 2.2L21 18l-2.2.8L18 21l-.8-2.2L15 18l2.2-.8L18 15z" />}
      {name === "eye" && <path {...common} d="M3 12s3-6 9-6 9 6 9 6-3 6-9 6-9-6-9-6zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z" />}
      {name === "mirror" && <path {...common} d="M12 4v16M5 7l5 5-5 5V7zM19 7l-5 5 5 5V7z" />}
    </svg>
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
