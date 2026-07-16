import type { Pt, MeasurementsPx, ContourSet } from "./types";

/** Signed polygon area (shoelace). Positive = counter-clockwise. */
export function signedArea(pts: Pt[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

/** Absolute polygon area. */
export function polygonArea(pts: Pt[]): number {
  return Math.abs(signedArea(pts));
}

/** Closed polygon perimeter. */
export function polygonPerimeter(pts: Pt[]): number {
  let p = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    p += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return p;
}

/** Axis-aligned bounding box. */
export function boundingBox(pts: Pt[]): { x: number; y: number; w: number; h: number } {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** Convex hull (Andrew's monotone chain). */
export function convexHull(points: Pt[]): Pt[] {
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length <= 2) return pts;
  const cross = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Pt[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0)
      lower.pop();
    lower.push(p);
  }
  const upper: Pt[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0)
      upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/**
 * Minimum-area rotated rectangle via rotating calipers over the convex hull.
 * Returns width/height (unordered) and the rectangle angle in degrees.
 */
export function minAreaRect(points: Pt[]): { w: number; h: number; angleDeg: number } {
  const hull = convexHull(points);
  if (hull.length < 3) {
    const bb = boundingBox(points);
    return { w: bb.w, h: bb.h, angleDeg: 0 };
  }
  let best = { area: Infinity, w: 0, h: 0, angle: 0 };
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    const angle = Math.atan2(b.y - a.y, b.x - a.x);
    const cos = Math.cos(-angle);
    const sin = Math.sin(-angle);
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const p of hull) {
      const x = p.x * cos - p.y * sin;
      const y = p.x * sin + p.y * cos;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    const w = maxX - minX;
    const h = maxY - minY;
    if (w * h < best.area) best = { area: w * h, w, h, angle };
  }
  return { w: best.w, h: best.h, angleDeg: (best.angle * 180) / Math.PI };
}

/** Full measurement set for a contour set, in pixels. */
export function measure(contours: ContourSet): MeasurementsPx {
  const outer = contours.outer;
  const bbox = boundingBox(outer);
  const grossArea = polygonArea(outer);
  // Net area = outer minus holes, which is what matters for material usage.
  const holesArea = contours.inner.reduce((s, c) => s + polygonArea(c), 0);
  const area = Math.max(0, grossArea - holesArea);
  const rect = minAreaRect(outer);
  const long = Math.max(rect.w, rect.h);
  const short = Math.min(rect.w, rect.h) || 1;
  return {
    widthPx: bbox.w,
    heightPx: bbox.h,
    areaPx: area,
    perimeterPx: polygonPerimeter(outer),
    bbox,
    minRect: rect,
    circleDiameterPx: 2 * Math.sqrt(grossArea / Math.PI),
    aspectRatio: long / short,
    holeCount: contours.inner.length,
  };
}

/** One iteration of Chaikin corner-cutting (closed polygon). */
export function chaikin(pts: Pt[], iterations = 1): Pt[] {
  let cur = pts;
  for (let it = 0; it < iterations; it++) {
    if (cur.length < 3) return cur;
    const next: Pt[] = [];
    for (let i = 0; i < cur.length; i++) {
      const a = cur[i];
      const b = cur[(i + 1) % cur.length];
      next.push({ x: 0.75 * a.x + 0.25 * b.x, y: 0.75 * a.y + 0.25 * b.y });
      next.push({ x: 0.25 * a.x + 0.75 * b.x, y: 0.25 * a.y + 0.75 * b.y });
    }
    cur = next;
  }
  return cur;
}

export function smoothContourSet(contours: ContourSet, iterations: number): ContourSet {
  const safeIterations = Math.max(0, Math.min(5, Math.round(iterations)));
  if (safeIterations <= 0) return contours;
  return {
    outer: chaikin(contours.outer, safeIterations),
    inner: contours.inner.map((hole) => chaikin(hole, Math.max(0, safeIterations - 1))),
    polylines: contours.polylines,
  };
}

export function mirrorContourSet(
  contours: ContourSet,
  mode: "off" | "leftToRight" | "rightToLeft" | "topToBottom" | "bottomToTop"
): ContourSet {
  if (mode === "off" || contours.outer.length < 6) return contours;
  const outer = mirrorClosedContour(contours.outer, mode);
  if (outer.length < 3) return contours;
  return {
    outer,
    inner: mirrorInnerContours(contours.inner, mode),
    polylines: contours.polylines,
  };
}

function mirrorInnerContours(
  holes: Pt[][],
  mode: "leftToRight" | "rightToLeft" | "topToBottom" | "bottomToTop"
): Pt[][] {
  return holes.flatMap((hole) => {
    if (hole.length < 3) return [];
    const box = boundingBox(hole);
    const center = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
    const axis = mirrorAxisForPoints(hole, mode);
    const mirrored = hole.map((point) => mirrorPoint(point, axis, mode)).reverse();
    if (mode === "leftToRight" && center.x > axis) return [mirrored];
    if (mode === "rightToLeft" && center.x < axis) return [mirrored];
    if (mode === "topToBottom" && center.y > axis) return [mirrored];
    if (mode === "bottomToTop" && center.y < axis) return [mirrored];
    return [hole, mirrored];
  });
}

function mirrorClosedContour(
  points: Pt[],
  mode: "leftToRight" | "rightToLeft" | "topToBottom" | "bottomToTop"
): Pt[] {
  const axis = mirrorAxisForPoints(points, mode);
  const source = points.filter((point) => isSourceSide(point, axis, mode));
  if (source.length < 3 || source.length < points.length * 0.18) return points;

  const sorted = [...source].sort((a, b) => {
    if (mode === "leftToRight" || mode === "rightToLeft") return a.y - b.y || a.x - b.x;
    return a.x - b.x || a.y - b.y;
  });
  const mirrored = sorted.map((point) => mirrorPoint(point, axis, mode)).reverse();
  return dedupePoints(sorted.concat(mirrored), 0.75);
}

function mirrorAxisForPoints(
  points: Pt[],
  mode: "leftToRight" | "rightToLeft" | "topToBottom" | "bottomToTop"
): number {
  const box = boundingBox(points);
  return mode === "leftToRight" || mode === "rightToLeft" ? box.x + box.w / 2 : box.y + box.h / 2;
}

function isSourceSide(
  point: Pt,
  axis: number,
  mode: "leftToRight" | "rightToLeft" | "topToBottom" | "bottomToTop"
): boolean {
  if (mode === "leftToRight") return point.x <= axis;
  if (mode === "rightToLeft") return point.x >= axis;
  if (mode === "topToBottom") return point.y <= axis;
  return point.y >= axis;
}

function mirrorPoint(
  point: Pt,
  axis: number,
  mode: "leftToRight" | "rightToLeft" | "topToBottom" | "bottomToTop"
): Pt {
  if (mode === "leftToRight" || mode === "rightToLeft") {
    return { x: axis * 2 - point.x, y: point.y };
  }
  return { x: point.x, y: axis * 2 - point.y };
}

function dedupePoints(points: Pt[], minDistance: number): Pt[] {
  const out: Pt[] = [];
  for (const point of points) {
    const prev = out[out.length - 1];
    if (!prev || Math.hypot(point.x - prev.x, point.y - prev.y) >= minDistance) {
      out.push(point);
    }
  }
  const first = out[0];
  const last = out[out.length - 1];
  if (first && last && Math.hypot(first.x - last.x, first.y - last.y) < minDistance) out.pop();
  return out;
}

/** Ramer–Douglas–Peucker simplification for a closed polygon. */
export function simplify(pts: Pt[], epsilon: number): Pt[] {
  if (pts.length < 4 || epsilon <= 0) return pts;
  // Split the closed polygon at its two most distant points and simplify each half.
  let iA = 0,
    iB = 0,
    maxD = -1;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + Math.floor(pts.length / 2)) % pts.length;
    const d = Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y);
    if (d > maxD) {
      maxD = d;
      iA = Math.min(i, j);
      iB = Math.max(i, j);
    }
  }
  const half1 = pts.slice(iA, iB + 1);
  const half2 = pts.slice(iB).concat(pts.slice(0, iA + 1));
  const out = rdp(half1, epsilon).slice(0, -1).concat(rdp(half2, epsilon).slice(0, -1));
  return out.length >= 3 ? out : pts;
}

function rdp(pts: Pt[], eps: number): Pt[] {
  if (pts.length < 3) return pts;
  const a = pts[0];
  const b = pts[pts.length - 1];
  let maxD = 0,
    idx = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = pointToSegment(pts[i], a, b);
    if (d > maxD) {
      maxD = d;
      idx = i;
    }
  }
  if (maxD <= eps) return [a, b];
  const left = rdp(pts.slice(0, idx + 1), eps);
  const right = rdp(pts.slice(idx), eps);
  return left.slice(0, -1).concat(right);
}

/** Distance from point p to segment a-b. */
export function pointToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Index of the segment (i -> i+1) closest to point p, plus the distance. */
export function nearestSegment(pts: Pt[], p: Pt): { index: number; dist: number } {
  let best = { index: 0, dist: Infinity };
  for (let i = 0; i < pts.length; i++) {
    const d = pointToSegment(p, pts[i], pts[(i + 1) % pts.length]);
    if (d < best.dist) best = { index: i, dist: d };
  }
  return best;
}
