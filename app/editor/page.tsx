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

interface View {
  scale: number;
  tx: number;
  ty: number;
}

type ToolMode =
  | "select"
  | "move"
  | "rotate"
  | "delete"
  | "scissors"
  | "circle"
  | "triangle"
  | "square"
  | "polyline";

type DragState =
  | { kind: "point"; ci: number; pi: number }
  | { kind: "move-all"; start: Pt; contours: ContourSet }
  | { kind: "pan"; startX: number; startY: number; startTx: number; startTy: number }
  | null;

const clone = (c: ContourSet): ContourSet => JSON.parse(JSON.stringify(c));
const pointKey = (ci: number, pi: number) => `${ci}:${pi}`;

const mapContourSet = (c: ContourSet, fn: (p: Pt) => Pt): ContourSet => ({
  outer: c.outer.map(fn),
  inner: c.inner.map((poly) => poly.map(fn)),
  polylines: c.polylines?.map((line) => line.map(fn)),
});

const translateContourSet = (c: ContourSet, dx: number, dy: number): ContourSet =>
  mapContourSet(c, (p) => ({ x: p.x + dx, y: p.y + dy }));

const rotateContourSet = (c: ContourSet, pivot: Pt, angleDeg: number): ContourSet => {
  const angle = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return mapContourSet(c, (p) => {
    const x = p.x - pivot.x;
    const y = p.y - pivot.y;
    return {
      x: pivot.x + x * cos - y * sin,
      y: pivot.y + x * sin + y * cos,
    };
  });
};

