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

/* ------------------------- contour repair toolkit ------------------------- */

/** Local smoothing: moving-average applied only to the given indices (closed polygon). */
export function smoothIndices(pts: Pt[], indices: Set<number>, strength = 0.5): Pt[] {
  const n = pts.length;
  if (n < 3) return pts;
  return pts.map((p, i) => {
    if (!indices.has(i)) return p;
    const prev = pts[(i - 1 + n) % n];
    const next = pts[(i + 1) % n];
    const mx = (prev.x + next.x) / 2;
    const my = (prev.y + next.y) / 2;
    return { x: p.x + (mx - p.x) * strength, y: p.y + (my - p.y) * strength };
  });
}

/**
 * Straighten: project every selected point between the first and last selected
 * index onto the straight chord connecting them. Fixes wobbly edges.
 */
export function straighten(pts: Pt[], indices: number[]): Pt[] {
  if (indices.length < 3) return pts;
  const sorted = [...indices].sort((a, b) => a - b);
  const a = pts[sorted[0]];
  const b = pts[sorted[sorted.length - 1]];
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy || 1;
  const idx = new Set(sorted.slice(1, -1));
  return pts.map((p, i) => {
    if (!idx.has(i)) return p;
    const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
    return { x: a.x + t * dx, y: a.y + t * dy };
  });
}

/** Round one corner with an arc of radius r. Returns a new point array. */
export function filletCorner(pts: Pt[], i: number, r: number): Pt[] {
  const n = pts.length;
  if (n < 3 || r <= 0) return pts;
  const A = pts[(i - 1 + n) % n];
  const B = pts[i];
  const C = pts[(i + 1) % n];
  const v1 = { x: A.x - B.x, y: A.y - B.y };
  const v2 = { x: C.x - B.x, y: C.y - B.y };
  const l1 = Math.hypot(v1.x, v1.y);
  const l2 = Math.hypot(v2.x, v2.y);
  if (l1 < 1e-6 || l2 < 1e-6) return pts;
  const u1 = { x: v1.x / l1, y: v1.y / l1 };
  const u2 = { x: v2.x / l2, y: v2.y / l2 };
  const dot = Math.max(-1, Math.min(1, u1.x * u2.x + u1.y * u2.y));
  const theta = Math.acos(dot); // corner angle
  if (theta < 0.05 || theta > Math.PI - 0.05) return pts; // (almost) straight or degenerate
  // Tangent length from the corner, clamped so we never eat a whole edge.
  let t = r / Math.tan(theta / 2);
  const tMax = 0.45 * Math.min(l1, l2);
  if (t > tMax) {
    t = tMax;
    r = t * Math.tan(theta / 2);
  }
  const P1 = { x: B.x + u1.x * t, y: B.y + u1.y * t }; // tangent point on BA
  const P2 = { x: B.x + u2.x * t, y: B.y + u2.y * t }; // tangent point on BC
  // Arc centre lies along the angle bisector.
  const bis = { x: u1.x + u2.x, y: u1.y + u2.y };
  const bl = Math.hypot(bis.x, bis.y) || 1;
  const d = r / Math.sin(theta / 2);
  const O = { x: B.x + (bis.x / bl) * d, y: B.y + (bis.y / bl) * d };
  // Sweep the arc from P1 to P2 around O.
  const a1 = Math.atan2(P1.y - O.y, P1.x - O.x);
  const a2 = Math.atan2(P2.y - O.y, P2.x - O.x);
  let sweep = a2 - a1;
  while (sweep > Math.PI) sweep -= 2 * Math.PI;
  while (sweep < -Math.PI) sweep += 2 * Math.PI;
  const steps = Math.max(2, Math.ceil(Math.abs(sweep) / (Math.PI / 18))); // ~10° per step
  const arc: Pt[] = [];
  for (let s = 0; s <= steps; s++) {
    const a = a1 + (sweep * s) / steps;
    arc.push({ x: O.x + Math.cos(a) * r, y: O.y + Math.sin(a) * r });
  }
  const out = [...pts];
  out.splice(i, 1, ...arc);
  return out;
}

/** Chamfer: cut the corner with a straight edge at distance d along both sides. */
export function chamferCorner(pts: Pt[], i: number, d: number): Pt[] {
  const n = pts.length;
  if (n < 3 || d <= 0) return pts;
  const A = pts[(i - 1 + n) % n];
  const B = pts[i];
  const C = pts[(i + 1) % n];
  const l1 = Math.hypot(A.x - B.x, A.y - B.y);
  const l2 = Math.hypot(C.x - B.x, C.y - B.y);
  if (l1 < 1e-6 || l2 < 1e-6) return pts;
  const t1 = Math.min(d, 0.45 * l1);
  const t2 = Math.min(d, 0.45 * l2);
  const P1 = { x: B.x + ((A.x - B.x) / l1) * t1, y: B.y + ((A.y - B.y) / l1) * t1 };
  const P2 = { x: B.x + ((C.x - B.x) / l2) * t2, y: B.y + ((C.y - B.y) / l2) * t2 };
  const out = [...pts];
  out.splice(i, 1, P1, P2);
  return out;
}

