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
  pointInPolygon,
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
  | "polyline"
  | "arc"
  | "arc"
  | "image";

type DragState =
  | { kind: "drag-selected"; last: Pt; selection: Set<string> }
  | { kind: "marquee"; additive: boolean }
  | { kind: "move-all"; start: Pt; contours: ContourSet }
  | { kind: "line-point"; li: number; pi: number }
  | { kind: "line-move"; li: number; last: Pt }
  | { kind: "bezier-handle"; li: number; pi: number; side: "prev" | "next" }
  | { kind: "draw-shape"; shape: "circle" | "triangle" | "square"; start: Pt }
  | { kind: "image-move"; start: Pt; startOff: { x: number; y: number } }
  | { kind: "pan"; startX: number; startY: number; startTx: number; startTy: number }
  | null;

const clone = (c: ContourSet): ContourSet => JSON.parse(JSON.stringify(c));
const pointKey = (ci: number, pi: number) => `${ci}:${pi}`;

const polyLength = (pts: Pt[], closed = false) => {
  let total = 0;
  for (let i = 0; i < pts.length - 1; i++) total += Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
  if (closed && pts.length > 2) total += Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y);
  return total;
};

const boundsOf = (sets: Pt[][]) => {
  const pts = sets.flat();
  return pts.reduce(
    (acc, p) => ({
      minX: Math.min(acc.minX, p.x),
      minY: Math.min(acc.minY, p.y),
      maxX: Math.max(acc.maxX, p.x),
      maxY: Math.max(acc.maxY, p.y),
    }),
    { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
  );
};

const arcFrom3Points = (a: Pt, b: Pt, c: Pt, steps = 48): Pt[] => {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < 1e-6) return [a, b, c];
  const ux =
    ((a.x * a.x + a.y * a.y) * (b.y - c.y) +
      (b.x * b.x + b.y * b.y) * (c.y - a.y) +
      (c.x * c.x + c.y * c.y) * (a.y - b.y)) /
    d;
  const uy =
    ((a.x * a.x + a.y * a.y) * (c.x - b.x) +
      (b.x * b.x + b.y * b.y) * (a.x - c.x) +
      (c.x * c.x + c.y * c.y) * (b.x - a.x)) /
    d;
  const center = { x: ux, y: uy };
  const radius = Math.hypot(a.x - ux, a.y - uy);
  const aa = Math.atan2(a.y - uy, a.x - ux);
  const ab = Math.atan2(b.y - uy, b.x - ux);
  const ac = Math.atan2(c.y - uy, c.x - ux);
  const norm = (v: number) => (v + Math.PI * 2) % (Math.PI * 2);
  const betweenCcw = (start: number, mid: number, end: number) => {
    const s = norm(start);
    const m = norm(mid);
    const e = norm(end);
    return s <= e ? m >= s && m <= e : m >= s || m <= e;
  };
  let end = ac;
  if (!betweenCcw(aa, ab, ac)) {
    if (end > aa) end -= Math.PI * 2;
  } else if (end < aa) {
    end += Math.PI * 2;
  }
  return Array.from({ length: steps + 1 }, (_, i) => {
    const t = i / steps;
    const ang = aa + (end - aa) * t;
    return { x: center.x + Math.cos(ang) * radius, y: center.y + Math.sin(ang) * radius };
  });
};