const contourCenter = (c: ContourSet): Pt => {
  const pts = [c.outer, ...c.inner, ...(c.polylines ?? [])].flat();
  if (!pts.length) return { x: 0, y: 0 };
  const box = pts.reduce(
    (acc, p) => ({
      minX: Math.min(acc.minX, p.x),
      minY: Math.min(acc.minY, p.y),
      maxX: Math.max(acc.maxX, p.x),
      maxY: Math.max(acc.maxY, p.y),
    }),
    { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
  );
  return { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 };
};

export default function EditorPage() {
  const { t, toast, settings } = useApp();

  const [record, setRecord] = useState<ScanRecord | null>(null);
  const [contours, setContours] = useState<ContourSet | null>(null);
  const [view, setView] = useState<View>({ scale: 1, tx: 0, ty: 0 });
  const [grid, setGrid] = useState(true);
  const [snap, setSnap] = useState(false);
  const [tool, setTool] = useState<ToolMode>("select");
  const [shapeDiameter, setShapeDiameter] = useState(20);
  const [moveDx, setMoveDx] = useState(0);
  const [moveDy, setMoveDy] = useState(0);
  const [pivot, setPivot] = useState<Pt | null>(null);
  const [usePivotCoordinates, setUsePivotCoordinates] = useState(false);
  const [rotationType, setRotationType] = useState<"absolute" | "relative">("relative");
  const [rotationAngle, setRotationAngle] = useState(0);
  const [appliedAbsoluteAngle, setAppliedAbsoluteAngle] = useState(0);
  const [polyDraft, setPolyDraft] = useState<Pt[]>([]);
  const [selectedPoints, setSelectedPoints] = useState<Set<string>>(new Set());
  const [undoStack, setUndoStack] = useState<ContourSet[]>([]);
  const [redoStack, setRedoStack] = useState<ContourSet[]>([]);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const dragRef = useRef<DragState>(null);

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
    const pad = 18;
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

  const polys = useMemo(() => (contours ? [contours.outer, ...contours.inner] : []), [contours]);
  const openLines = useMemo(() => contours?.polylines ?? [], [contours]);
  const selectedCount = selectedPoints.size;

  const setPolys = (next: Pt[][]) => {
    setContours((cur) => ({ outer: next[0], inner: next.slice(1), polylines: cur?.polylines ?? [] }));
  };

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
      setSelectedPoints(new Set());
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
      setSelectedPoints(new Set());
      return s.slice(0, -1);
    });
  };

  const toImage = (e: { clientX: number; clientY: number }): Pt => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left - view.tx) / view.scale,
      y: (e.clientY - rect.top - view.ty) / view.scale,
    };
  };

  const gridStep = useMemo(() => {
    const k = record?.calibration?.mmPerPx;
    return k ? 5 / k : 25;
  }, [record]);

  const snapPt = (p: Pt): Pt =>
    snap
      ? { x: Math.round(p.x / gridStep) * gridStep, y: Math.round(p.y / gridStep) * gridStep }
      : p;

  const hitPoint = (p: Pt): { ci: number; pi: number } | null => {
    const tol = 11 / view.scale;
    for (let ci = 0; ci < polys.length; ci++) {
      for (let pi = 0; pi < polys[ci].length; pi++) {
        const q = polys[ci][pi];
        if (Math.hypot(q.x - p.x, q.y - p.y) <= tol) return { ci, pi };
      }
    }
    return null;
  };

  const diameterPx = () => {
    const k = record?.calibration?.mmPerPx;
    return k ? shapeDiameter / k : shapeDiameter;
  };

  const distanceToPx = (value: number) => {
    const k = record?.calibration?.mmPerPx;
    return k ? value / k : value;
  };

  const applyMove = () => {
    if (!contours) return;
    const dx = distanceToPx(moveDx);
    const dy = distanceToPx(moveDy);
    if (!dx && !dy) return;
    pushUndo();
    setContours((cur) => (cur ? translateContourSet(cur, dx, dy) : cur));
    setSelectedPoints(new Set());
  };

  const applyRotation = () => {
    if (!contours) return;
    const center = pivot ?? contourCenter(contours);
    const delta = rotationType === "absolute" ? rotationAngle - appliedAbsoluteAngle : rotationAngle;
    if (!delta) return;
    pushUndo();
    setContours((cur) => (cur ? rotateContourSet(cur, center, delta) : cur));
    setPivot(center);
    setAppliedAbsoluteAngle(rotationType === "absolute" ? rotationAngle : appliedAbsoluteAngle + delta);
    setSelectedPoints(new Set());
  };

  const toggleSelectedPoint = (ci: number, pi: number) => {
    setSelectedPoints((current) => {
      const next = new Set(current);
      const key = pointKey(ci, pi);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

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

    if (imgRef.current) {
      ctx.globalAlpha = 0.42;
      ctx.drawImage(imgRef.current, 0, 0, record.imageSize.w, record.imageSize.h);
      ctx.globalAlpha = 1;
    }

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

    polys.forEach((pts, ci) => {
      const color = ci === 0 ? "#2563eb" : "#dc2626";
      ctx.beginPath();
      pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.closePath();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2.2 / view.scale;
      ctx.stroke();

      const r = 4.5 / view.scale;
      for (let pi = 0; pi < pts.length; pi++) {
        const p = pts[pi];
        const selected = selectedPoints.has(pointKey(ci, pi));
        ctx.beginPath();
        ctx.arc(p.x, p.y, selected ? r * 1.75 : r, 0, Math.PI * 2);
        ctx.fillStyle = selected ? "#e8a33d" : "#ffffff";
        ctx.strokeStyle = selected ? "#111827" : color;
        ctx.lineWidth = selected ? 2.5 / view.scale : 1.4 / view.scale;
        ctx.fill();
        ctx.stroke();
      }
    });

    const drawOpen = (pts: Pt[], color: string) => {
      if (pts.length < 2) return;
      ctx.beginPath();
      pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.strokeStyle = color;
      ctx.lineWidth = 2 / view.scale;
      ctx.stroke();
      for (const p of pts) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 4 / view.scale, 0, Math.PI * 2);
        ctx.fillStyle = "#ffffff";
        ctx.fill();
        ctx.stroke();
      }
    };

    openLines.forEach((line) => drawOpen(line, "#16a34a"));
    drawOpen(polyDraft, "#e8a33d");

    if (tool === "rotate") {
      const center = pivot ?? (contours ? contourCenter(contours) : null);
      if (center) {
        const r = 9 / view.scale;
        ctx.beginPath();
        ctx.arc(center.x, center.y, r, 0, Math.PI * 2);
        ctx.moveTo(center.x - r * 1.6, center.y);
        ctx.lineTo(center.x + r * 1.6, center.y);
        ctx.moveTo(center.x, center.y - r * 1.6);
        ctx.lineTo(center.x, center.y + r * 1.6);
        ctx.strokeStyle = "#e8a33d";
        ctx.lineWidth = 2 / view.scale;
        ctx.stroke();
      }
    }
  }, [record, contours, polys, openLines, polyDraft, selectedPoints, view, grid, gridStep, tool, pivot]);

  useEffect(() => {
    redraw();
    const wrap = wrapRef.current;
    if (!wrap) return;
    const ro = new ResizeObserver(redraw);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [redraw]);

  const deleteSelectedPoints = () => {
    if (!selectedPoints.size) return;
    pushUndo();
    const next = polys.map((poly, ci) => {
      const filtered = poly.filter((_, pi) => !selectedPoints.has(pointKey(ci, pi)));
      return filtered.length >= 3 ? filtered : poly;
    });
    setPolys(next);
    setSelectedPoints(new Set());
  };

  const deleteNearestPoint = (p: Pt) => {
    const hit = hitPoint(p);
    if (!hit || polys[hit.ci].length <= 3) return;
    pushUndo();
    const next = polys.map((poly, ci) =>
      ci === hit.ci ? poly.filter((_, pi) => pi !== hit.pi) : poly
    );
    setPolys(next);
    setSelectedPoints(new Set());
  };

  const cutNearestSegment = (p: Pt) => {
    let best = { ci: -1, index: 0, dist: Infinity };
    polys.forEach((poly, ci) => {
      const seg = nearestSegment(poly, p);
      if (seg.dist < best.dist) best = { ci, ...seg };
    });
    if (best.ci === -1 || best.dist > 18 / view.scale) return;
    pushUndo();
    const source = polys[best.ci];
    const open = source.slice(best.index + 1).concat(source.slice(0, best.index + 1));
    if (best.ci === 0) {
      setContours((cur) => cur && { ...cur, polylines: [...(cur.polylines ?? []), open] });
    } else {
      const next = polys.filter((_, ci) => ci !== best.ci);
      setContours((cur) => ({
        outer: next[0],
        inner: next.slice(1),
        polylines: [...(cur?.polylines ?? []), open],
      }));
    }
    setSelectedPoints(new Set());
  };

  const addShape = (shape: "circle" | "triangle" | "square", center: Pt) => {
    const d = diameterPx();
    const r = d / 2;
    let pts: Pt[];
    if (shape === "circle") {
      pts = Array.from({ length: 72 }, (_, i) => {
        const a = (i / 72) * Math.PI * 2;
        return { x: center.x + Math.cos(a) * r, y: center.y + Math.sin(a) * r };
      });
    } else if (shape === "triangle") {
      pts = Array.from({ length: 3 }, (_, i) => {
        const a = -Math.PI / 2 + (i / 3) * Math.PI * 2;
        return { x: center.x + Math.cos(a) * r, y: center.y + Math.sin(a) * r };
      });
    } else {
      pts = [
        { x: center.x - r, y: center.y - r },
        { x: center.x + r, y: center.y - r },
        { x: center.x + r, y: center.y + r },
        { x: center.x - r, y: center.y + r },
      ];
    }
    pushUndo();
    setContours((cur) => cur && { ...cur, inner: [...cur.inner, pts] });
  };

  const finishPolyline = () => {
    if (polyDraft.length < 2) return;
    pushUndo();
    setContours((cur) => cur && { ...cur, polylines: [...(cur.polylines ?? []), polyDraft] });
    setPolyDraft([]);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button === 2) return;
    (e.target as Element).setPointerCapture(e.pointerId);
    const p = toImage(e);

    if (tool === "delete") {
      deleteNearestPoint(p);
      return;
    }
    if (tool === "scissors") {
      cutNearestSegment(p);
      return;
    }
    if (tool === "move") {
      if (!contours) return;
      pushUndo();
      dragRef.current = { kind: "move-all", start: p, contours: clone(contours) };
      setSelectedPoints(new Set());
      return;
    }
    if (tool === "rotate") {
      const nextPivot = snapPt(p);
      setPivot(nextPivot);
      return;
    }
    if (tool === "circle" || tool === "triangle" || tool === "square") {
      addShape(tool, snapPt(p));
      return;
    }
    if (tool === "polyline") {
      setPolyDraft((draft) => [...draft, snapPt(p)]);
      return;
    }

    const hit = hitPoint(p);
    if (hit) {
      toggleSelectedPoint(hit.ci, hit.pi);
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
    } else if (drag.kind === "move-all") {
      const p = toImage(e);
      setContours(translateContourSet(drag.contours, p.x - drag.start.x, p.y - drag.start.y));
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
    if (tool === "polyline") {
      finishPolyline();
      return;
    }
    if (tool !== "select") return;
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
    deleteNearestPoint(toImage(e));
  };

  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    setView((v) => {
      const scale = Math.min(40, Math.max(0.05, v.scale * factor));
      const k = scale / v.scale;
      return { scale, tx: mx - (mx - v.tx) * k, ty: my - (my - v.ty) * k };
    });
  };

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
  const shapeUnit = record.calibration ? "мм" : "px";

  return (
    <div className="mx-auto max-w-[1760px]">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold">{t.editorTitle}</h1>
          <p className="readout text-xs text-ink/50 dark:text-paper/50">
            {record.name} · {polys.reduce((s, p) => s + p.length, 0)} точки · избрани {selectedCount}
          </p>
        </div>
        <button className="btn-primary" onClick={save}>
          <Icon name="save" /> Запази
        </button>
      </div>

      <div className="mb-3 grid gap-3 xl:grid-cols-[1fr_340px]">
        <div className="panel flex flex-wrap gap-2 p-3">
          <ToolButton active={tool === "select"} icon="cursor" label="Избор" onClick={() => setTool("select")} />
          <ToolButton active={tool === "move"} icon="move" label="Премести" onClick={() => setTool("move")} />
          <ToolButton active={tool === "rotate"} icon="rotate" label="Завърти" onClick={() => setTool("rotate")} />
          <ToolButton active={tool === "delete"} icon="trash" label="Изтриване" onClick={() => setTool("delete")} />
          <ToolButton active={tool === "scissors"} icon="scissors" label="Ножица" onClick={() => setTool("scissors")} />
          <ToolButton active={tool === "circle"} icon="circle" label="Кръг" onClick={() => setTool("circle")} />
          <ToolButton active={tool === "triangle"} icon="triangle" label="Триъгълник" onClick={() => setTool("triangle")} />
          <ToolButton active={tool === "square"} icon="square" label="Квадрат" onClick={() => setTool("square")} />
          <ToolButton active={tool === "polyline"} icon="polyline" label="Полилиния" onClick={() => setTool("polyline")} />
          <ToolButton icon="smooth" label="Изглади" onClick={() => applyAll((p) => chaikin(p, settings.smoothing))} />
          <ToolButton icon="simplify" label="Опрости" onClick={() => applyAll((p) => simplify(p, 2))} />
          <ToolButton icon="undo" label="Назад" disabled={!undoStack.length} onClick={undo} />
          <ToolButton icon="redo" label="Напред" disabled={!redoStack.length} onClick={redo} />
          <ToolButton active={grid} icon="grid" label="Мрежа" onClick={() => setGrid(!grid)} />
          <ToolButton active={snap} icon="magnet" label="Прилепване" onClick={() => setSnap(!snap)} />
          <ToolButton icon="fit" label="Центрирай" onClick={() => fitView(record)} />
        </div>

        <ToolOptions
          tool={tool}
          diameter={shapeDiameter}
          unit={shapeUnit}
          selectedCount={selectedCount}
          polyCount={polyDraft.length}
          moveDx={moveDx}
          moveDy={moveDy}
          pivot={pivot ?? contourCenter(contours)}
          usePivotCoordinates={usePivotCoordinates}
          rotationType={rotationType}
          rotationAngle={rotationAngle}
          onDiameter={setShapeDiameter}
          onMoveDx={setMoveDx}
          onMoveDy={setMoveDy}
          onApplyMove={applyMove}
          onPivot={setPivot}
          onUsePivotCoordinates={setUsePivotCoordinates}
          onRotationType={setRotationType}
          onRotationAngle={setRotationAngle}
          onApplyRotation={applyRotation}
          onDeleteSelected={deleteSelectedPoints}
          onFinishPolyline={finishPolyline}
          onClearPolyline={() => setPolyDraft([])}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0">
          <div
            ref={wrapRef}
            className="panel graticule relative h-[78vh] min-h-[620px] touch-none overflow-hidden p-0"
          >
            <canvas
              ref={canvasRef}
              className="block h-full w-full cursor-crosshair"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onDoubleClick={onDoubleClick}
              onContextMenu={onContextMenu}
              onWheel={onWheel}
            />
          </div>
          <p className="mt-2 text-xs text-ink/50 dark:text-paper/50">
            Избор: клик върху точка. Много точки: кликай последователно. Двоен клик върху сегмент добавя точка. Десен бутон трие точка. Скрол: zoom. Влачене на празно място: местене.
          </p>
        </div>

        <div className="space-y-3">
          <MeasurementsPanel m={liveMeasurements} calibration={record.calibration} />
          <ExportButtons record={liveRecord} />
        </div>
      </div>
    </div>
  );
}

