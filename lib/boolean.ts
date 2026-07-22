import polygonClipping from "polygon-clipping";
import type { Pt } from "./types";

type Ring = [number, number][];

export interface UnionResult {
  /** Външният пръстен на получената фигура. */
  exterior: Pt[];
  /** Дупки, възникнали при обединението (напр. затворен процеп между фигурите). */
  holes: Pt[][];
}

/**
 * Заваряване: точки от различни фигури, които са почти една върху друга
 * (до tol), се изравняват точно. Така "долепени" фигури от mirror или от
 * магнитното прилепяне се обединяват чисто, без микроскопични процепи.
 */
export function weldShapes(shapes: Pt[][], tol: number): Pt[][] {
  if (tol <= 0) return shapes;
  const out = shapes.map((shape) => shape.map((p) => ({ ...p })));
  for (let i = 1; i < out.length; i++) {
    const anchors = out.slice(0, i).flat();
    for (const p of out[i]) {
      let best: Pt | null = null;
      let bestDist = tol;
      for (const a of anchors) {
        const d = Math.hypot(a.x - p.x, a.y - p.y);
        if (d < bestDist) {
          bestDist = d;
          best = a;
        }
      }
      if (best) {
        p.x = best.x;
        p.y = best.y;
      }
    }
  }
  return out;
}

const toRing = (shape: Pt[]): Ring => {
  const ring: Ring = shape.map((p) => [p.x, p.y]);
  ring.push([shape[0].x, shape[0].y]);
  return ring;
};

const fromRing = (ring: Ring): Pt[] => {
  const pts = ring.map(([x, y]) => ({ x, y }));
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (first && last && first.x === last.x && first.y === last.y) pts.pop();
  return pts;
};

/**
 * Булево обединение на затворени фигури (Martinez-Rueda чрез polygon-clipping —
 * коректно и при общи ръбове/върхове). Връща списък от резултатни фигури:
 * допиращи се или застъпващи се входове стават ЕДНА фигура; несвързаните
 * остават отделни. null при невалиден вход или грешка.
 */
export function unionShapes(shapes: Pt[][], weldTol = 0): UnionResult[] | null {
  const cleaned = weldShapes(shapes, weldTol).filter((s) => s.length >= 3);
  if (cleaned.length < 2) return null;
  try {
    const geoms = cleaned.map((s) => [toRing(s)]);
    const result = polygonClipping.union(geoms[0], ...geoms.slice(1));
    const merged = result
      .map((poly) => {
        const [exterior, ...holes] = poly.map(fromRing);
        return { exterior, holes: holes.filter((h) => h.length >= 3) };
      })
      .filter((p) => p.exterior.length >= 3);
    return merged.length ? merged : null;
  } catch {
    return null;
  }
}
