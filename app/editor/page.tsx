"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useApp } from "@/lib/store";
import { getCurrent, setCurrent } from "@/lib/current";
import { scanDB } from "@/lib/db";
import {
  chaikin,
  chamferCorner,
  despike,
  filletCorner,
  measure,
  minAreaRect,
  nearestSegment,
  offsetPolygon,
  pointToSegment,
  polygonArea,
  resampleClosed,
  scaleAround,
  simplify,
  smoothIndices,
  straighten,
} from "@/lib/geometry";
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
  | { kind: "drag-selected"; last: Pt; selection: Set<string> }
  | { kind: "marquee"; additive: boolean }
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
  // Repair & transform parameters (mm when calibrated, px otherwise)
  const [cornerRadius, setCornerRadius] = useState(3);
  const [resampleStep, setResampleStep] = useState(2);
  const [offsetMm, setOffsetMm] = useState(0.5);
  const [scaleMode, setScaleMode] = useState<"percent" | "width">("percent");
  const [scalePct, setScalePct] = useState(100);
  const [scaleTargetWidth, setScaleTargetWidth] = useState(100);
  const [smoothStrength, setSmoothStrength] = useState(settings.smoothing);
  const [simplifyEps, setSimplifyEps] = useState(2);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const pageRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const dragRef = useRef<DragState>(null);
  const [marquee, setMarquee] = useState<{ a: Pt; b: Pt } | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

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

  /* ------------------------------ fullscreen ------------------------------ */

  const toggleFullscreen = useCallback(() => {
    if (typeof document === "undefined") return;
    if (!document.fullscreenElement) {
      pageRef.current?.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  }, []);

  useEffect(() => {
    const onChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
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

    // Селекционен правоъгълник (marquee)
    if (marquee) {
      const x = Math.min(marquee.a.x, marquee.b.x);
      const y = Math.min(marquee.a.y, marquee.b.y);
      const w = Math.abs(marquee.b.x - marquee.a.x);
      const h = Math.abs(marquee.b.y - marquee.a.y);
      ctx.fillStyle = "rgba(76,141,255,0.12)";
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = "#4c8dff";
      ctx.lineWidth = 1.5 / view.scale;
      ctx.setLineDash([6 / view.scale, 4 / view.scale]);
      ctx.strokeRect(x, y, w, h);
      ctx.setLineDash([]);
    }

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
  }, [record, contours, polys, openLines, polyDraft, selectedPoints, marquee, view, grid, gridStep, tool, pivot]);

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
  const deleteSelectedRef = useRef(deleteSelectedPoints);
  deleteSelectedRef.current = deleteSelectedPoints;

  // Delete / Backspace изтрива избраните точки (освен когато пишеш в поле).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      const el = document.activeElement;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT"))
        return;
      e.preventDefault();
      deleteSelectedRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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

  /** Ножица: клик върху линия я изтрива директно (без зелени отворени фигури). */
  const deleteNearestLine = (p: Pt) => {
    const tol = 18 / view.scale;
    let best: { type: "poly" | "line"; idx: number; dist: number } = {
      type: "poly",
      idx: -1,
      dist: Infinity,
    };
    // Затворени контури (външен + дупки)
    polys.forEach((poly, ci) => {
      const seg = nearestSegment(poly, p);
      if (seg.dist < best.dist) best = { type: "poly", idx: ci, dist: seg.dist };
    });
    // Отворени полилинии (сегменти без затваряне)
    openLines.forEach((line, li) => {
      for (let i = 0; i < line.length - 1; i++) {
        const d = pointToSegment(p, line[i], line[i + 1]);
        if (d < best.dist) best = { type: "line", idx: li, dist: d };
      }
    });
    if (best.idx === -1 || best.dist > tol) return;

    if (best.type === "line") {
      pushUndo();
      setContours(
        (cur) =>
          cur && { ...cur, polylines: (cur.polylines ?? []).filter((_, i) => i !== best.idx) }
      );
      setSelectedPoints(new Set());
      toast("Линията е изтрита");
      return;
    }

    if (best.idx === 0) {
      // Външният контур: заменяме го с най-голямата вътрешна фигура, ако има такава.
      if (!contours || contours.inner.length === 0) {
        toast("Външният контур не може да се изтрие — той е основната фигура", "err");
        return;
      }
      pushUndo();
      const areas = contours.inner.map((h) => polygonArea(h));
      const li = areas.indexOf(Math.max(...areas));
      setContours({
        ...contours,
        outer: contours.inner[li],
        inner: contours.inner.filter((_, i) => i !== li),
      });
      setSelectedPoints(new Set());
      toast("Външният контур е изтрит — най-голямата фигура стана основна");
      return;
    }

    pushUndo();
    setContours((cur) => cur && { ...cur, inner: cur.inner.filter((_, i) => i !== best.idx - 1) });
    setSelectedPoints(new Set());
    toast("Контурът е изтрит");
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

    // Middle mouse button always pans, in every tool.
    if (e.button === 1) {
      e.preventDefault();
      dragRef.current = {
        kind: "pan",
        startX: e.clientX,
        startY: e.clientY,
        startTx: view.tx,
        startTy: view.ty,
      };
      return;
    }

    if (tool === "delete") {
      deleteNearestPoint(p);
      return;
    }
    if (tool === "scissors") {
      deleteNearestLine(p);
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

    // --- select tool ---
    const hit = hitPoint(p);
    if (hit) {
      const key = pointKey(hit.ci, hit.pi);
      let sel = selectedPoints;
      if (e.shiftKey) {
        // Shift+клик добавя/маха от селекцията.
        sel = new Set(selectedPoints);
        if (sel.has(key)) sel.delete(key);
        else sel.add(key);
        setSelectedPoints(sel);
        return; // shift-click only edits the selection, no drag
      }
      if (!selectedPoints.has(key)) {
        sel = new Set([key]);
        setSelectedPoints(sel);
      }
      // Drag: точката (или цялата селекция, ако е част от нея) се мести заедно.
      pushUndo();
      dragRef.current = { kind: "drag-selected", last: p, selection: sel };
    } else {
      // Празно място: рисуваме правоъгълник за селекция (marquee).
      dragRef.current = { kind: "marquee", additive: e.shiftKey };
      setMarquee({ a: p, b: p });
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
    } else if (drag.kind === "marquee") {
      const p = toImage(e);
      setMarquee((m) => (m ? { a: m.a, b: p } : m));
    } else if (drag.kind === "drag-selected") {
      const p = toImage(e);
      if (drag.selection.size === 1) {
        // Единична точка: прилепва към мрежата при включен snap.
        const key = [...drag.selection][0];
        const [ci, pi] = key.split(":").map(Number);
        const target = snapPt(p);
        setPolys(
          polys.map((poly, i) =>
            i === ci ? poly.map((q, j) => (j === pi ? target : q)) : poly
          )
        );
      } else {
        // Групово местене: всички избрани точки се движат с делтата.
        const dx = p.x - drag.last.x;
        const dy = p.y - drag.last.y;
        setPolys(
          polys.map((poly, ci) =>
            poly.map((q, pi) =>
              drag.selection.has(pointKey(ci, pi)) ? { x: q.x + dx, y: q.y + dy } : q
            )
          )
        );
      }
      drag.last = p;
    }
  };

  const onPointerUp = () => {
    const drag = dragRef.current;
    if (drag?.kind === "marquee") {
      setMarquee((m) => {
        if (m) {
          const minX = Math.min(m.a.x, m.b.x);
          const maxX = Math.max(m.a.x, m.b.x);
          const minY = Math.min(m.a.y, m.b.y);
          const maxY = Math.max(m.a.y, m.b.y);
          const moved = maxX - minX > 2 / view.scale || maxY - minY > 2 / view.scale;
          const next = drag.additive ? new Set(selectedPoints) : new Set<string>();
          if (moved) {
            polys.forEach((poly, ci) =>
              poly.forEach((q, pi) => {
                if (q.x >= minX && q.x <= maxX && q.y >= minY && q.y <= maxY)
                  next.add(pointKey(ci, pi));
              })
            );
          }
          setSelectedPoints(next);
        }
        return null;
      });
    }
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

  /* ------------------------- repair & transform ops ------------------------- */

  /** Selected point indices grouped per contour index. */
  const selectedByContour = (): Map<number, number[]> => {
    const map = new Map<number, number[]>();
    for (const key of selectedPoints) {
      const [ci, pi] = key.split(":").map(Number);
      if (!map.has(ci)) map.set(ci, []);
      map.get(ci)!.push(pi);
    }
    return map;
  };

  const selectAllPoints = () => {
    const next = new Set<string>();
    polys.forEach((poly, ci) => poly.forEach((_, pi) => next.add(pointKey(ci, pi))));
    setSelectedPoints(next);
  };

  const selectWholeContour = () => {
    // Expand: every contour that has at least one selected point gets fully selected.
    const map = selectedByContour();
    if (!map.size) return toast("Първо избери точка от контур", "err");
    const next = new Set(selectedPoints);
    for (const ci of map.keys()) polys[ci]?.forEach((_, pi) => next.add(pointKey(ci, pi)));
    setSelectedPoints(next);
  };

  const deleteWholeContour = () => {
    const map = selectedByContour();
    if (!map.size) return toast("Първо избери точка от контура", "err");
    if (map.has(0) && map.size === 1)
      return toast("Външният контур не може да се изтрие", "err");
    pushUndo();
    const drop = new Set([...map.keys()].filter((ci) => ci !== 0));
    const next = polys.filter((_, ci) => !drop.has(ci));
    setPolys(next);
    toast("Контурът е изтрит");
  };

  const straightenSelected = () => {
    const map = selectedByContour();
    const entry = [...map.entries()].find(([, idx]) => idx.length >= 3);
    if (!entry) return toast("Избери поне 3 точки от един контур", "err");
    pushUndo();
    const [ci, idx] = entry;
    setPolys(polys.map((poly, i) => (i === ci ? straighten(poly, idx) : poly)));
    toast("Участъкът е изправен");
  };

  const smoothSelected = () => {
    const map = selectedByContour();
    if (!map.size) return toast("Избери точки за изглаждане", "err");
    pushUndo();
    setPolys(
      polys.map((poly, ci) => {
        const idx = map.get(ci);
        return idx ? smoothIndices(poly, new Set(idx), 0.6) : poly;
      })
    );
    toast("Избраното е изгладено");
  };

  const filletSelected = () => {
    const map = selectedByContour();
    if (!map.size) return toast("Избери ъгли за закръгляне", "err");
    const r = distanceToPx(cornerRadius);
    pushUndo();
    setPolys(
      polys.map((poly, ci) => {
        const idx = map.get(ci);
        if (!idx) return poly;
        let out = poly;
        // Descending order keeps earlier indices valid while the array grows.
        for (const pi of [...idx].sort((a, b) => b - a)) out = filletCorner(out, pi, r);
        return out;
      })
    );
    setSelectedPoints(new Set());
    toast(`Закръглени ъгли: R ${cornerRadius} ${shapeUnitLabel()}`);
  };

  const chamferSelected = () => {
    const map = selectedByContour();
    if (!map.size) return toast("Избери ъгли за фаска", "err");
    const d = distanceToPx(cornerRadius);
    pushUndo();
    setPolys(
      polys.map((poly, ci) => {
        const idx = map.get(ci);
        if (!idx) return poly;
        let out = poly;
        for (const pi of [...idx].sort((a, b) => b - a)) out = chamferCorner(out, pi, d);
        return out;
      })
    );
    setSelectedPoints(new Set());
    toast(`Фаска: ${cornerRadius} ${shapeUnitLabel()}`);
  };

  const despikeAll = () => {
    pushUndo();
    setPolys(polys.map((p) => despike(p, 25)));
    setSelectedPoints(new Set());
    toast("Шиповете са премахнати");
  };

  const resampleAll = () => {
    const spacing = distanceToPx(resampleStep);
    if (spacing <= 0) return;
    pushUndo();
    setPolys(polys.map((p) => resampleClosed(p, spacing)));
    setSelectedPoints(new Set());
    toast(`Точките са преразпределени на ${resampleStep} ${shapeUnitLabel()}`);
  };

  const mirror = (axis: "x" | "y") => {
    if (!contours) return;
    pushUndo();
    const c = contourCenter(contours);
    setContours(
      mapContourSet(contours, (p) =>
        axis === "x" ? { x: 2 * c.x - p.x, y: p.y } : { x: p.x, y: 2 * c.y - p.y }
      )
    );
    toast(axis === "x" ? "Огледално по X" : "Огледално по Y");
  };

  const axisAlign = () => {
    if (!contours) return;
    const rect = minAreaRect(contours.outer);
    let angle = rect.angleDeg % 90;
    if (angle > 45) angle -= 90;
    if (angle < -45) angle += 90;
    if (Math.abs(angle) < 0.01) return toast("Контурът вече е изравнен");
    pushUndo();
    setContours(rotateContourSet(contours, contourCenter(contours), -angle));
    toast(`Изравнено (${(-angle).toFixed(2)}°)`);
  };

  const applyScale = () => {
    if (!contours) return;
    let factor = scalePct / 100;
    if (scaleMode === "width") {
      const m = measure(contours);
      const targetPx = distanceToPx(scaleTargetWidth);
      if (targetPx <= 0 || m.widthPx <= 0) return;
      factor = targetPx / m.widthPx;
    }
    if (!Number.isFinite(factor) || factor <= 0) return;
    pushUndo();
    const c = contourCenter(contours);
    setContours(mapContourSet(contours, (p) => scaleAround([p], c, factor)[0]));
    toast(`Мащаб ×${factor.toFixed(3)}`);
  };

  const applyOffset = () => {
    if (!contours) return;
    const d = distanceToPx(offsetMm);
    if (!d) return;
    pushUndo();
    // Kerf logic: outer grows outward, holes shrink inward for positive offset.
    setContours({
      ...contours,
      outer: offsetPolygon(contours.outer, d),
      inner: contours.inner.map((h) => offsetPolygon(h, -d)),
    });
    toast(`Офсет ${offsetMm > 0 ? "+" : ""}${offsetMm} ${shapeUnitLabel()}`);
  };

  const shapeUnitLabel = () => (record?.calibration ? "мм" : "px");


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
    <div
      ref={pageRef}
      className={`mx-auto max-w-[1760px] ${isFullscreen ? "h-screen overflow-y-auto bg-paper p-4 dark:bg-ink" : ""}`}
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold">{t.editorTitle}</h1>
          <p className="readout text-xs text-ink/50 dark:text-paper/50">
            {record.name} · {polys.reduce((s, p) => s + p.length, 0)} точки · избрани {selectedCount}
          </p>
        </div>
        <div className="flex gap-2">
          <button className="btn-ghost" onClick={toggleFullscreen}>
            <Icon name={isFullscreen ? "exitFullscreen" : "fullscreen"} />
            {isFullscreen ? "Изход от цял екран" : "Цял екран"}
          </button>
          <button className="btn-primary" onClick={save}>
            <Icon name="save" /> Запази
          </button>
        </div>
      </div>

      <div className="grid gap-3 xl:grid-cols-[104px_minmax(0,1fr)_340px]">
        {/* --- Лява лента с инструменти (стил VCarve) --- */}
        <div className="panel h-fit p-2 xl:sticky xl:top-3">
          <ToolGroup label="Режим">
            <IconTool active={tool === "select"} icon="cursor" label="Избор / маркиране" onClick={() => setTool("select")} />
            <IconTool active={tool === "move"} icon="move" label="Премести всичко" onClick={() => setTool("move")} />
            <IconTool active={tool === "rotate"} icon="rotate" label="Завърти" onClick={() => setTool("rotate")} />
            <IconTool active={tool === "delete"} icon="trash" label="Изтриване на точки" onClick={() => setTool("delete")} />
            <IconTool active={tool === "scissors"} icon="scissors" label="Ножица — клик върху линия я изтрива" onClick={() => setTool("scissors")} />
          </ToolGroup>
          <ToolGroup label="Фигури">
            <IconTool active={tool === "circle"} icon="circle" label="Кръг" onClick={() => setTool("circle")} />
            <IconTool active={tool === "triangle"} icon="triangle" label="Триъгълник" onClick={() => setTool("triangle")} />
            <IconTool active={tool === "square"} icon="square" label="Квадрат" onClick={() => setTool("square")} />
            <IconTool active={tool === "polyline"} icon="polyline" label="Полилиния" onClick={() => setTool("polyline")} />
          </ToolGroup>
          <ToolGroup label="Стъпки">
            <IconTool icon="undo" label="Назад (Undo)" disabled={!undoStack.length} onClick={undo} />
            <IconTool icon="redo" label="Напред (Redo)" disabled={!redoStack.length} onClick={redo} />
          </ToolGroup>
          <ToolGroup label="Изглед" last>
            <IconTool active={grid} icon="grid" label="Мрежа" onClick={() => setGrid(!grid)} />
            <IconTool active={snap} icon="magnet" label="Прилепване към мрежата" onClick={() => setSnap(!snap)} />
            <IconTool icon="fit" label="Центрирай изгледа" onClick={() => fitView(record)} />
            <IconTool
              active={isFullscreen}
              icon={isFullscreen ? "exitFullscreen" : "fullscreen"}
              label={isFullscreen ? "Изход от цял екран" : "Цял екран"}
              onClick={toggleFullscreen}
            />
          </ToolGroup>
        </div>
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
            Влачене на празно място: правоъгълник за маркиране на много точки (Shift добавя). Влачене на избрана точка мести цялата селекция. Delete трие избраните. Двоен клик върху сегмент добавя точка. Десен бутон трие точка. Скрол: zoom. Среден бутон: местене на изгледа.
          </p>
        </div>

        <div className="max-h-[85vh] space-y-3 overflow-y-auto pr-1">
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

          {/* --- Селекция --- */}
          <Section title="Селекция" hint={`Избрани точки: ${selectedCount}`}>
            <div className="grid grid-cols-2 gap-2">
              <button className="btn-ghost" onClick={selectAllPoints}>
                <Icon name="selectAll" /> Всички
              </button>
              <button className="btn-ghost" disabled={!selectedCount} onClick={() => setSelectedPoints(new Set())}>
                <Icon name="deselect" /> Изчисти
              </button>
              <button className="btn-ghost" disabled={!selectedCount} onClick={selectWholeContour}>
                <Icon name="contour" /> Цял контур
              </button>
              <button
                className="btn-ghost text-red-500 hover:bg-red-500/10"
                disabled={!selectedCount}
                onClick={deleteWholeContour}
              >
                <Icon name="trash" /> Изтрий контура
              </button>
            </div>
            <button className="btn-ghost mt-2 w-full" disabled={!selectedCount} onClick={deleteSelectedPoints}>
              <Icon name="trash" /> Изтрий избраните точки
            </button>
          </Section>

          {/* --- Поправка на контура --- */}
          <Section title="Поправка на контура" hint="Ъгловите операции работят върху избраните точки">
            <div className="grid grid-cols-2 gap-2">
              <button className="btn-ghost" disabled={selectedCount < 3} onClick={straightenSelected}>
                <Icon name="straighten" /> Изправи
              </button>
              <button className="btn-ghost" disabled={!selectedCount} onClick={smoothSelected}>
                <Icon name="smooth" /> Изглади избр.
              </button>
              <button className="btn-ghost" disabled={!selectedCount} onClick={filletSelected}>
                <Icon name="fillet" /> Закръгли ъгъл
              </button>
              <button className="btn-ghost" disabled={!selectedCount} onClick={chamferSelected}>
                <Icon name="chamfer" /> Фаска
              </button>
            </div>
            <NumberRow
              label={`Радиус / фаска (${shapeUnit})`}
              value={cornerRadius}
              step={0.5}
              min={0.1}
              onChange={setCornerRadius}
            />
            <div className="my-2 h-px bg-paper-3 dark:bg-ink-3" aria-hidden />
            <div className="grid grid-cols-2 gap-2">
              <button className="btn-ghost" onClick={despikeAll}>
                <Icon name="despike" /> Махни шипове
              </button>
              <button className="btn-ghost" onClick={resampleAll}>
                <Icon name="resample" /> Преразпредели
              </button>
            </div>
            <NumberRow
              label={`Стъпка между точки (${shapeUnit})`}
              value={resampleStep}
              step={0.5}
              min={0.2}
              onChange={setResampleStep}
            />
            <div className="my-2 h-px bg-paper-3 dark:bg-ink-3" aria-hidden />
            <div className="grid grid-cols-2 gap-2">
              <button
                className="btn-ghost"
                onClick={() => {
                  applyAll((p) => chaikin(p, smoothStrength));
                  toast("Контурът е изгладен");
                }}
              >
                <Icon name="smooth" /> Изглади всичко
              </button>
              <button
                className="btn-ghost"
                onClick={() => {
                  applyAll((p) => simplify(p, simplifyEps));
                  toast("Контурът е опростен");
                }}
              >
                <Icon name="simplify" /> Опрости
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <NumberRow label="Сила ×" value={smoothStrength} step={1} min={1} max={4} onChange={(v) => setSmoothStrength(Math.round(v))} />
              <NumberRow label="Допуск (px)" value={simplifyEps} step={0.5} min={0.5} onChange={setSimplifyEps} />
            </div>
          </Section>

          {/* --- Трансформации --- */}
          <Section title="Трансформации" hint="Прилагат се върху целия чертеж">
            <div className="grid grid-cols-3 gap-2">
              <button className="btn-ghost" onClick={() => mirror("x")}>
                <Icon name="mirrorX" /> Огл. X
              </button>
              <button className="btn-ghost" onClick={() => mirror("y")}>
                <Icon name="mirrorY" /> Огл. Y
              </button>
              <button className="btn-ghost" onClick={axisAlign}>
                <Icon name="align" /> Изравни
              </button>
            </div>

            <div className="my-2 h-px bg-paper-3 dark:bg-ink-3" aria-hidden />
            <p className="mb-1 text-xs font-medium text-ink/60 dark:text-paper/60">Мащаб</p>
            <div className="mb-2 flex gap-3 text-sm">
              <label className="flex items-center gap-1.5">
                <input type="radio" checked={scaleMode === "percent"} onChange={() => setScaleMode("percent")} />
                Процент
              </label>
              <label className="flex items-center gap-1.5">
                <input type="radio" checked={scaleMode === "width"} onChange={() => setScaleMode("width")} />
                До ширина
              </label>
            </div>
            {scaleMode === "percent" ? (
              <NumberRow label="Мащаб (%)" value={scalePct} step={1} min={1} onChange={setScalePct} />
            ) : (
              <NumberRow label={`Целева ширина (${shapeUnit})`} value={scaleTargetWidth} step={1} min={0.1} onChange={setScaleTargetWidth} />
            )}
            <button className="btn-primary mt-1 w-full" onClick={applyScale}>
              <Icon name="scale" /> Приложи мащаб
            </button>

            <div className="my-2 h-px bg-paper-3 dark:bg-ink-3" aria-hidden />
            <p className="mb-1 text-xs font-medium text-ink/60 dark:text-paper/60">
              Офсет / kerf компенсация
            </p>
            <p className="mb-2 text-xs text-ink/50 dark:text-paper/50">
              + разширява навън (дупките се свиват), − свива навътре. Компенсира дебелината на ножа/лазера.
            </p>
            <NumberRow label={`Офсет (${shapeUnit})`} value={offsetMm} step={0.1} onChange={setOffsetMm} />
            <button className="btn-primary mt-1 w-full" onClick={applyOffset}>
              <Icon name="offset" /> Приложи офсет
            </button>
          </Section>

          <MeasurementsPanel m={liveMeasurements} calibration={record.calibration} />
          <ExportButtons record={liveRecord} />
        </div>
      </div>
    </div>
  );
}

/** Collapsible-feeling grouped panel with a header and optional hint. */
function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="panel p-3">
      <h2 className="font-display text-sm font-bold uppercase tracking-wider text-ink/60 dark:text-paper/60">
        {title}
      </h2>
      {hint && <p className="mb-2 mt-0.5 text-xs text-ink/45 dark:text-paper/45">{hint}</p>}
      {!hint && <div className="mb-2" />}
      {children}
    </section>
  );
}