function ToolOptions({
  tool,
  diameter,
  unit,
  selectedCount,
  polyCount,
  moveDx,
  moveDy,
  pivot,
  usePivotCoordinates,
  rotationType,
  rotationAngle,
  onDiameter,
  onMoveDx,
  onMoveDy,
  onApplyMove,
  onPivot,
  onUsePivotCoordinates,
  onRotationType,
  onRotationAngle,
  onApplyRotation,
  onDeleteSelected,
  onFinishPolyline,
  onClearPolyline,
}: {
  tool: ToolMode;
  diameter: number;
  unit: string;
  selectedCount: number;
  polyCount: number;
  moveDx: number;
  moveDy: number;
  pivot: Pt;
  usePivotCoordinates: boolean;
  rotationType: "absolute" | "relative";
  rotationAngle: number;
  onDiameter: (value: number) => void;
  onMoveDx: (value: number) => void;
  onMoveDy: (value: number) => void;
  onApplyMove: () => void;
  onPivot: (value: Pt) => void;
  onUsePivotCoordinates: (value: boolean) => void;
  onRotationType: (value: "absolute" | "relative") => void;
  onRotationAngle: (value: number) => void;
  onApplyRotation: () => void;
  onDeleteSelected: () => void;
  onFinishPolyline: () => void;
  onClearPolyline: () => void;
}) {
  const radius = diameter / 2;
  return (
    <section className="panel p-3">
      <h2 className="mb-2 font-display text-sm font-bold uppercase tracking-wider text-ink/60 dark:text-paper/60">
        Настройки на инструмента
      </h2>

      {tool === "select" && (
        <div className="space-y-2">
          <p className="text-sm text-ink/65 dark:text-paper/65">Избрани точки: {selectedCount}</p>
          <button className="btn-ghost w-full" disabled={!selectedCount} onClick={onDeleteSelected}>
            <Icon name="trash" /> Изтрий избраните точки
          </button>
        </div>
      )}

      {tool === "move" && (
        <div className="space-y-3">
          <p className="text-sm text-ink/65 dark:text-paper/65">
            Влачи върху чертежа за свободно местене или въведи точна стойност.
          </p>
          <div className="grid grid-cols-2 gap-2">
            <label className="block text-xs text-ink/60 dark:text-paper/60">
              X ({unit})
              <input
                className="field readout mt-1"
                type="number"
                step={0.1}
                value={moveDx}
                onChange={(e) => onMoveDx(parseFloat(e.target.value) || 0)}
              />
            </label>
            <label className="block text-xs text-ink/60 dark:text-paper/60">
              Y ({unit})
              <input
                className="field readout mt-1"
                type="number"
                step={0.1}
                value={moveDy}
                onChange={(e) => onMoveDy(parseFloat(e.target.value) || 0)}
              />
            </label>
          </div>
          <button className="btn-primary w-full" onClick={onApplyMove}>
            <Icon name="move" /> Приложи преместване
          </button>
        </div>
      )}

      {tool === "rotate" && (
        <div className="space-y-3">
          <p className="text-sm text-ink/65 dark:text-paper/65">
            Кликни върху чертежа, за да зададеш център на въртене, или въведи координати.
          </p>
          <label className="inline-flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={usePivotCoordinates}
              onChange={(e) => onUsePivotCoordinates(e.target.checked)}
            />
            Използвай координати
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="block text-xs text-ink/60 dark:text-paper/60">
              X
              <input
                className="field readout mt-1"
                type="number"
                step={0.1}
                disabled={!usePivotCoordinates}
                value={Number.isFinite(pivot.x) ? Number(pivot.x.toFixed(3)) : 0}
                onChange={(e) => onPivot({ ...pivot, x: parseFloat(e.target.value) || 0 })}
              />
            </label>
            <label className="block text-xs text-ink/60 dark:text-paper/60">
              Y
              <input
                className="field readout mt-1"
                type="number"
                step={0.1}
                disabled={!usePivotCoordinates}
                value={Number.isFinite(pivot.y) ? Number(pivot.y.toFixed(3)) : 0}
                onChange={(e) => onPivot({ ...pivot, y: parseFloat(e.target.value) || 0 })}
              />
            </label>
          </div>
          <div className="space-y-2 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="radio"
                checked={rotationType === "absolute"}
                onChange={() => onRotationType("absolute")}
              />
              Абсолютно
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                checked={rotationType === "relative"}
                onChange={() => onRotationType("relative")}
              />
              Относително
            </label>
          </div>
          <label className="block text-xs text-ink/60 dark:text-paper/60">
            Ъгъл
            <input
              className="field readout mt-1"
              type="number"
              step={0.1}
              value={rotationAngle}
              onChange={(e) => onRotationAngle(parseFloat(e.target.value) || 0)}
            />
          </label>
          <button className="btn-primary w-full" onClick={onApplyRotation}>
            <Icon name="rotate" /> Приложи въртене
          </button>
        </div>
      )}

      {tool === "delete" && <p className="text-sm text-ink/65 dark:text-paper/65">Клик върху точка я изтрива веднага.</p>}

      {tool === "scissors" && (
        <p className="text-sm text-ink/65 dark:text-paper/65">Клик върху сегмент го реже и го превръща в зелена отворена линия.</p>
      )}

      {(tool === "circle" || tool === "triangle" || tool === "square") && (
        <div className="space-y-3">
          <label className="block text-xs text-ink/60 dark:text-paper/60">Диаметър</label>
          <input
            className="field readout"
            type="number"
            min={1}
            step={0.5}
            value={diameter}
            onChange={(e) => onDiameter(Math.max(1, parseFloat(e.target.value) || 1))}
          />
          <div className="grid grid-cols-2 gap-2 text-sm">
            <div className="rounded-lg border border-paper-3 p-2 dark:border-ink-3">
              <span className="block text-xs text-ink/50 dark:text-paper/50">Диаметър</span>
              <strong className="readout">{diameter.toFixed(2)} {unit}</strong>
            </div>
            <div className="rounded-lg border border-paper-3 p-2 dark:border-ink-3">
              <span className="block text-xs text-ink/50 dark:text-paper/50">Радиус</span>
              <strong className="readout">{radius.toFixed(2)} {unit}</strong>
            </div>
          </div>
          <p className="text-xs text-ink/50 dark:text-paper/50">Клик върху чертежа поставя фигурата.</p>
        </div>
      )}

      {tool === "polyline" && (
        <div className="space-y-2">
          <p className="text-sm text-ink/65 dark:text-paper/65">Поставени точки: {polyCount}</p>
          <button className="btn-primary w-full" disabled={polyCount < 2} onClick={onFinishPolyline}>
            <Icon name="save" /> Завърши линията
          </button>
          <button className="btn-ghost w-full" disabled={!polyCount} onClick={onClearPolyline}>
            <Icon name="trash" /> Изчисти временната линия
          </button>
        </div>
      )}
    </section>
  );
}