/**
 * Remove needle-like spikes: points whose corner angle is sharper than
 * minAngleDeg. Runs several passes until stable. Great for scan artefacts.
 */
export function despike(pts: Pt[], minAngleDeg = 25): Pt[] {
  let cur = pts;
  const minAngle = (minAngleDeg * Math.PI) / 180;
  for (let pass = 0; pass < 5; pass++) {
    const n = cur.length;
    if (n <= 4) break;
    const keep: Pt[] = [];
    let removed = 0;
    for (let i = 0; i < n; i++) {
      const A = cur[(i - 1 + n) % n];
      const B = cur[i];
      const C = cur[(i + 1) % n];
      const v1 = { x: A.x - B.x, y: A.y - B.y };
      const v2 = { x: C.x - B.x, y: C.y - B.y };
      const l1 = Math.hypot(v1.x, v1.y) || 1;
      const l2 = Math.hypot(v2.x, v2.y) || 1;
      const dot = Math.max(-1, Math.min(1, (v1.x * v2.x + v1.y * v2.y) / (l1 * l2)));
      const angle = Math.acos(dot);
      if (angle < minAngle && n - removed > 4) {
        removed++;
        continue; // spike — drop the point
      }
      keep.push(B);
    }
    if (!removed) break;
    cur = keep;
  }
  return cur;
}

/** Resample a closed polygon with (approximately) equal spacing between points. */
export function resampleClosed(pts: Pt[], spacing: number): Pt[] {
  const n = pts.length;
  if (n < 3 || spacing <= 0) return pts;
  const total = polygonPerimeter(pts);
  const count = Math.max(8, Math.round(total / spacing));
  const step = total / count;
  const out: Pt[] = [];
  let acc = 0; // distance travelled since last emitted point
  let need = 0; // next emission distance
  out.push({ ...pts[0] });
  need = step;
  let travelled = 0;
  for (let i = 0; i < n && out.length < count; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const segLen = Math.hypot(b.x - a.x, b.y - a.y);
    while (travelled + segLen >= need && out.length < count) {
      const t = (need - travelled) / segLen;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      need += step;
    }
    travelled += segLen;
    acc = travelled;
  }
  void acc;
  return out;
}

/**
 * Offset (inflate/deflate) a closed polygon by delta using mitred vertex
 * normals. Positive delta always grows the shape. Used for kerf compensation.
 */
export function offsetPolygon(pts: Pt[], delta: number): Pt[] {
  const n = pts.length;
  if (n < 3 || delta === 0) return pts;
  const offsetWith = (sign: number): Pt[] =>
    pts.map((B, i) => {
      const A = pts[(i - 1 + n) % n];
      const C = pts[(i + 1) % n];
      // Edge normals (rotated segment directions).
      const e1 = { x: B.x - A.x, y: B.y - A.y };
      const e2 = { x: C.x - B.x, y: C.y - B.y };
      const l1 = Math.hypot(e1.x, e1.y) || 1;
      const l2 = Math.hypot(e2.x, e2.y) || 1;
      const n1 = { x: e1.y / l1, y: -e1.x / l1 };
      const n2 = { x: e2.y / l2, y: -e2.x / l2 };
      let mx = n1.x + n2.x;
      let my = n1.y + n2.y;
      const ml = Math.hypot(mx, my);
      if (ml < 1e-6) {
        mx = n1.x;
        my = n1.y;
      } else {
        mx /= ml;
        my /= ml;
      }
      // Miter scale, clamped to avoid explosions on sharp corners.
      const cosHalf = Math.max(0.25, (mx * n1.x + my * n1.y) || 1);
      const dist = (delta * sign) / cosHalf;
      return { x: B.x + mx * dist, y: B.y + my * dist };
    });
  // Orientation-agnostic: pick the sign that actually grows the polygon.
  const grown = offsetWith(1);
  return polygonArea(grown) >= polygonArea(pts) === delta > 0 ? grown : offsetWith(-1);
}

/** Uniform scale around a centre point. */
export function scaleAround(pts: Pt[], center: Pt, factor: number): Pt[] {
  return pts.map((p) => ({
    x: center.x + (p.x - center.x) * factor,
    y: center.y + (p.y - center.y) * factor,
  }));
}

