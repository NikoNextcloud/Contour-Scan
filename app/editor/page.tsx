"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useApp } from "@/lib/store";
import { getCurrent, setCurrent } from "@/lib/current";
import { scanDB } from "@/lib/db";
import { chaikin, measure, nearestSegment, simplify } from "@/lib/geometry";
import MeasurementsPanel from "@/components/MeasurementsPanel";
import ExportButtons from "@/components/ExportButtons";
import type { ContourSet, Pt, ScanRecord } from "@/lib/types";

/** View transform: image coords → screen = img * scale + (tx, ty). */
interface View {
  scale: number;
  tx: number;
  ty: number;
}

const clone = (c: ContourSet): ContourSet => JSON.parse(JSON.stringify(c));

export default function EditorPage() {
  const { t, toast, settings } = useApp();

  const [record, setRecord] = useState<ScanRecord | null>(null);
  const [contours, setContours] = useState<ContourSet | null>(null);
  const [view, setView] = useState<View>({ scale: 1, tx: 0, ty: 0 });
  const [grid, setGrid] = useState(true);
  const [snap, setSnap] = useState(false);
  const [undoStack, setUndoStack] = useState<ContourSet[]>([]);
  const [redoStack, setRedoStack] = useState<ContourSet[]>([]);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const dragRef = useRef<
    | { kind: "point"; ci: number; pi: number }
    | { kind: "pan"; startX: number; startY: number; startTx: number; startTy: number }
    | null
  >(null);

  /* ------------------------------ load scan ------------------------------ */

  useEffect(() => {
    const rec = getCurrent();
    if (!rec) return;
    setRecord(rec);
    setContours(clone(rec.contours));
    const img = new Image();
    img.onload = () => {
      imgRef.current = img;
      fitView(rec);
    };
    img.src = rec.thumbnail;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fitView = useCallback((rec: ScanRecord) => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const pad = 24;
    const scale = Math.min(
      (wrap.clientWidth - pad * 2) / rec.imageSize.w,
      (wrap.clientHeight - pad * 2) / rec.imageSize.h
    );
    setView({
      scale,
      tx: (wrap.clientWidth - rec.imageSize.w * scale) / 2,
      ty: (wrap.clientHeight - rec.imageSize.h * scale) / 2,
    });
  }, []);

  /* ----------------------------- undo / redo ----------------------------- */

  const pushUndo = useCallback(() => {
    setContours((cur) => {
      if (cur) {
        setUndoStack((s) => [...s.slice(-49), clone(cur)]);
        setRedoStack([]);
      }
      return cur;
    });
  }, []);

  const undo = () => {
    setUndoStack((s) => {
      if (!s.length) return s;
      const prev = s[s.length - 1];
      setContours((cur) => {
        if (cur) setRedoStack((r) => [...r, clone(cur)]);
        return prev;
      });
      return s.slice(0, -1);
    });
  };

  const redo = () => {
    setRedoStack((s) => {
      if (!s.length) return s;
      const next = s[s.length - 1];
      setContours((cur) => {
        if (cur) setUndoStack((u) => [...u, clone(cur)]);
        return next;
      });
      return s.slice(0, -1);
    });
  };

  /* ------------------------------- helpers ------------------------------- */

  /** Flat access to outer (index 0) + inner contours. */
  const polys = useMemo(() => (contours ? [contours.outer, ...contours.inner] : []), [contours]);

  const setPolys = (next: Pt[][]) =>
    setContours({ outer: next[0], inner: next.slice(1) });

  const toImage = (e: { clientX: number; clientY: number }): Pt => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left - view.tx) / view.scale,
      y: (e.clientY - rect.top - view.ty) / view.scale,
    };
  };

  const gridStep = useMemo(() => {
    const k = record?.calibration?.mmPerPx;
    return k ? 5 / k : 25; // 5 mm grid when calibrated, 25 px otherwise
  }, [record]);

  const snapPt = (p: Pt): Pt =>
    snap
      ? { x: Math.round(p.x / gridStep) * gridStep, y: Math.round(p.y / gridStep) * gridStep }
      : p;

  const hitPoint = (p: Pt): { ci: number; pi: number } | null => {
    const tol = 9 / view.scale;
    for (let ci = 0; ci < polys.length; ci++) {
      for (let pi = 0; pi < polys[ci].length; pi++) {
        const q = polys[ci][pi];
        if (Math.hypot(q.x - p.x, q.y - p.y) <= tol) return { ci, pi };
      }
    }
    return null;
  };

  /* ------------------------------- drawing ------------------------------- */

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap || !record) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = wrap.clientWidth * dpr;
    canvas.height = wrap.clientHeight * dpr;
    canvas.style.width = `${wrap.clientWidth}px`;
    canvas.style.height = `${wrap.clientHeight}px`;
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, wrap.clientWidth, wrap.clientHeight);
    ctx.translate(view.tx, view.ty);
    ctx.scale(view.scale, view.scale);

    // Underlay photo, dimmed so the contour reads first.
    if (imgRef.current) {
      ctx.globalAlpha = 0.45;
      ctx.drawImage(imgRef.current, 0, 0, record.imageSize.w, record.imageSize.h);
      ctx.globalAlpha = 1;
    }

    // Grid in image space
    if (grid) {
      ctx.strokeStyle = "rgba(128,148,168,0.25)";
      ctx.lineWidth = 1 / view.scale;
      ctx.beginPath();
      for (let x = 0; x <= record.imageSize.w; x += gridStep) {
        ctx.moveTo(x, 0);
        ctx.lineTo(x, record.imageSize.h);
      }
      for (let y = 0; y <= record.imageSize.h; y += gridStep) {
        ctx.moveTo(0, y);
        ctx.lineTo(record.imageSize.w, y);
      }
      ctx.stroke();
    }

    // Contours + editable points
    polys.forEach((pts, ci) => {
      const color = ci === 0 ? "#2563eb" : "#dc2626";
      ctx.beginPath();
      pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.closePath();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2 / view.scale;
      ctx.stroke();

      const r = 4 / view.scale;
      ctx.fillStyle = "#ffffff";
      for (const p of pts) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    });
  }, [record, polys, view, grid, gridStep]);

  useEffect(() => {
    redraw();
    const wrap = wrapRef.current;
    if (!wrap) return;
    const ro = new ResizeObserver(redraw);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [redraw]);

  /* ------------------------------- events -------------------------------- */

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button === 2) return; // handled by contextmenu
    (e.target as Element).setPointerCapture(e.pointerId);
    const p = toImage(e);
    const hit = hitPoint(p);
    if (hit) {
      pushUndo();
      dragRef.current = { kind: "point", ...hit };
    } else {
      dragRef.current = {
        kind: "pan",
        startX: e.clientX,
        startY: e.clientY,
        startTx: view.tx,
        startTy: view.ty,
      };
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    if (drag.kind === "pan") {
      setView((v) => ({
        ...v,
        tx: drag.startTx + (e.clientX - drag.startX),
        ty: drag.startTy + (e.clientY - drag.startY),
      }));
    } else {
      const p = snapPt(toImage(e));
      const next = polys.map((poly, ci) =>
        ci === drag.ci ? poly.map((q, pi) => (pi === drag.pi ? p : q)) : poly
      );
      setPolys(next);
    }
  };

  const onPointerUp = () => {
    dragRef.current = null;
  };

  const onDoubleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const p = toImage(e);
    let best = { ci: -1, index: 0, dist: Infinity };
    polys.forEach((poly, ci) => {
      const seg = nearestSegment(poly, p);
      if (seg.dist < best.dist) best = { ci, ...seg };
    });
    if (best.ci === -1 || best.dist > 15 / view.scale) return;
    pushUndo();
    const next = polys.map((poly, ci) => {
      if (ci !== best.ci) return poly;
      const copy = [...poly];
      copy.splice(best.index + 1, 0, snapPt(p));
      return copy;
    });
    setPolys(next);
  };

  const onContextMenu = (e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const hit = hitPoint(toImage(e));
    if (!hit || polys[hit.ci].length <= 3) return;
    pushUndo();
    const next = polys.map((poly, ci) =>
      ci === hit.ci ? poly.filter((_, pi) => pi !== hit.pi) : poly
    );
    setPolys(next);
  };

  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    setView((v) => {
      const scale = Math.min(40, Math.max(0.05, v.scale * factor));
      // Keep the point under the cursor fixed while zooming.
      const k = scale / v.scale;
      return { scale, tx: mx - (mx - v.tx) * k, ty: my - (my - v.ty) * k };
    });
  };

  /* -------------------------------- tools -------------------------------- */

  const applyAll = (fn: (pts: Pt[]) => Pt[]) => {
    pushUndo();
    setPolys(polys.map(fn));
  };

  const save = async () => {
    if (!record || !contours) return;
    const updated: ScanRecord = { ...record, contours, measurements: measure(contours) };
    await scanDB.save(updated);
    setCurrent(updated);
    setRecord(updated);
    toast(t.changesSaved);
  };

  /* --------------------------------- UI ---------------------------------- */

  if (!record || !contours) {
    return (
      <div className="mx-auto max-w-6xl">
        <h1 className="mb-6 font-display text-2xl font-bold">{t.editorTitle}</h1>
        <div className="panel graticule flex min-h-[300px] flex-col items-center justify-center gap-2 p-8 text-center">
          <p className="font-medium">{t.editorEmpty}</p>
          <p className="text-sm text-ink/50 dark:text-paper/50">{t.editorEmptyHint}</p>
          <Link href="/scanner" className="btn-primary mt-3">
            {t.ctaScan}
          </Link>
        </div>
      </div>
    );
  }

  const liveMeasurements = measure(contours);
  const liveRecord: ScanRecord = { ...record, contours, measurements: liveMeasurements };

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-2xl font-bold">{t.editorTitle}</h1>
        <span className="readout text-xs text-ink/50 dark:text-paper/50">
          {record.name} · {polys.reduce((s, p) => s + p.length, 0)} {t.pointCount}
        </span>
      </div>

      {/* Toolbar */}
      <div className="mb-3 flex flex-wrap gap-2">
        <button className="btn-ghost" onClick={() => applyAll((p) => chaikin(p, settings.smoothing))}>
          {t.toolSmooth}
        </button>
        <button className="btn-ghost" onClick={() => applyAll((p) => simplify(p, 2))}>
          {t.toolSimplify}
        </button>
        <button className="btn-ghost" onClick={undo} disabled={!undoStack.length}>
          ↩ {t.toolUndo}
        </button>
        <button className="btn-ghost" onClick={redo} disabled={!redoStack.length}>
          ↪ {t.toolRedo}
        </button>
        <button className={grid ? "btn-primary" : "btn-ghost"} onClick={() => setGrid(!grid)}>
          {t.toolGrid}
        </button>
        <button className={snap ? "btn-primary" : "btn-ghost"} onClick={() => setSnap(!snap)}>
          {t.toolSnap}
        </button>
        <button className="btn-ghost" onClick={() => fitView(record)}>
          {t.toolResetView}
        </button>
        <button className="btn-primary ml-auto" onClick={save}>
          {t.saveChanges}
        </button>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0">
          <div
            ref={wrapRef}
            className="panel graticule relative h-[60vh] min-h-[380px] touch-none overflow-hidden p-0"
          >
            <canvas
              ref={canvasRef}
              className="block h-full w-full cursor-grab active:cursor-grabbing"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onDoubleClick={onDoubleClick}
              onContextMenu={onContextMenu}
              onWheel={onWheel}
            />
          </div>
          <p className="mt-2 text-xs text-ink/50 dark:text-paper/50">{t.editorHint}</p>
        </div>

        <div className="space-y-4">
          <MeasurementsPanel m={liveMeasurements} calibration={record.calibration} />
          <ExportButtons record={liveRecord} />
        </div>
      </div>
    </div>
  );
}