function ToolButton({
  icon,
  label,
  active,
  disabled,
  onClick,
}: {
  icon: IconName;
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={`inline-flex min-h-11 items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        active
          ? "border-dye bg-dye text-white dark:border-dye-bright dark:bg-dye-bright dark:text-ink"
          : "border-paper-3 bg-paper-2 hover:bg-ink/5 dark:border-ink-3 dark:bg-ink-2 dark:hover:bg-paper/5"
      }`}
      disabled={disabled}
      onClick={onClick}
      title={label}
    >
      <Icon name={icon} />
      <span>{label}</span>
    </button>
  );
}

type IconName =
  | "cursor"
  | "move"
  | "rotate"
  | "trash"
  | "scissors"
  | "circle"
  | "triangle"
  | "square"
  | "polyline"
  | "smooth"
  | "simplify"
  | "undo"
  | "redo"
  | "grid"
  | "magnet"
  | "fit"
  | "save";

function Icon({ name }: { name: IconName }) {
  const common = {
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0" aria-hidden>
      {name === "cursor" && <path {...common} d="M5 3l13 8-6 2-3 6L5 3z" />}
      {name === "move" && <path {...common} d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3" />}
      {name === "rotate" && <path {...common} d="M20 11a8 8 0 1 1-2.3-5.6M20 4v7h-7" />}
      {name === "trash" && <path {...common} d="M4 7h16M10 11v6M14 11v6M6 7l1 14h10l1-14M9 7V4h6v3" />}
      {name === "scissors" && <path {...common} d="M4 5l16 14M4 19l6-6M14 9l6-6M6 7a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM6 21a2 2 0 1 0 0-4 2 2 0 0 0 0 4z" />}
      {name === "circle" && <circle {...common} cx="12" cy="12" r="7" />}
      {name === "triangle" && <path {...common} d="M12 4l8 15H4L12 4z" />}
      {name === "square" && <rect {...common} x="5" y="5" width="14" height="14" rx="1" />}
      {name === "polyline" && <path {...common} d="M4 17l5-8 5 5 6-9" />}
      {name === "smooth" && <path {...common} d="M4 15c4-8 8 8 16-2" />}
      {name === "simplify" && <path {...common} d="M4 18L10 6l4 8 6-8" />}
      {name === "undo" && <path {...common} d="M9 7H4v5M5 12a8 8 0 1 0 2-5" />}
      {name === "redo" && <path {...common} d="M15 7h5v5M19 12a8 8 0 1 1-2-5" />}
      {name === "grid" && <path {...common} d="M4 4h16v16H4zM4 10h16M4 16h16M10 4v16M16 4v16" />}
      {name === "magnet" && <path {...common} d="M7 4v7a5 5 0 0 0 10 0V4M7 4h4M13 4h4M7 9h4M13 9h4" />}
      {name === "fit" && <path {...common} d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />}
      {name === "save" && <path {...common} d="M5 4h12l2 2v14H5zM8 4v6h8M8 20v-6h8v6" />}
    </svg>
  );
}