/** Compact labelled number input. */
function NumberRow({
  label,
  value,
  step,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  step: number;
  min?: number;
  max?: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="block text-xs text-ink/60 dark:text-paper/60">
      {label}
      <input
        className="field readout mt-1"
        type="number"
        step={step}
        min={min}
        max={max}
        value={value}
        onChange={(e) => {
          const v = parseFloat(e.target.value);
          if (Number.isFinite(v)) onChange(min !== undefined ? Math.max(min, v) : v);
        }}
      />
    </label>
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
        <p className="text-sm text-ink/65 dark:text-paper/65">Клик върху линия я изтрива директно: дупка, фигура или полилиния се маха цялата. Външният контур се пази (заменя се с най-голямата фигура, ако има такава).</p>
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

/** Vertical toolbar group with a tiny caption (VCarve-style). */
function ToolGroup({
  label,
  last,
  children,
}: {
  label: string;
  last?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={last ? "" : "mb-2 border-b border-paper-3 pb-2 dark:border-ink-3"}>
      <p className="mb-1.5 px-1 font-mono text-[10px] uppercase tracking-wider text-ink/45 dark:text-paper/45">
        {label}
      </p>
      <div className="grid grid-cols-2 gap-1.5">{children}</div>
    </div>
  );
}

/** Compact icon-only tool button with a tooltip. */
function IconTool({
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
      className={`flex h-10 items-center justify-center rounded-lg border transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        active
          ? "border-dye bg-dye text-white dark:border-dye-bright dark:bg-dye-bright dark:text-ink"
          : "border-paper-3 bg-paper-2 hover:bg-ink/5 dark:border-ink-3 dark:bg-ink-2 dark:hover:bg-paper/5"
      }`}
      disabled={disabled}
      onClick={onClick}
      title={label}
      aria-label={label}
    >
      <Icon name={icon} />
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
  | "save"
  | "selectAll"
  | "deselect"
  | "contour"
  | "straighten"
  | "fillet"
  | "chamfer"
  | "despike"
  | "resample"
  | "mirrorX"
  | "mirrorY"
  | "align"
  | "scale"
  | "offset"
  | "fullscreen"
  | "exitFullscreen";

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
      {name === "selectAll" && (
        <>
          <rect {...common} x="4" y="4" width="16" height="16" rx="2" strokeDasharray="3 3" />
          <path {...common} d="M9 12l2 2 4-4" />
        </>
      )}
      {name === "deselect" && (
        <>
          <rect {...common} x="4" y="4" width="16" height="16" rx="2" strokeDasharray="3 3" />
          <path {...common} d="M9 9l6 6M15 9l-6 6" />
        </>
      )}
      {name === "contour" && (
        <>
          <path {...common} d="M6 5 Q4 5 5 8 L7 17 Q7.5 19.5 10 19 L18 17 Q20 16.5 19.5 14 L18 6 Q17.5 4 15 4.5 Z" />
          <circle cx="6" cy="5" r="1.6" fill="currentColor" stroke="none" />
          <circle cx="18" cy="6" r="1.6" fill="currentColor" stroke="none" />
          <circle cx="10" cy="19" r="1.6" fill="currentColor" stroke="none" />
        </>
      )}
      {name === "straighten" && (
        <>
          <path {...common} d="M4 16 C8 8 16 8 20 16" opacity="0.35" />
          <path {...common} d="M4 12h16" />
          <circle cx="4" cy="12" r="1.7" fill="currentColor" stroke="none" />
          <circle cx="20" cy="12" r="1.7" fill="currentColor" stroke="none" />
        </>
      )}
      {name === "fillet" && <path {...common} d="M4 20V10 Q4 4 10 4h10M4 20h0" strokeDasharray="0" />}
      {name === "chamfer" && <path {...common} d="M4 20V11l7-7h9" />}
      {name === "despike" && (
        <>
          <path {...common} d="M4 16l4-2 2-9 2 9 8-2" opacity="0.35" />
          <path {...common} d="M4 16l6-2 10-2" />
        </>
      )}
      {name === "resample" && (
        <>
          <path {...common} d="M4 12h16" />
          {[4, 9.33, 14.66, 20].map((x) => (
            <circle key={x} cx={x} cy="12" r="1.6" fill="currentColor" stroke="none" />
          ))}
        </>
      )}
      {name === "mirrorX" && (
        <>
          <path {...common} d="M12 3v18" strokeDasharray="3 3" />
          <path {...common} d="M8 8 4 12l4 4M16 8l4 4-4 4" />
        </>
      )}
      {name === "mirrorY" && (
        <>
          <path {...common} d="M3 12h18" strokeDasharray="3 3" />
          <path {...common} d="M8 8l4-4 4 4M8 16l4 4 4-4" />
        </>
      )}
      {name === "align" && (
        <>
          <path {...common} d="M4 19h16" />
          <rect {...common} x="7" y="9" width="10" height="7" transform="rotate(-8 12 12)" />
        </>
      )}
      {name === "scale" && (
        <>
          <rect {...common} x="4" y="10" width="10" height="10" rx="1" />
          <path {...common} d="M14 10V4h6v6M14 10l6-6" />
        </>
      )}
      {name === "offset" && (
        <>
          <rect {...common} x="8" y="8" width="8" height="8" rx="1" />
          <rect {...common} x="4" y="4" width="16" height="16" rx="2" strokeDasharray="3 3" />
        </>
      )}
      {name === "fullscreen" && <path {...common} d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4" />}
      {name === "exitFullscreen" && <path {...common} d="M9 4v4a1 1 0 0 1-1 1H4M20 9h-4a1 1 0 0 1-1-1V4M15 20v-4a1 1 0 0 1 1-1h4M4 15h4a1 1 0 0 1 1 1v4" />}
    </svg>
  );
}
