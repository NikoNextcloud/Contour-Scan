import type { ContourSet, Pt, ScanRecord } from "./types";
import { measure } from "./geometry";

/** Convert pixel points to millimetres (Y flipped for CAD coordinate systems). */
function toMm(pts: Pt[], mmPerPx: number, imageH: number): Pt[] {
  return pts.map((p) => ({ x: p.x * mmPerPx, y: (imageH - p.y) * mmPerPx }));
}

/**
 * Minimal DXF R12 writer.
 * One closed POLYLINE per contour on colour-coded layers:
 * OUTER = blue (5), INNER = red (1). Units follow the calibration (mm) or raw px.
 */
export function toDXF(contours: ContourSet, mmPerPx: number, imageH: number): string {
  const lines: string[] = [];
  const push = (...v: (string | number)[]) => lines.push(...v.map(String));

  push(0, "SECTION", 2, "HEADER", 9, "$ACADVER", 1, "AC1009", 0, "ENDSEC");
  push(0, "SECTION", 2, "TABLES", 0, "TABLE", 2, "LAYER", 70, 2);
  push(0, "LAYER", 2, "OUTER", 70, 0, 62, 5, 6, "CONTINUOUS");
  push(0, "LAYER", 2, "INNER", 70, 0, 62, 1, 6, "CONTINUOUS");
  push(0, "ENDTAB", 0, "ENDSEC");
  push(0, "SECTION", 2, "ENTITIES");

  const writePolyline = (pts: Pt[], layer: string) => {
    push(0, "POLYLINE", 8, layer, 66, 1, 70, 1); // 70=1 → closed
    for (const p of pts) {
      push(0, "VERTEX", 8, layer, 10, p.x.toFixed(4), 20, p.y.toFixed(4), 30, 0);
    }
    push(0, "SEQEND");
  };

  writePolyline(toMm(contours.outer, mmPerPx, imageH), "OUTER");
  for (const hole of contours.inner) writePolyline(toMm(hole, mmPerPx, imageH), "INNER");

  push(0, "ENDSEC", 0, "EOF");
  return lines.join("\n");
}

/** SVG with physical mm dimensions — imports at real size in Illustrator/Inkscape/cutters. */
export function toSVG(contours: ContourSet, mmPerPx: number, imageSize: { w: number; h: number }): string {
  const wMm = imageSize.w * mmPerPx;
  const hMm = imageSize.h * mmPerPx;
  const path = (pts: Pt[]) =>
    "M " +
    pts.map((p) => `${(p.x * mmPerPx).toFixed(3)} ${(p.y * mmPerPx).toFixed(3)}`).join(" L ") +
    " Z";
  const inner = contours.inner
    .map((c) => `  <path d="${path(c)}" fill="none" stroke="#dc2626" stroke-width="0.2"/>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${wMm.toFixed(2)}mm" height="${hMm.toFixed(2)}mm" viewBox="0 0 ${wMm.toFixed(3)} ${hMm.toFixed(3)}">
  <path d="${path(contours.outer)}" fill="none" stroke="#1d4ed8" stroke-width="0.2"/>
${inner}
</svg>`;
}

/** Render contours to a transparent PNG at the source image resolution. */
export function toPNG(contours: ContourSet, imageSize: { w: number; h: number }): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = imageSize.w;
  canvas.height = imageSize.h;
  const ctx = canvas.getContext("2d")!;
  const draw = (pts: Pt[], color: string) => {
    ctx.beginPath();
    pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.closePath();
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(2, imageSize.w / 600);
    ctx.stroke();
  };
  draw(contours.outer, "#1d4ed8");
  contours.inner.forEach((c) => draw(c, "#dc2626"));
  return new Promise((resolve) =>
    canvas.toBlob((b) => resolve(b as Blob), "image/png")
  );
}

/** Full machine-readable scan export. */
export function toJSON(record: ScanRecord): string {
  const m = record.measurements;
  const k = record.calibration?.mmPerPx ?? null;
  return JSON.stringify(
    {
      name: record.name,
      createdAt: new Date(record.createdAt).toISOString(),
      calibration: record.calibration,
      imageSize: record.imageSize,
      measurements: {
        px: m,
        mm: k
          ? {
              width: m.widthPx * k,
              height: m.heightPx * k,
              areaMm2: m.areaPx * k * k,
              perimeter: m.perimeterPx * k,
              circleDiameter: m.circleDiameterPx * k,
              minRect: { w: m.minRect.w * k, h: m.minRect.h * k, angleDeg: m.minRect.angleDeg },
            }
          : null,
      },
      contours: record.contours,
    },
    null,
    2
  );
}

/** CSV of the measurements — easy to paste into a spreadsheet or price list. */
export function toCSV(record: ScanRecord): string {
  const m = measure(record.contours);
  const k = record.calibration?.mmPerPx ?? 0;
  const rows: string[][] = [
    ["metric", "px", "mm"],
    ["width", m.widthPx.toFixed(1), k ? (m.widthPx * k).toFixed(2) : ""],
    ["height", m.heightPx.toFixed(1), k ? (m.heightPx * k).toFixed(2) : ""],
    ["perimeter", m.perimeterPx.toFixed(1), k ? (m.perimeterPx * k).toFixed(2) : ""],
    ["area", m.areaPx.toFixed(0), k ? (m.areaPx * k * k).toFixed(2) : ""],
    ["circle_diameter", m.circleDiameterPx.toFixed(1), k ? (m.circleDiameterPx * k).toFixed(2) : ""],
    ["min_rect_w", m.minRect.w.toFixed(1), k ? (m.minRect.w * k).toFixed(2) : ""],
    ["min_rect_h", m.minRect.h.toFixed(1), k ? (m.minRect.h * k).toFixed(2) : ""],
    ["min_rect_angle_deg", m.minRect.angleDeg.toFixed(2), ""],
    ["aspect_ratio", m.aspectRatio.toFixed(3), ""],
    ["holes", String(m.holeCount), ""],
  ];
  return rows.map((r) => r.join(",")).join("\n");
}

/** Trigger a browser download for text or binary content. */
export function download(content: string | Blob, filename: string, mime = "text/plain") {
  const blob = typeof content === "string" ? new Blob([content], { type: mime }) : content;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