const bezierFrom3Points = (a: Pt, b: Pt, c: Pt, steps = 32): Pt[] =>
  Array.from({ length: steps + 1 }, (_, i) => {
    const t = i / steps;
    const u = 1 - t;
    return {
      x: u * u * a.x + 2 * u * t * b.x + t * t * c.x,
      y: u * u * a.y + 2 * u * t * b.y + t * t * c.y,
    };
  });

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
  const [arcDraft, setArcDraft] = useState<Pt[]>([]);
  const [hoverPt, setHoverPt] = useState<Pt | null>(null);
  const [selectedPoints, setSelectedPoints] = useState<Set<string>>(new Set());
  const [selectedLine, setSelectedLine] = useState<number | null>(null);
  const [selectedLinePoint, setSelectedLinePoint] = useState<{ li: number; pi: number } | null>(null);
  const [nodeMenu, setNodeMenu] = useState<{
    x: number;
    y: number;
    target: { type: "closed"; ci: number; pi: number } | { type: "line"; li: number; pi: number };
  } | null>(null);
  const [undoStack, setUndoStack] = useState<ContourSet[]>([]);
  const [redoStack, setRedoStack] = useState<ContourSet[]>([]);
  // Repair & transform parameters (mm when calibrated, px otherwise)
  const [cornerRadius, setCornerRadius] = useState(3);
  const [resampleStep, setResampleStep] = useState(2);
  const [offsetMm, setOffsetMm] = useState(0.5);
  const [scaleMode, setScaleMode] = useState<"percent" | "width">("percent");
  const [scalePct, setScalePct] = useState(100);
  const [scaleTargetWidth, setScaleTargetWidth] = useState(100);
  const [mirrorCopy, setMirrorCopy] = useState(true);
  const [mirrorGap, setMirrorGap] = useState(0);
  const [smoothStrength, setSmoothStrength] = useState(settings.smoothing);
  const [simplifyEps, setSimplifyEps] = useState(2);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const pageRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const dragRef = useRef<DragState>(null);
  const [marquee, setMarquee] = useState<{ a: Pt; b: Pt } | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [panelTab, setPanelTab] = useState<"tool" | "repair" | "transform" | "data">("tool");
  // Призрачна фигура при чертане с влачене
  const [ghost, setGhost] = useState<{ shape: "circle" | "triangle" | "square"; start: Pt; cur: Pt } | null>(null);
  // Свободно местене/въртене на подложната снимка (само визуално, в редактора)
  const [imgOffset, setImgOffset] = useState({ x: 0, y: 0 });
  const [imgRotation, setImgRotation] = useState(0);

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
  const pxToUnit = useCallback(
    (value: number) => {
      const k = record?.calibration?.mmPerPx;
      return k ? value * k : value;
    },
    [record]
  );
  const unitLabel = record?.calibration ? "mm" : "px";

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

  const hitLinePoint = (p: Pt): { li: number; pi: number } | null => {
    const tol = 11 / view.scale;
    for (let li = 0; li < openLines.length; li++) {
      for (let pi = 0; pi < openLines[li].length; pi++) {
        const q = openLines[li][pi];
        if (Math.hypot(q.x - p.x, q.y - p.y) <= tol) return { li, pi };
      }
    }
    return null;
  };

  const hitOpenLine = (p: Pt): number | null => {
    const tol = 12 / view.scale;
    let best = { li: -1, dist: Infinity };
    openLines.forEach((line, li) => {
      for (let i = 0; i < line.length - 1; i++) {
        const dist = pointToSegment(p, line[i], line[i + 1]);
        if (dist < best.dist) best = { li, dist };
      }
    });
    return best.li !== -1 && best.dist <= tol ? best.li : null;
  };

  const hitMidpoint = (p: Pt):
    | { type: "closed"; ci: number; index: number; point: Pt }
    | { type: "line"; li: number; index: number; point: Pt }
    | null => {
    const tol = 8 / view.scale;
    for (let ci = 0; ci < polys.length; ci++) {
      const poly = polys[ci];
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i];
        const b = poly[(i + 1) % poly.length];
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        if (Math.hypot(mid.x - p.x, mid.y - p.y) <= tol) return { type: "closed", ci, index: i, point: mid };
      }
    }
    for (let li = 0; li < openLines.length; li++) {
      const line = openLines[li];
      for (let i = 0; i < line.length - 1; i++) {
        const a = line[i];
        const b = line[i + 1];
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        if (Math.hypot(mid.x - p.x, mid.y - p.y) <= tol) return { type: "line", li, index: i, point: mid };
      }
    }
    return null;
  };

  const hitBezierHandle = (p: Pt): { li: number; pi: number; side: "prev" | "next" } | null => {
    if (!selectedLinePoint) return null;
    const { li, pi } = selectedLinePoint;
    const line = openLines[li];
    if (!line || pi <= 0 || pi >= line.length - 1) return null;
    const tol = 10 / view.scale;
    const prevHandle = { x: (line[pi - 1].x + line[pi].x) / 2, y: (line[pi - 1].y + line[pi].y) / 2 };
    const nextHandle = { x: (line[pi + 1].x + line[pi].x) / 2, y: (line[pi + 1].y + line[pi].y) / 2 };
    if (Math.hypot(prevHandle.x - p.x, prevHandle.y - p.y) <= tol) return { li, pi, side: "prev" };
    if (Math.hypot(nextHandle.x - p.x, nextHandle.y - p.y) <= tol) return { li, pi, side: "next" };
    return null;
  };

  const setOpenLines = (lines: Pt[][]) => {
    setContours((cur) => (cur ? { ...cur, polylines: lines } : cur));
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
      // Подложната снимка може да се мести и върти свободно (инструмент "Снимка").
      const cw = record.imageSize.w;
      const chh = record.imageSize.h;
      ctx.save();
      ctx.globalAlpha = 0.42;
      ctx.translate(cw / 2 + imgOffset.x, chh / 2 + imgOffset.y);
      ctx.rotate((imgRotation * Math.PI) / 180);
      ctx.drawImage(imgRef.current, -cw / 2, -chh / 2, cw, chh);
      ctx.restore();
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
      const wholeSelected =
        pts.length > 0 && pts.every((_, pi) => selectedPoints.has(pointKey(ci, pi)));
      const color = wholeSelected ? "#2563eb" : ci === 0 ? "#2563eb" : "#dc2626";
      ctx.beginPath();
      pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.closePath();
      // Фигурите (не външният контур) са "сенчести"; избраните светят в синьо.
      if (ci !== 0) {
        ctx.fillStyle = wholeSelected ? "rgba(37,99,235,0.18)" : "rgba(120,134,150,0.14)";
        ctx.fill();
      } else if (wholeSelected) {
        ctx.fillStyle = "rgba(37,99,235,0.08)";
        ctx.fill();
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = (wholeSelected ? 3 : 2.2) / view.scale;
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
      for (let pi = 0; pi < pts.length; pi++) {
        const a = pts[pi];
        const b = pts[(pi + 1) % pts.length];
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        ctx.beginPath();
        ctx.arc(mid.x, mid.y, 2.2 / view.scale, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(17,24,39,0.28)";
        ctx.fill();
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
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i];
        const b = pts[i + 1];
        ctx.beginPath();
        ctx.arc((a.x + b.x) / 2, (a.y + b.y) / 2, 2.2 / view.scale, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(17,24,39,0.28)";
        ctx.fill();
      }
    };

    const labelAt = (text: string, p: Pt) => {
      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, view.tx * dpr, view.ty * dpr);
      ctx.scale(view.scale, view.scale);
      ctx.font = `${12 / view.scale}px ui-monospace, SFMono-Regular, Menlo, monospace`;
      ctx.fillStyle = "#111827";
      ctx.strokeStyle = "rgba(255,255,255,0.88)";
      ctx.lineWidth = 4 / view.scale;
      ctx.strokeText(text, p.x + 8 / view.scale, p.y - 8 / view.scale);
      ctx.fillText(text, p.x + 8 / view.scale, p.y - 8 / view.scale);
      ctx.restore();
    };

    const drawDimension = (pts: Pt[], closed: boolean) => {
      if (pts.length < 2) return;
      const b = boundsOf([pts]);
      const w = pxToUnit(b.maxX - b.minX);
      const h = pxToUnit(b.maxY - b.minY);
      const len = pxToUnit(polyLength(pts, closed));
      const text = closed
        ? `W:${w.toFixed(1)} ${unitLabel}  H:${h.toFixed(1)} ${unitLabel}`
        : `L:${len.toFixed(1)} ${unitLabel}`;
      labelAt(text, { x: b.maxX, y: b.minY });
    };

    openLines.forEach((line, li) => {
      drawOpen(line, selectedLine === li ? "#2563eb" : "#16a34a");
      drawDimension(line, false);
      if (selectedLine === li || selectedLinePoint?.li === li) {
        const b = boundsOf([line]);
        ctx.strokeStyle = "#2563eb";
        ctx.lineWidth = 1.4 / view.scale;
        ctx.setLineDash([5 / view.scale, 4 / view.scale]);
        ctx.strokeRect(b.minX, b.minY, b.maxX - b.minX, b.maxY - b.minY);
        ctx.setLineDash([]);
      }
    });

    if (selectedLinePoint) {
      const line = openLines[selectedLinePoint.li];
      const pi = selectedLinePoint.pi;
      if (line && pi > 0 && pi < line.length - 1) {
        const p = line[pi];
        const handles = [
          { x: (line[pi - 1].x + p.x) / 2, y: (line[pi - 1].y + p.y) / 2 },
          { x: (line[pi + 1].x + p.x) / 2, y: (line[pi + 1].y + p.y) / 2 },
        ];
        ctx.strokeStyle = "#0891b2";
        ctx.lineWidth = 1.3 / view.scale;
        ctx.beginPath();
        handles.forEach((h) => {
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(h.x, h.y);
        });
        ctx.stroke();
        handles.forEach((h) => {
          ctx.beginPath();
          ctx.rect(h.x - 3.2 / view.scale, h.y - 3.2 / view.scale, 6.4 / view.scale, 6.4 / view.scale);
          ctx.fillStyle = "#ffffff";
          ctx.fill();
          ctx.strokeStyle = "#0891b2";
          ctx.stroke();
        });
      }
    }

    polys.slice(1).forEach((poly) => drawDimension(poly, true));

    drawOpen(polyDraft, "#e8a33d");
    if (tool === "polyline" && polyDraft.length > 0 && hoverPt) {
      const last = polyDraft[polyDraft.length - 1];
      ctx.beginPath();
      ctx.moveTo(last.x, last.y);
      ctx.lineTo(hoverPt.x, hoverPt.y);
      ctx.strokeStyle = "#111827";
      ctx.lineWidth = 1.2 / view.scale;
      ctx.setLineDash([3 / view.scale, 3 / view.scale]);
      ctx.stroke();
      ctx.setLineDash([]);
      const l = pxToUnit(Math.hypot(hoverPt.x - last.x, hoverPt.y - last.y));
      const a = (Math.atan2(hoverPt.y - last.y, hoverPt.x - last.x) * 180) / Math.PI;
      labelAt(`L:${l.toFixed(1)} ${unitLabel}\nA:${a.toFixed(1)}`, hoverPt);
    }

    const arcPreview = arcDraft.length === 2 && hoverPt ? arcFrom3Points(arcDraft[0], arcDraft[1], hoverPt) : arcDraft;
    drawOpen(arcPreview, "#a855f7");
    if (tool === "arc" && arcPreview.length > 1) drawDimension(arcPreview, false);

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

    // Призрачна фигура при чертане с влачене
    if (ghost) {
      const pts = shapeFromDrag(ghost.shape, ghost.start, ghost.cur);
      ctx.beginPath();
      pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.closePath();
      ctx.fillStyle = "rgba(37,99,235,0.10)";
      ctx.fill();
      ctx.strokeStyle = "#4c8dff";
      ctx.lineWidth = 2 / view.scale;
      ctx.setLineDash([7 / view.scale, 5 / view.scale]);
      ctx.stroke();
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
  }, [record, contours, polys, openLines, polyDraft, arcDraft, hoverPt, selectedPoints, selectedLine, selectedLinePoint, marquee, ghost, imgOffset, imgRotation, view, grid, gridStep, tool, pivot, pxToUnit, unitLabel]);

  useEffect(() => {
    redraw();
    const wrap = wrapRef.current;
    if (!wrap) return;
    const ro = new ResizeObserver(redraw);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [redraw]);

  const deleteSelectedPoints = () => {
    if (selectedLine !== null) {
      pushUndo();
      setOpenLines(openLines.filter((_, i) => i !== selectedLine));
      setSelectedLine(null);
      setSelectedLinePoint(null);
      toast("Полилинията е изтрита");
      return;
    }
    if (selectedLinePoint) {
      const { li, pi } = selectedLinePoint;
      if (!openLines[li] || openLines[li].length <= 2) {
        pushUndo();
        setOpenLines(openLines.filter((_, i) => i !== li));
      } else {
        pushUndo();
        setOpenLines(openLines.map((line, i) => (i === li ? line.filter((_, j) => j !== pi) : line)));
      }
      setSelectedLinePoint(null);
      setSelectedLine(null);
      return;
    }
    if (!selectedPoints.size) return;
    pushUndo();
    // Ако ЦЯЛА фигура (дупка/фигура, не външният контур) е избрана — трие се изцяло.
    const fullySelected = new Set<number>();
    polys.forEach((poly, ci) => {
      if (ci !== 0 && poly.every((_, pi) => selectedPoints.has(pointKey(ci, pi))))
        fullySelected.add(ci);
    });
    const kept = polys.filter((_, ci) => !fullySelected.has(ci));
    const keptIdx = polys.map((_, ci) => ci).filter((ci) => !fullySelected.has(ci));
    const next = kept.map((poly, k) => {
      const ci = keptIdx[k];
      const filtered = poly.filter((_, pi) => !selectedPoints.has(pointKey(ci, pi)));
      return filtered.length >= 3 ? filtered : poly;
    });
    setPolys(next);
    setSelectedPoints(new Set());
    if (fullySelected.size) toast("Фигурата е изтрита");
  };
  const deleteSelectedRef = useRef(deleteSelectedPoints);
  deleteSelectedRef.current = deleteSelectedPoints;

  // Клавишни комбинации: Del/Backspace, Ctrl+Z, Ctrl+Y / Ctrl+Shift+Z, Esc, F.
  const undoRef = useRef<() => void>(() => {});
  const redoRef = useRef<() => void>(() => {});
  const escRef = useRef<() => void>(() => {});
  const fitRef = useRef<() => void>(() => {});
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT"))
        return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && (e.key === "z" || e.key === "Z") && !e.shiftKey) {
        e.preventDefault();
        undoRef.current();
      } else if ((mod && (e.key === "y" || e.key === "Y")) || (mod && e.shiftKey && (e.key === "z" || e.key === "Z"))) {
        e.preventDefault();
        redoRef.current();
      } else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        deleteSelectedRef.current();
      } else if (e.key === "Escape") {
        escRef.current();
      } else if (!mod && (e.key === "f" || e.key === "F")) {
        fitRef.current();
      }
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

  /* ---------- Зашиване на начертана линия в контура (ножица) ---------- */


  /** Позиция на най-близката точка ВЪРХУ затворен контур (дробен индекс). */
  const nearestOnContour = (pts: Pt[], p: Pt) => {
    let best = { index: 0, t: 0, dist: Infinity, point: pts[0] };
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len2 = dx * dx + dy * dy || 1;
      let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
      t = Math.max(0, Math.min(1, t));
      const q = { x: a.x + t * dx, y: a.y + t * dy };
      const d = Math.hypot(p.x - q.x, p.y - q.y);
      if (d < best.dist) best = { index: i, t, dist: d, point: q };
    }
    return best;
  };

  /**
   * Опит за "зашиване": ако начертана полилиния има двата си края върху
   * кликнатия контур, участъкът от контура под клика се маха и се заменя
   * с полилинията → нова затворена форма. Връща true при успех.
   */
  const spliceContourWithPolyline = (ci: number, clickP: Pt): boolean => {
    const contour = polys[ci];
    if (!contour || contour.length < 3 || !openLines.length) return false;
    const n = contour.length;
    const attachTol = 30 / view.scale;

    /** Пресичане на отсечки p1→p2 и p3→p4; връща параметрите и точката. */
    const segIntersect = (p1: Pt, p2: Pt, p3: Pt, p4: Pt) => {
      const d1x = p2.x - p1.x;
      const d1y = p2.y - p1.y;
      const d2x = p4.x - p3.x;
      const d2y = p4.y - p3.y;
      const den = d1x * d2y - d1y * d2x;
      if (Math.abs(den) < 1e-12) return null;
      const t = ((p3.x - p1.x) * d2y - (p3.y - p1.y) * d2x) / den;
      const u = ((p3.x - p1.x) * d1y - (p3.y - p1.y) * d1x) / den;
      if (t < 0 || t > 1 || u < 0 || u > 1) return null;
      return { t, u, pt: { x: p1.x + t * d1x, y: p1.y + t * d1y } };
    };

    // Вариант А: линията ПРЕСИЧА контура (като зелената права през фигурата).
    // Взимаме първото и последното пресичане по дължината на линията.
    type Hit = { linePos: number; contourPos: number; pt: Pt };
    let chosen: { li: number; first: Hit; last: Hit } | null = null;
    for (let li = 0; li < openLines.length; li++) {
      const line = openLines[li];
      const hits: Hit[] = [];
      for (let j = 0; j < line.length - 1; j++) {
        for (let i = 0; i < n; i++) {
          const hit = segIntersect(line[j], line[j + 1], contour[i], contour[(i + 1) % n]);
          if (hit) hits.push({ linePos: j + hit.t, contourPos: i + hit.u, pt: hit.pt });
        }
      }
      if (hits.length >= 2) {
        hits.sort((a, b) => a.linePos - b.linePos);
        chosen = { li, first: hits[0], last: hits[hits.length - 1] };
        break;
      }
    }

    let bestLine = -1;
    let posA = 0;
    let posB = 0;
    let bridge: Pt[] = [];
    let ptA: Pt | null = null;

    if (chosen) {
      const line = openLines[chosen.li];
      bestLine = chosen.li;
      posA = chosen.first.contourPos;
      posB = chosen.last.contourPos;
      ptA = chosen.first.pt;
      // Мостът е частта от линията МЕЖДУ двете пресичания.
      bridge = [chosen.first.pt];
      for (let j = Math.floor(chosen.first.linePos) + 1; j <= Math.floor(chosen.last.linePos); j++) {
        if (j > chosen.first.linePos && j < chosen.last.linePos) bridge.push(line[j]);
      }
      bridge.push(chosen.last.pt);
    } else {
      // Вариант Б (както досега): краищата на линията лежат върху контура.
      let bestScore = Infinity;
      let attA: { index: number; t: number; dist: number; point: Pt } | null = null;
      let attB: { index: number; t: number; dist: number; point: Pt } | null = null;
      openLines.forEach((line, li) => {
        if (line.length < 2) return;
        const a = nearestOnContour(contour, line[0]);
        const b = nearestOnContour(contour, line[line.length - 1]);
        if (a.dist <= attachTol && b.dist <= attachTol && a.dist + b.dist < bestScore) {
          bestScore = a.dist + b.dist;
          bestLine = li;
          attA = a;
          attB = b;
        }
      });
      if (bestLine === -1 || !attA || !attB) return false;
      const a = attA as { index: number; t: number; point: Pt };
      const b = attB as { index: number; t: number; point: Pt };
      posA = a.index + a.t;
      posB = b.index + b.t;
      ptA = a.point;
      bridge = [...openLines[bestLine]];
    }

    const click = nearestOnContour(contour, clickP);
    const posClick = click.index + click.t;
    const span = (posB - posA + n) % n;
    if (span < 1e-6 || span > n - 1e-6) return false;

    // В коя дъга е кликът: A→B (напред) или B→A?
    const relClick = (posClick - posA + n) % n;
    const clickInAB = relClick > 0 && relClick < span;

    // Запазваме дъгата БЕЗ клика; мостът замества изрязаната дъга.
    const keptFrom = clickInAB ? posB : posA;
    const keptTo = clickInAB ? posA : posB;
    const keptSpan = (keptTo - keptFrom + n) % n;
    const arc: Pt[] = [];
    for (let k = 0; k < n; k++) {
      const idx = (Math.floor(keptFrom) + 1 + k) % n;
      const rel = (idx - keptFrom + n) % n;
      if (rel <= 0 || rel >= keptSpan) {
        if (rel >= keptSpan) break;
        continue;
      }
      arc.push(contour[idx]);
    }

    // Ориентираме моста така, че да започва от края на запазената дъга (A или B).
    const keptEndPt = clickInAB ? (ptA as Pt) : bridge[bridge.length - 1];
    const dStart = Math.hypot(bridge[0].x - keptEndPt.x, bridge[0].y - keptEndPt.y);
    const dEnd = Math.hypot(
      bridge[bridge.length - 1].x - keptEndPt.x,
      bridge[bridge.length - 1].y - keptEndPt.y
    );
    const orientedBridge = dStart <= dEnd ? bridge : [...bridge].reverse();

    const newContour = [...arc, ...orientedBridge];
    if (newContour.length < 3) return false;

    pushUndo();
    const nextPolys = polys.map((poly, i) => (i === ci ? newContour : poly));
    setContours({
      outer: nextPolys[0],
      inner: nextPolys.slice(1),
      polylines: openLines.filter((_, i) => i !== bestLine),
    });
    setSelectedPoints(new Set());
    toast("Кликнатата страна е изрязана — линията стана част от контура");
    return true;
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

    // Първо: ако има начертана линия с краища върху този контур — зашиваме я
    // на мястото на кликнатия участък (нова форма).
    if (spliceContourWithPolyline(best.idx, p)) return;

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
      pts = Array.from({ length: 4 }, (_, i) => {
        const a = -Math.PI / 2 + (i / 4) * Math.PI * 2;
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

  /** Фигура, разпъната с влачене: от начална до крайна точка. */
  const shapeFromDrag = (shape: "circle" | "triangle" | "square", a: Pt, b: Pt): Pt[] => {
    if (shape === "circle") {
      const r = Math.hypot(b.x - a.x, b.y - a.y);
      return Array.from({ length: 4 }, (_, i) => {
        const ang = -Math.PI / 2 + (i / 4) * Math.PI * 2;
        return { x: a.x + Math.cos(ang) * r, y: a.y + Math.sin(ang) * r };
      });
    }
    const minX = Math.min(a.x, b.x);
    const maxX = Math.max(a.x, b.x);
    const minY = Math.min(a.y, b.y);
    const maxY = Math.max(a.y, b.y);
    if (shape === "square") {
      return [
        { x: minX, y: minY },
        { x: maxX, y: minY },
        { x: maxX, y: maxY },
        { x: minX, y: maxY },
      ];
    }
    // Триъгълник: върхът горе в средата, основата долу.
    return [
      { x: (minX + maxX) / 2, y: minY },
      { x: maxX, y: maxY },
      { x: minX, y: maxY },
    ];
  };

  const commitDraggedShape = (shape: "circle" | "triangle" | "square", a: Pt, b: Pt) => {
    const pts = shapeFromDrag(shape, a, b);
    pushUndo();
    setContours((cur) => cur && { ...cur, inner: [...cur.inner, pts] });
  };

  const finishPolyline = () => {
    if (polyDraft.length < 2) return;
    pushUndo();
    setContours((cur) => cur && { ...cur, polylines: [...(cur.polylines ?? []), polyDraft] });
    setPolyDraft([]);
  };

  const insertLineMidpoint = (li: number, pi: number) => {
    const line = openLines[li];
    if (!line || pi >= line.length - 1) return;
    const a = line[pi];
    const b = line[pi + 1];
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    pushUndo();
    setOpenLines(openLines.map((l, i) => (i === li ? [...l.slice(0, pi + 1), mid, ...l.slice(pi + 1)] : l)));
    setSelectedLinePoint({ li, pi: pi + 1 });
  };

  const deleteLineSpan = (li: number, pi: number) => {
    const line = openLines[li];
    if (!line) return;
    pushUndo();
    if (line.length <= 2) {
      setOpenLines(openLines.filter((_, i) => i !== li));
    } else {
      setOpenLines(openLines.map((l, i) => (i === li ? l.filter((_, j) => j !== pi) : l)));
    }
    setSelectedLinePoint(null);
  };

  const reverseLine = (li: number) => {
    pushUndo();
    setOpenLines(openLines.map((l, i) => (i === li ? [...l].reverse() : l)));
  };

  const joinOpenLines = (mode: "line" | "arc") => {
    if (openLines.length < 2) return toast("Нужни са поне две отворени линии", "err");
    type End = { li: number; end: "start" | "end"; p: Pt };
    const ends: End[] = openLines.flatMap((line, li) => [
      { li, end: "start" as const, p: line[0] },
      { li, end: "end" as const, p: line[line.length - 1] },
    ]);
    let best: { a: End; b: End; dist: number } | null = null;
    for (let i = 0; i < ends.length; i++) {
      for (let j = i + 1; j < ends.length; j++) {
        if (ends[i].li === ends[j].li) continue;
        const dist = Math.hypot(ends[i].p.x - ends[j].p.x, ends[i].p.y - ends[j].p.y);
        if (!best || dist < best.dist) best = { a: ends[i], b: ends[j], dist };
      }
    }
    if (!best) return;
    const orient = (line: Pt[], end: "start" | "end", first: boolean) => {
      if (first) return end === "end" ? line : [...line].reverse();
      return end === "start" ? line : [...line].reverse();
    };
    const aLine = orient(openLines[best.a.li], best.a.end, true);
    const bLine = orient(openLines[best.b.li], best.b.end, false);
    const p1 = aLine[aLine.length - 1];
    const p2 = bLine[0];
    let bridge: Pt[] = [];
    if (mode === "arc") {
      const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
      const dx = p2.x - p1.x;
      const dy = p2.y - p1.y;
      const len = Math.hypot(dx, dy) || 1;
      const control = { x: mid.x - (dy / len) * len * 0.25, y: mid.y + (dx / len) * len * 0.25 };
      bridge = arcFrom3Points(p1, control, p2, 18).slice(1, -1);
    }
    const joined = [...aLine, ...bridge, ...bLine];
    pushUndo();
    setOpenLines(openLines.filter((_, i) => i !== best!.a.li && i !== best!.b.li).concat([joined]));
    setSelectedLine(openLines.length - 2);
    toast(mode === "arc" ? "Линиите са join-нати с арка" : "Линиите са join-нати с права линия");
  };

  /**
   * Смяна на инструмента. Ако оставяш Полилиния с начертана чернова,
   * тя се завършва автоматично — така "чертая → ножица → режа" работи направо.
   */
  const switchTool = (next: ToolMode) => {
    if (tool === "polyline" && next !== "polyline" && polyDraft.length >= 2) {
      finishPolyline();
      toast("Линията е завършена автоматично");
    } else if (tool === "polyline" && next !== "polyline") {
      setPolyDraft([]);
    }
    if (tool === "arc" && next !== "arc") setArcDraft([]);
    setNodeMenu(null);
    setTool(next);
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
      // Влачене = свободно разпъване на фигурата (призрачен изглед).
      dragRef.current = { kind: "draw-shape", shape: tool, start: snapPt(p) };
      setGhost({ shape: tool, start: snapPt(p), cur: snapPt(p) });
      return;
    }
    if (tool === "polyline") {
      setPolyDraft((draft) => [...draft, snapPt(p)]);
      return;
    }
    if (tool === "arc") {
      const next = [...arcDraft, snapPt(p)];
      if (next.length >= 3) {
        pushUndo();
        const arc = arcFrom3Points(next[0], next[1], next[2]);
        setContours((cur) => cur && { ...cur, polylines: [...(cur.polylines ?? []), arc] });
        setArcDraft([]);
      } else {
        setArcDraft(next);
      }
      return;
    }
    if (tool === "image") {
      dragRef.current = { kind: "image-move", start: p, startOff: { ...imgOffset } };
      return;
    }

    // --- select tool ---
    const handle = hitBezierHandle(p);
    if (handle) {
      pushUndo();
      dragRef.current = { kind: "bezier-handle", ...handle };
      return;
    }
    // Ctrl/Cmd + клик върху линия: добавя нова точка там.
    if (e.ctrlKey || e.metaKey) {
      let best = { ci: -1, index: 0, dist: Infinity };
      polys.forEach((poly, ci) => {
        const seg = nearestSegment(poly, p);
        if (seg.dist < best.dist) best = { ci, ...seg };
      });
      if (best.ci !== -1 && best.dist <= 15 / view.scale) {
        pushUndo();
        const q = snapPt(p);
        const nextP = polys.map((poly, ci) => {
          if (ci !== best.ci) return poly;
          const copy = [...poly];
          copy.splice(best.index + 1, 0, q);
          return copy;
        });
        setPolys(nextP);
        setSelectedPoints(new Set([pointKey(best.ci, best.index + 1)]));
        return;
      }
    }

    const hit = hitPoint(p);
    if (hit) {
      setSelectedLine(null);
      setSelectedLinePoint(null);
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
      const linePoint = hitLinePoint(p);
      if (linePoint) {
        pushUndo();
        setSelectedPoints(new Set());
        setSelectedLine(linePoint.li);
        setSelectedLinePoint(linePoint);
        dragRef.current = { kind: "line-point", ...linePoint };
        return;
      }
      const lineHit = hitOpenLine(p);
      if (lineHit !== null) {
        pushUndo();
        setSelectedPoints(new Set());
        setSelectedLine(lineHit);
        setSelectedLinePoint(null);
        dragRef.current = { kind: "line-move", li: lineHit, last: p };
        return;
      }
      // Ако вече има селекция: хващане върху линията или ВЪТРЕ в изцяло
      // избрана фигура мести цялата селекция свободно.
      if (selectedPoints.size) {
        const grabTol = 12 / view.scale;
        let grab = false;
        for (let ci = 0; ci < polys.length; ci++) {
          const fully =
            polys[ci].length > 0 &&
            polys[ci].every((_, pi) => selectedPoints.has(pointKey(ci, pi)));
          if (!fully) continue;
          if (
            nearestSegment(polys[ci], p).dist <= grabTol ||
            pointInPolygon(p, polys[ci])
          ) {
            grab = true;
            break;
          }
        }
        if (grab) {
          pushUndo();
          dragRef.current = { kind: "drag-selected", last: p, selection: new Set(selectedPoints) };
          return;
        }
      }

      // Клик върху линията на фигура (без точка): избира ЦЯЛАТА фигура (оцветява се в синьо).
      let segHit = { ci: -1, dist: Infinity };
      polys.forEach((poly, ci) => {
        const seg = nearestSegment(poly, p);
        if (seg.dist < segHit.dist) segHit = { ci, dist: seg.dist };
      });
      if (segHit.ci !== -1 && segHit.dist <= 10 / view.scale) {
        const sel = e.shiftKey ? new Set(selectedPoints) : new Set<string>();
        polys[segHit.ci].forEach((_, pi) => sel.add(pointKey(segHit.ci, pi)));
        setSelectedPoints(sel);
        // Влаченето мести цялата избрана фигура.
        pushUndo();
        dragRef.current = { kind: "drag-selected", last: p, selection: sel };
        return;
      }
      // Празно място: рисуваме правоъгълник за селекция (marquee).
      dragRef.current = { kind: "marquee", additive: e.shiftKey };
      setMarquee({ a: p, b: p });
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (tool === "polyline" || tool === "arc") setHoverPt(snapPt(toImage(e)));
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
    } else if (drag.kind === "line-point") {
      const p = snapPt(toImage(e));
      setOpenLines(openLines.map((line, li) => (li === drag.li ? line.map((q, pi) => (pi === drag.pi ? p : q)) : line)));
    } else if (drag.kind === "line-move") {
      const p = toImage(e);
      const dx = p.x - drag.last.x;
      const dy = p.y - drag.last.y;
      setOpenLines(openLines.map((line, li) => (li === drag.li ? line.map((q) => ({ x: q.x + dx, y: q.y + dy })) : line)));
      drag.last = p;
    } else if (drag.kind === "bezier-handle") {
      const p = snapPt(toImage(e));
      const line = openLines[drag.li];
      if (line && drag.pi > 0 && drag.pi < line.length - 1) {
        const a = drag.side === "prev" ? line[drag.pi - 1] : line[drag.pi];
        const c = drag.side === "prev" ? line[drag.pi] : line[drag.pi + 1];
        const bez = bezierFrom3Points(a, p, c, 12);
        setOpenLines(openLines.map((l, li) => {
          if (li !== drag.li) return l;
          return drag.side === "prev"
            ? [...l.slice(0, drag.pi - 1), ...bez, ...l.slice(drag.pi + 1)]
            : [...l.slice(0, drag.pi), ...bez, ...l.slice(drag.pi + 2)];
        }));
        setSelectedLinePoint({ li: drag.li, pi: drag.side === "prev" ? drag.pi + 5 : drag.pi + 6 });
      }
    } else if (drag.kind === "marquee") {
      const p = toImage(e);
      setMarquee((m) => (m ? { a: m.a, b: p } : m));
    } else if (drag.kind === "draw-shape") {
      const p = snapPt(toImage(e));
      setGhost((g) => (g ? { ...g, cur: p } : g));
    } else if (drag.kind === "image-move") {
      const p = toImage(e);
      setImgOffset({
        x: drag.startOff.x + (p.x - drag.start.x),
        y: drag.startOff.y + (p.y - drag.start.y),
      });
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
    if (drag?.kind === "draw-shape") {
      setGhost((g) => {
        if (g) {
          const d = Math.hypot(g.cur.x - g.start.x, g.cur.y - g.start.y);
          if (d >= 3 / view.scale) {
            commitDraggedShape(g.shape, g.start, g.cur);
          } else {
            // Само клик без влачене: фигура с настроения диаметър.
            addShape(g.shape, g.start);
          }
        }
        return null;
      });
      dragRef.current = null;
      return;
    }
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
    if (tool === "arc") {
      setArcDraft([]);
      return;
    }
    if (tool !== "select") return;
    const p = toImage(e);
    const mid = hitMidpoint(p);
    if (mid) {
      pushUndo();
      if (mid.type === "line") {
        setOpenLines(openLines.map((line, li) => {
          if (li !== mid.li) return line;
          const copy = [...line];
          copy.splice(mid.index + 1, 0, mid.point);
          return copy;
        }));
        setSelectedLine(mid.li);
        setSelectedLinePoint({ li: mid.li, pi: mid.index + 1 });
      } else {
        const next = polys.map((poly, ci) => {
          if (ci !== mid.ci) return poly;
          const copy = [...poly];
          copy.splice(mid.index + 1, 0, mid.point);
          return copy;
        });
        setPolys(next);
        setSelectedPoints(new Set([pointKey(mid.ci, mid.index + 1)]));
      }
      return;
    }
    const lineHit = hitOpenLine(p);
    if (lineHit !== null) {
      let best = { index: 0, dist: Infinity };
      openLines[lineHit].forEach((_, i) => {
        if (i >= openLines[lineHit].length - 1) return;
        const dist = pointToSegment(p, openLines[lineHit][i], openLines[lineHit][i + 1]);
        if (dist < best.dist) best = { index: i, dist };
      });
      if (best.dist <= 15 / view.scale) {
        pushUndo();
        setOpenLines(openLines.map((line, li) => {
          if (li !== lineHit) return line;
          const copy = [...line];
          copy.splice(best.index + 1, 0, snapPt(p));
          return copy;
        }));
        setSelectedLine(lineHit);
        setSelectedLinePoint({ li: lineHit, pi: best.index + 1 });
        return;
      }
    }
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
    if (tool === "polyline") {
      if (polyDraft.length >= 3) {
        pushUndo();
        setContours((cur) => cur && { ...cur, inner: [...cur.inner, polyDraft] });
        setPolyDraft([]);
        toast("Полилинията е затворена автоматично");
      } else if (polyDraft.length >= 2) {
        finishPolyline();
      }
      return;
    }
    const p = toImage(e);
    const lp = hitLinePoint(p);
    if (lp) {
      setSelectedLine(lp.li);
      setSelectedLinePoint(lp);
      setNodeMenu({ x: e.clientX, y: e.clientY, target: { type: "line", ...lp } });
      return;
    }
    const hp = hitPoint(p);
    if (hp) {
      setSelectedPoints(new Set([pointKey(hp.ci, hp.pi)]));
      setNodeMenu({ x: e.clientX, y: e.clientY, target: { type: "closed", ...hp } });
      return;
    }
    deleteNearestPoint(p);
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

  const mirrorToSide = (side: "left" | "right" | "top" | "bottom") => {
    if (!contours) return;
    const selectedContours = new Set<number>();
    selectedPoints.forEach((key) => {
      const [ci] = key.split(":").map(Number);
      if (polys[ci]?.every((_, pi) => selectedPoints.has(pointKey(ci, pi)))) selectedContours.add(ci);
    });
    const sourceClosed = selectedContours.size ? [...selectedContours].map((ci) => polys[ci]).filter(Boolean) : polys;
    const sourceOpen = selectedLine !== null && openLines[selectedLine] ? [openLines[selectedLine]] : openLines;
    const allSource = [...sourceClosed, ...sourceOpen];
    if (!allSource.length) return;
    const b = boundsOf(allSource);
    const gap = distanceToPx(mirrorGap);
    const axis =
      side === "right"
        ? b.maxX + gap / 2
        : side === "left"
          ? b.minX - gap / 2
          : side === "bottom"
            ? b.maxY + gap / 2
            : b.minY - gap / 2;
    const reflect = (p: Pt): Pt =>
      side === "right" || side === "left"
        ? { x: 2 * axis - p.x, y: p.y }
        : { x: p.x, y: 2 * axis - p.y };
    const mirroredClosed = sourceClosed.map((poly) => poly.map(reflect));
    const mirroredOpen = sourceOpen.map((line) => line.map(reflect));
    pushUndo();
    if (mirrorCopy) {
      setContours({
        ...contours,
        inner: [...contours.inner, ...mirroredClosed],
        polylines: [...(contours.polylines ?? []), ...mirroredOpen],
      });
    } else {
      setContours({
        outer: mirroredClosed[0] ?? contours.outer,
        inner: mirroredClosed.length ? mirroredClosed.slice(1) : contours.inner,
        polylines: mirroredOpen,
      });
    }
    toast(mirrorCopy ? "Създадено е огледално копие" : "Формата е обърната огледално");
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

  // Актуализираме ref-овете за клавишните комбинации на всеки render.
  undoRef.current = undo;
  redoRef.current = redo;
  escRef.current = () => {
    setSelectedPoints(new Set());
    setSelectedLine(null);
    setSelectedLinePoint(null);
    setNodeMenu(null);
    setPolyDraft([]);
    setArcDraft([]);
    setGhost(null);
  };
  fitRef.current = () => fitView(record);

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
            <IconTool active={tool === "select"} icon="cursor" label="Избор / маркиране" onClick={() => switchTool("select")} />
            <IconTool active={tool === "move"} icon="move" label="Премести всичко" onClick={() => switchTool("move")} />
            <IconTool active={tool === "rotate"} icon="rotate" label="Завърти" onClick={() => switchTool("rotate")} />
            <IconTool active={tool === "delete"} icon="trash" label="Изтриване на точки" onClick={() => switchTool("delete")} />
            <IconTool active={tool === "scissors"} icon="scissors" label="Ножица — клик върху линия я изтрива" onClick={() => switchTool("scissors")} />
          </ToolGroup>
          <ToolGroup label="Фигури">
            <IconTool active={tool === "circle"} icon="circle" label="Кръг" onClick={() => switchTool("circle")} />
            <IconTool active={tool === "triangle"} icon="triangle" label="Триъгълник" onClick={() => switchTool("triangle")} />
            <IconTool active={tool === "square"} icon="square" label="Квадрат" onClick={() => switchTool("square")} />
            <IconTool active={tool === "polyline"} icon="polyline" label="Полилиния" onClick={() => switchTool("polyline")} />
            <IconTool active={tool === "arc"} icon="arc" label="Арка (3 точки)" onClick={() => switchTool("arc")} />
            <IconTool active={tool === "image"} icon="image" label="Снимка — мести/върти подложката" onClick={() => switchTool("image")} />
          </ToolGroup>
          <ToolGroup label="Стъпки">
            <IconTool icon="undo" label="Назад (Undo)" disabled={!undoStack.length} onClick={undo} />
            <IconTool icon="redo" label="Напред (Redo)" disabled={!redoStack.length} onClick={redo} />
          </ToolGroup>
          <ToolGroup label="Панели">
            <IconTool active={panelTab === "tool"} icon="cursor" label="Инструмент" onClick={() => setPanelTab("tool")} />
            <IconTool active={panelTab === "repair"} icon="fillet" label="Поправка" onClick={() => setPanelTab("repair")} />
            <IconTool active={panelTab === "transform"} icon="scale" label="Промени" onClick={() => setPanelTab("transform")} />
            <IconTool active={panelTab === "data"} icon="ruler" label="Данни" onClick={() => setPanelTab("data")} />
          </ToolGroup>
          <ToolGroup label="Прилепяне">
            <IconTool icon="arrowLeft" label="Mirror/прилепи наляво" onClick={() => mirrorToSide("left")} />
            <IconTool icon="arrowRight" label="Mirror/прилепи надясно" onClick={() => mirrorToSide("right")} />
            <IconTool icon="arrowUp" label="Mirror/прилепи нагоре" onClick={() => mirrorToSide("top")} />
            <IconTool icon="arrowDown" label="Mirror/прилепи надолу" onClick={() => mirrorToSide("bottom")} />
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
            Влачене на празно място: правоъгълник за маркиране (Shift добавя). Клик върху линията на фигура я избира цялата (синьо). Влачене на избрана точка мести цялата селекция. При изцяло избрана фигура: хвани я откъдето и да е (вкл. отвътре) и я влачи свободно. Ctrl+клик върху линия: нова точка. Ctrl+Z / Ctrl+Y: назад / напред. Delete: трие избраното (цяла фигура, ако е избрана цялата). Esc: изчиства избора. F: центрира. Скрол: zoom. Среден бутон: местене на изгледа.
          </p>
        </div>

        <div className="max-h-[85vh] overflow-y-auto pr-1">
          {/* --- Табове: всичко на едно място --- */}
          <div className="panel sticky top-0 z-10 mb-3 grid grid-cols-4 gap-1 p-1 opacity-95">
            <TabButton active={panelTab === "tool"} icon="cursor" label="Инструмент" onClick={() => setPanelTab("tool")} />
            <TabButton active={panelTab === "repair"} icon="fillet" label="Поправка" onClick={() => setPanelTab("repair")} />
            <TabButton active={panelTab === "transform"} icon="scale" label="Промени" onClick={() => setPanelTab("transform")} />
            <TabButton active={panelTab === "data"} icon="ruler" label="Данни" onClick={() => setPanelTab("data")} />
          </div>

          {panelTab === "tool" && (
            <div className="space-y-3">
              <ToolOptions
                tool={tool}
                diameter={shapeDiameter}
                unit={shapeUnit}
                selectedCount={selectedCount}
                selectedLine={selectedLine}
                selectedLinePoint={selectedLinePoint}
                polyCount={polyDraft.length}
                arcCount={arcDraft.length}
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
                onClearArc={() => setArcDraft([])}
                imgRotation={imgRotation}
                onImgRotation={setImgRotation}
                onImgReset={() => {
                  setImgOffset({ x: 0, y: 0 });
                  setImgRotation(0);
                }}
              />

              <Section title="Селекция" hint={`Избрани точки: ${selectedCount}`}>
                <div className="grid grid-cols-2 gap-2">
                  <ActionButton icon="selectAll" label="Избери всички" onClick={selectAllPoints} />
                  <ActionButton icon="deselect" label="Изчисти избора" disabled={!selectedCount} onClick={() => setSelectedPoints(new Set())} />
                  <ActionButton icon="contour" label="Целия контур" disabled={!selectedCount} onClick={selectWholeContour} />
                  <ActionButton icon="trash" label="Изтрий точките" disabled={!selectedCount} onClick={deleteSelectedPoints} />
                </div>
                <div className="mt-2">
                  <ActionButton icon="trash" label="Изтрий целия контур (дупка/фигура)" danger wide disabled={!selectedCount} onClick={deleteWholeContour} />
                </div>
              </Section>

              <Section title="Join отворени линии" hint="Свързва най-близките две отворени крайни точки">
                <div className="grid grid-cols-2 gap-2">
                  <ActionButton icon="polyline" label="Затвори с полилайн" disabled={openLines.length < 2} onClick={() => joinOpenLines("line")} />
                  <ActionButton icon="arc" label="Затвори с арка" disabled={openLines.length < 2} onClick={() => joinOpenLines("arc")} />
                </div>
              </Section>
            </div>
          )}

          {panelTab === "repair" && (
            <div className="space-y-3">
              <Section title="Избрани точки" hint="Първо маркирай точки на канваса (влачене = правоъгълник)">
                <div className="grid grid-cols-2 gap-2">
                  <ActionButton icon="straighten" label="Изправи в линия" disabled={selectedCount < 3} onClick={straightenSelected} />
                  <ActionButton icon="smooth" label="Изглади избраните" disabled={!selectedCount} onClick={smoothSelected} />
                  <ActionButton icon="fillet" label="Закръгли ъгъл" disabled={!selectedCount} onClick={filletSelected} />
                  <ActionButton icon="chamfer" label="Фаска на ъгъл" disabled={!selectedCount} onClick={chamferSelected} />
                </div>
                <NumberRow
                  label={`Радиус / фаска (${shapeUnit})`}
                  value={cornerRadius}
                  step={0.5}
                  min={0.1}
                  onChange={setCornerRadius}
                />
              </Section>

              <Section title="Целият контур" hint="Автоматично почистване на целия чертеж">
                <div className="grid grid-cols-2 gap-2">
                  <ActionButton icon="despike" label="Махни шиповете" onClick={despikeAll} />
                  <ActionButton icon="resample" label="Равни точки" onClick={resampleAll} />
                  <ActionButton
                    icon="smooth"
                    label="Изглади всичко"
                    onClick={() => {
                      applyAll((p) => chaikin(p, smoothStrength));
                      toast("Контурът е изгладен");
                    }}
                  />
                  <ActionButton
                    icon="simplify"
                    label="Опрости (по-малко точки)"
                    onClick={() => {
                      applyAll((p) => simplify(p, simplifyEps));
                      toast("Контурът е опростен");
                    }}
                  />
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <NumberRow label={`Стъпка (${shapeUnit})`} value={resampleStep} step={0.5} min={0.2} onChange={setResampleStep} />
                  <NumberRow label="Сила ×" value={smoothStrength} step={1} min={1} max={4} onChange={(v) => setSmoothStrength(Math.round(v))} />
                  <NumberRow label="Допуск (px)" value={simplifyEps} step={0.5} min={0.5} onChange={setSimplifyEps} />
                </div>
              </Section>
            </div>
          )}

          {panelTab === "transform" && (
            <div className="space-y-3">
              <Section title="Обръщане и изравняване" hint="Прилагат се върху целия чертеж">
                <div className="grid grid-cols-3 gap-2">
                  <ActionButton icon="mirrorX" label="Огледало X" onClick={() => mirror("x")} />
                  <ActionButton icon="mirrorY" label="Огледало Y" onClick={() => mirror("y")} />
                  <ActionButton icon="align" label="Изравни 0°" onClick={axisAlign} />
                </div>
              </Section>

              <Section title="Mirror копие" hint="Копира формата огледално в избраната посока">
                <div className="grid grid-cols-3 gap-2">
                  <span />
                  <ActionButton icon="arrowUp" label="Top" onClick={() => mirrorToSide("top")} />
                  <span />
                  <ActionButton icon="arrowLeft" label="Left" onClick={() => mirrorToSide("left")} />
                  <ActionButton icon="mirrorX" label="Mirror" onClick={() => mirrorToSide("right")} />
                  <ActionButton icon="arrowRight" label="Right" onClick={() => mirrorToSide("right")} />
                  <span />
                  <ActionButton icon="arrowDown" label="Bottom" onClick={() => mirrorToSide("bottom")} />
                  <span />
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <ActionButton icon="mirrorX" label="Flip Horizontal" onClick={() => mirror("x")} />
                  <ActionButton icon="mirrorY" label="Flip Vertical" onClick={() => mirror("y")} />
                </div>
                <label className="mt-3 flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={mirrorCopy} onChange={(e) => setMirrorCopy(e.target.checked)} />
                  Създай огледално копие
                </label>
                <NumberRow label={`Разстояние (${shapeUnit})`} value={mirrorGap} step={0.5} min={0} onChange={setMirrorGap} />
                <div className="mt-2 grid grid-cols-3 gap-2">
                  <ActionButton icon="magnet" label="Долепи 0" onClick={() => setMirrorGap(0)} />
                  <ActionButton icon="magnet" label={`Фуга 1 ${shapeUnit}`} onClick={() => setMirrorGap(1)} />
                  <ActionButton icon="magnet" label={`Фуга 5 ${shapeUnit}`} onClick={() => setMirrorGap(5)} />
                </div>
              </Section>

              <Section title="Мащаб" hint="Преоразмери целия чертеж">
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
                <div className="mt-2">
                  <ActionButton icon="scale" label="Приложи мащаба" primary wide onClick={applyScale} />
                </div>
              </Section>

              <Section title="Офсет / kerf" hint="+ разширява навън (дупките се свиват), − свива навътре. Компенсира дебелината на ножа/лазера.">
                <NumberRow label={`Офсет (${shapeUnit})`} value={offsetMm} step={0.1} onChange={setOffsetMm} />
                <div className="mt-2">
                  <ActionButton icon="offset" label="Приложи офсета" primary wide onClick={applyOffset} />
                </div>
              </Section>
            </div>
          )}

          {panelTab === "data" && (
            <div className="space-y-3">
              <MeasurementsPanel m={liveMeasurements} calibration={record.calibration} />
              <ExportButtons record={liveRecord} />
            </div>
          )}
        </div>
      </div>
      {nodeMenu && (
        <div
          className="fixed z-[120] w-56 rounded-lg border border-paper-3 bg-paper p-1 text-sm shadow-xl dark:border-ink-3 dark:bg-ink-2"
          style={{ left: nodeMenu.x, top: nodeMenu.y }}
        >
          <MenuItem label="to Line" hotkey="L" onClick={() => setNodeMenu(null)} />
          <MenuItem label="to Bezier" hotkey="B" onClick={() => {
            const target = nodeMenu.target;
            pushUndo();
            if (target.type === "line") {
              const line = openLines[target.li];
              if (line && target.pi > 0 && target.pi < line.length - 1) {
                const bez = bezierFrom3Points(line[target.pi - 1], line[target.pi], line[target.pi + 1], 18);
                setOpenLines(openLines.map((l, i) => i === target.li ? [...l.slice(0, target.pi - 1), ...bez, ...l.slice(target.pi + 2)] : l));
              }
            } else {
              const poly = polys[target.ci];
              if (poly && poly.length > 3) {
                const prev = (target.pi - 1 + poly.length) % poly.length;
                const next = (target.pi + 1) % poly.length;
                const bez = bezierFrom3Points(poly[prev], poly[target.pi], poly[next], 18);
                const out = [...poly];
                out.splice(Math.min(prev, target.pi), 3, ...bez);
                setPolys(polys.map((p, i) => i === target.ci ? out : p));
              }
            }
            setNodeMenu(null);
          }} />
          <MenuItem label="to Arc" hotkey="A" onClick={() => {
            const target = nodeMenu.target;
            if (target.type === "line") {
              const line = openLines[target.li];
              if (line && target.pi > 0 && target.pi < line.length - 1) {
                pushUndo();
                const arc = arcFrom3Points(line[target.pi - 1], line[target.pi], line[target.pi + 1], 18);
                setOpenLines(openLines.map((l, i) => i === target.li ? [...l.slice(0, target.pi - 1), ...arc, ...l.slice(target.pi + 2)] : l));
              }
            }
            setNodeMenu(null);
          }} />
          <MenuItem label="Insert a Point" hotkey="I" onClick={() => {
            if (nodeMenu.target.type === "line") insertLineMidpoint(nodeMenu.target.li, Math.max(0, nodeMenu.target.pi));
            setNodeMenu(null);
          }} />
          <MenuItem label="Delete Span" hotkey="D" onClick={() => {
            if (nodeMenu.target.type === "line") deleteLineSpan(nodeMenu.target.li, nodeMenu.target.pi);
            else deleteSelectedPoints();
            setNodeMenu(null);
          }} />
          <MenuItem label="Insert Midpoint" onClick={() => {
            if (nodeMenu.target.type === "line") insertLineMidpoint(nodeMenu.target.li, Math.max(0, nodeMenu.target.pi));
            setNodeMenu(null);
          }} />
          <MenuItem label="Reverse Direction" onClick={() => {
            if (nodeMenu.target.type === "line") reverseLine(nodeMenu.target.li);
            setNodeMenu(null);
          }} />
          <MenuItem label="Exit Node Edit Mode" hotkey="N" onClick={() => {
            setNodeMenu(null);
            setSelectedLine(null);
            setSelectedLinePoint(null);
            setSelectedPoints(new Set());
          }} />
        </div>
      )}
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

function MenuItem({
  label,
  hotkey,
  onClick,
}: {
  label: string;
  hotkey?: string;
  onClick: () => void;
}) {
  return (
    <button
      className="flex w-full items-center justify-between rounded px-3 py-2 text-left hover:bg-ink/5 dark:hover:bg-paper/10"
      onClick={onClick}
      type="button"
    >
      <span>{label}</span>
      {hotkey && <span className="readout text-xs text-ink/45 dark:text-paper/45">{hotkey}</span>}
    </button>
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
  selectedLine,
  selectedLinePoint,
  polyCount,
  arcCount,
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
  onClearArc,
  imgRotation,
  onImgRotation,
  onImgReset,
}: {
  tool: ToolMode;
  diameter: number;
  unit: string;
  selectedCount: number;
  selectedLine: number | null;
  selectedLinePoint: { li: number; pi: number } | null;
  polyCount: number;
  arcCount: number;
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
  onClearArc: () => void;
  imgRotation: number;
  onImgRotation: (v: number) => void;
  onImgReset: () => void;
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
        <p className="text-sm text-ink/65 dark:text-paper/65">1) Начертай линия с Полилиния ПРЕЗ контура (или с краища върху него). 2) Кликни с Ножицата върху страната, която искаш да махнеш — всичко от линията натам се изрязва и линията става новият ръб. Клик върху линия без връзки я изтрива цялата (дупка/фигура/полилиния).</p>
      )}

      {tool === "image" && (
        <div className="space-y-3">
          <p className="text-sm text-ink/65 dark:text-paper/65">
            Влачи върху чертежа, за да местиш подложната снимка. Контурите не се променят — мести се само изображението.
          </p>
          <label className="block text-xs text-ink/60 dark:text-paper/60">
            Завъртане на снимката (°)
            <input
              className="field readout mt-1"
              type="number"
              step={0.5}
              value={imgRotation}
              onChange={(e) => onImgRotation(parseFloat(e.target.value) || 0)}
            />
          </label>
          <input
            type="range"
            min={-180}
            max={180}
            step={0.5}
            value={imgRotation}
            onChange={(e) => onImgRotation(parseFloat(e.target.value))}
            className="w-full accent-dye dark:accent-dye-bright"
          />
          <button className="btn-ghost w-full" onClick={onImgReset}>
            Нулирай позицията и завъртането
          </button>
        </div>
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
          <p className="text-xs text-ink/50 dark:text-paper/50">Влачене върху чертежа разпъва фигурата свободно (призрачен изглед). Само клик поставя фигура с този диаметър.</p>
        </div>
      )}

      {tool === "polyline" && (
        <div className="space-y-2">
          <p className="text-sm text-ink/65 dark:text-paper/65">Поставени точки: {polyCount}</p>
          {selectedLine !== null && (
            <p className="rounded-lg border border-paper-3 p-2 text-xs text-ink/65 dark:border-ink-3 dark:text-paper/65">
              Избрана полилиния #{selectedLine + 1}
              {selectedLinePoint ? `, точка ${selectedLinePoint.pi + 1}` : ""}. Влачи я за свободно местене или натисни Delete за триене.
            </p>
          )}
          <button className="btn-primary w-full" disabled={polyCount < 2} onClick={onFinishPolyline}>
            <Icon name="save" /> Завърши линията
          </button>
          <button className="btn-ghost w-full" disabled={!polyCount} onClick={onClearPolyline}>
            <Icon name="trash" /> Изчисти временната линия
          </button>
        </div>
      )}

      {tool === "arc" && (
        <div className="space-y-2">
          <p className="text-sm text-ink/65 dark:text-paper/65">
            Арка: кликни 3 точки - начало, извивка и край.
          </p>
          <p className="readout text-xs text-ink/50 dark:text-paper/50">Поставени точки: {arcCount}/3</p>
          <button className="btn-ghost w-full" disabled={!arcCount} onClick={onClearArc}>
            <Icon name="trash" /> Изчисти арката
          </button>
        </div>
      )}
    </section>
  );
}

/** Таб в обединения десен панел. */
function TabButton({
  icon,
  label,
  active,
  onClick,
}: {
  icon: IconName;
  label: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={`flex flex-col items-center gap-1 rounded-lg px-1 py-2 text-[11px] font-medium leading-none transition-colors ${
        active
          ? "bg-dye text-white dark:bg-dye-bright dark:text-ink"
          : "text-ink/60 hover:bg-ink/5 dark:text-paper/60 dark:hover:bg-paper/5"
      }`}
      onClick={onClick}
    >
      <Icon name={icon} />
      {label}
    </button>
  );
}

/** Едър, разбираем бутон за действие: икона отгоре, текст отдолу. */
function ActionButton({
  icon,
  label,
  onClick,
  disabled,
  danger,
  primary,
  wide,
}: {
  icon: IconName;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  primary?: boolean;
  wide?: boolean;
}) {
  const tone = primary
    ? "border-dye bg-dye text-white hover:bg-dye/90 dark:border-dye-bright dark:bg-dye-bright dark:text-ink"
    : danger
      ? "border-red-300 text-red-600 hover:bg-red-500/10 dark:border-red-900 dark:text-red-400"
      : "border-paper-3 bg-paper-2 hover:bg-ink/5 dark:border-ink-3 dark:bg-ink-2 dark:hover:bg-paper/5";
  return (
    <button
      className={`flex min-h-16 flex-col items-center justify-center gap-1.5 rounded-lg border px-2 py-2.5 text-center text-xs leading-tight transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${tone} ${wide ? "w-full" : ""}`}
      disabled={disabled}
      onClick={onClick}
      title={label}
    >
      <Icon name={icon} />
      {label}
    </button>
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
  | "arc"
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
  | "arrowUp"
  | "arrowDown"
  | "arrowLeft"
  | "arrowRight"
  | "align"
  | "scale"
  | "offset"
  | "fullscreen"
  | "exitFullscreen"
  | "ruler"
  | "image";

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
      {name === "arc" && <path {...common} d="M5 17 Q12 4 19 17M5 17h0M12 8h0M19 17h0" />}
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
      {name === "arrowUp" && <path {...common} d="M12 20V4M6 10l6-6 6 6" />}
      {name === "arrowDown" && <path {...common} d="M12 4v16M6 14l6 6 6-6" />}
      {name === "arrowLeft" && <path {...common} d="M20 12H4M10 6l-6 6 6 6" />}
      {name === "arrowRight" && <path {...common} d="M4 12h16M14 6l6 6-6 6" />}
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
      {name === "image" && (
        <>
          <rect {...common} x="3.5" y="5" width="17" height="14" rx="2" />
          <circle {...common} cx="8.5" cy="10" r="1.6" />
          <path {...common} d="m6 18 4.5-4.5 3 3L17 13l3.5 3.5" />
        </>
      )}
      {name === "ruler" && (
        <>
          <rect {...common} x="3" y="9" width="18" height="6" rx="1" transform="rotate(-20 12 12)" />
          <path {...common} d="m7.5 13.5 1-2.7M11 12.2l1-2.7M14.5 11l1-2.7" transform="rotate(0)" />
        </>
      )}
    </svg>
  );
}