/** Ray-casting point-in-polygon test. */
export function pointInPolygon(p: Pt, pts: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i];
    const b = pts[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/* --------------------- CNC ъглови прорези (fillet типове) --------------------- */

/** Дъга около център O от точка from до to, минаваща откъм страната на via. */
function arcVia(O: Pt, r: number, from: Pt, to: Pt, via: Pt, steps = 20): Pt[] {
  const TAU = Math.PI * 2;
  const norm = (x: number) => ((x % TAU) + TAU) % TAU;
  const a1 = Math.atan2(from.y - O.y, from.x - O.x);
  const a2 = Math.atan2(to.y - O.y, to.x - O.x);
  const av = Math.atan2(via.y - O.y, via.x - O.x);
  const fwd = norm(a2 - a1) || TAU;
  const sweep = norm(av - a1) <= fwd ? fwd : fwd - TAU;
  return Array.from({ length: steps + 1 }, (_, s) => {
    const a = a1 + (sweep * s) / steps;
    return { x: O.x + Math.cos(a) * r, y: O.y + Math.sin(a) * r };
  });
}

/** Локална геометрия на ъгъл i: съседи, единични посоки, ъгъл и бисектриса. */
function cornerFrame(pts: Pt[], i: number) {
  const n = pts.length;
  if (n < 3) return null;
  const A = pts[(i - 1 + n) % n];
  const B = pts[i];
  const C = pts[(i + 1) % n];
  const l1 = Math.hypot(A.x - B.x, A.y - B.y);
  const l2 = Math.hypot(C.x - B.x, C.y - B.y);
  if (l1 < 1e-6 || l2 < 1e-6) return null;
  const u1 = { x: (A.x - B.x) / l1, y: (A.y - B.y) / l1 };
  const u2 = { x: (C.x - B.x) / l2, y: (C.y - B.y) / l2 };
  const dot = Math.max(-1, Math.min(1, u1.x * u2.x + u1.y * u2.y));
  const theta = Math.acos(dot);
  const bl = Math.hypot(u1.x + u2.x, u1.y + u2.y);
  if (theta < 0.05 || theta > Math.PI - 0.05 || bl < 1e-6) return null;
  const bis = { x: (u1.x + u2.x) / bl, y: (u1.y + u2.y) / bl };
  return { A, B, C, u1, u2, l1, l2, theta, bis };
}

/**
 * Dog-Bone прорез: кръгъл джоб с радиуса на инструмента, вкопан по
 * бисектрисата НАВЪН от клина на ъгъла (в материала), така че фрезата
 * да изчисти вътрешния ъгъл и сглобките да пасват.
 */
export function dogboneCorner(pts: Pt[], i: number, r: number): Pt[] {
  const f = cornerFrame(pts, i);
  if (!f || r <= 0) return pts;
  const { B, bis } = f;
  const O = { x: B.x - bis.x * r, y: B.y - bis.y * r };
  const deep = { x: B.x - bis.x * 2 * r, y: B.y - bis.y * 2 * r };
  const loop = arcVia(O, r, B, B, deep, 24);
  const out = [...pts];
  out.splice(i, 1, ...loop);
  return out;
}

/**
 * T-Bone прорез: полукръгъл джоб, легнал върху избраната страна на ъгъла
 * (side), с издуване към материала. Ползва се, когато слотът е широк
 * точно колкото инструмента.
 */
export function tboneCorner(pts: Pt[], i: number, r: number, side: "prev" | "next"): Pt[] {
  const f = cornerFrame(pts, i);
  if (!f || r <= 0) return pts;
  const { B, u1, u2, l1, l2, bis } = f;
  const uE = side === "prev" ? u1 : u2;
  const lE = side === "prev" ? l1 : l2;
  const reach = Math.min(2 * r, lE * 0.9);
  if (reach < 1e-6) return pts;
  const rr = reach / 2;
  const O = { x: B.x + uE.x * rr, y: B.y + uE.y * rr };
  const I = { x: B.x + uE.x * reach, y: B.y + uE.y * reach };
  // Перпендикуляр към страната, сочещ обратно на клина (към материала).
  const d = uE.x * bis.x + uE.y * bis.y;
  let nx = -bis.x + uE.x * d;
  let ny = -bis.y + uE.y * d;
  const nl = Math.hypot(nx, ny);
  if (nl < 1e-6) return pts;
  nx /= nl;
  ny /= nl;
  const via = { x: O.x + nx * rr, y: O.y + ny * rr };
  const arc = side === "prev" ? arcVia(O, rr, I, B, via, 16) : arcVia(O, rr, B, I, via, 16);
  const out = [...pts];
  out.splice(i, 1, ...arc);
  return out;
}

/**
 * Плазма/влачещ нож: външно заобляне — контурът продължава ПОКРАЙ ъгъла и
 * прави дъга-примка от външната страна, тангентна към двете страни, за да
 * не се разтапя/дере ъгълът при рязане.
 */
export function plasmaCorner(pts: Pt[], i: number, r: number): Pt[] {
  const f = cornerFrame(pts, i);
  if (!f || r <= 0) return pts;
  const { B, u1, u2, theta, bis } = f;
  const t = r / Math.tan(theta / 2);
  const d = r / Math.sin(theta / 2);
  const P1 = { x: B.x - u1.x * t, y: B.y - u1.y * t };
  const P2 = { x: B.x - u2.x * t, y: B.y - u2.y * t };
  const O = { x: B.x - bis.x * d, y: B.y - bis.y * d };
  const far = { x: O.x + ((O.x - B.x) / d) * r, y: O.y + ((O.y - B.y) / d) * r };
  const arc = arcVia(O, r, P1, P2, far, 24);
  const out = [...pts];
  out.splice(i, 1, ...arc);
  return out;
}
