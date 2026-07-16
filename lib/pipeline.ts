import type { ContourSet, PipelineParams, Pt } from "./types";

/** Longest image side we feed into OpenCV; larger inputs are downscaled for speed. */
export const MAX_PROCESS_SIDE = 2400;

/**
 * Load a File/Blob into an ImageData, downscaling to MAX_PROCESS_SIDE.
 * Returns the (possibly scaled) ImageData plus the original dimensions.
 */
export async function fileToImageData(
  file: Blob
): Promise<{ imageData: ImageData; originalW: number; originalH: number; scale: number }> {
  const bitmap = await createImageBitmap(file);
  const originalW = bitmap.width;
  const originalH = bitmap.height;
  const scale = Math.min(1, MAX_PROCESS_SIDE / Math.max(originalW, originalH));
  const w = Math.round(originalW * scale);
  const h = Math.round(originalH * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  return { imageData: ctx.getImageData(0, 0, w, h), originalW, originalH, scale };
}

/**
 * Full detection pipeline:
 * grayscale → blur → threshold (Otsu / adaptive) → auto-invert → morphology →
 * findContours (RETR_CCOMP) → largest top-level contour + its holes → approxPolyDP.
 */
export function detectContours(cv: any, imageData: ImageData, params: PipelineParams): ContourSet {
  const src = cv.matFromImageData(imageData);
  const gray = new cv.Mat();
  const bin = new cv.Mat();
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  const mats: any[] = [src, gray, bin, hierarchy];

  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

    // 1. Noise reduction
    const k = Math.max(1, params.blur | 1); // force odd
    if (k > 1) cv.GaussianBlur(gray, gray, new cv.Size(k, k), 0);

    // 2. Binarisation
    if (params.threshold === "adaptive") {
      cv.adaptiveThreshold(
        gray,
        bin,
        255,
        cv.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv.THRESH_BINARY,
        31,
        5
      );
    } else {
      cv.threshold(gray, bin, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
    }

    // 3. The object must be white on black. Decide from the border pixels.
    const invert =
      params.invert === "yes" || (params.invert === "auto" && borderIsMostlyWhite(bin));
    if (invert) cv.bitwise_not(bin, bin);

    // 4. Morphological cleanup: opening removes dust, closing bridges small gaps.
    if (params.morph > 0) {
      const kernel = cv.getStructuringElement(
        cv.MORPH_ELLIPSE,
        new cv.Size(params.morph * 2 + 1, params.morph * 2 + 1)
      );
      cv.morphologyEx(bin, bin, cv.MORPH_OPEN, kernel);
      cv.morphologyEx(bin, bin, cv.MORPH_CLOSE, kernel);
      kernel.delete();
    }

    // 5. Contours with 2-level hierarchy: top level = outer shapes, children = holes.
    cv.findContours(bin, contours, hierarchy, cv.RETR_CCOMP, cv.CHAIN_APPROX_SIMPLE);

    // 6. Pick the largest top-level contour (parent == -1) as the object.
    let outerIdx = -1;
    let outerArea = 0;
    for (let i = 0; i < contours.size(); i++) {
      const parent = hierarchy.intPtr(0, i)[3];
      if (parent !== -1) continue;
      const area = cv.contourArea(contours.get(i));
      if (area > outerArea) {
        outerArea = area;
        outerIdx = i;
      }
    }
    if (outerIdx === -1 || outerArea < 25) {
      throw new Error("NO_CONTOUR");
    }

    const outer = approximate(cv, contours.get(outerIdx), params.epsilonPct);

    // 7. Collect holes: children of the outer contour above the size threshold.
    const inner: Pt[][] = [];
    const minHoleArea = (params.minHolePct / 100) * outerArea;
    for (let i = 0; i < contours.size(); i++) {
      const parent = hierarchy.intPtr(0, i)[3];
      if (parent !== outerIdx) continue;
      const c = contours.get(i);
      if (cv.contourArea(c) >= minHoleArea) {
        inner.push(approximate(cv, c, params.epsilonPct));
      }
    }

    return { outer, inner };
  } finally {
    mats.forEach((m) => m.delete());
    for (let i = 0; i < contours.size(); i++) contours.get(i).delete();
    contours.delete();
  }
}

/** approxPolyDP with epsilon as a percentage of the contour perimeter. */
function approximate(cv: any, contour: any, epsilonPct: number): Pt[] {
  const approx = new cv.Mat();
  try {
    const eps = (epsilonPct / 100) * cv.arcLength(contour, true);
    cv.approxPolyDP(contour, approx, Math.max(eps, 0.0001), true);
    const pts: Pt[] = [];
    for (let i = 0; i < approx.rows; i++) {
      pts.push({ x: approx.data32S[i * 2], y: approx.data32S[i * 2 + 1] });
    }
    return pts;
  } finally {
    approx.delete();
  }
}

/** True when the binary image border is predominantly white (background = white). */
function borderIsMostlyWhite(bin: any): boolean {
  const w = bin.cols;
  const h = bin.rows;
  const data = bin.data;
  let white = 0;
  let total = 0;
  const step = Math.max(1, Math.floor(w / 100));
  for (let x = 0; x < w; x += step) {
    if (data[x] > 127) white++;
    if (data[(h - 1) * w + x] > 127) white++;
    total += 2;
  }
  const stepY = Math.max(1, Math.floor(h / 100));
  for (let y = 0; y < h; y += stepY) {
    if (data[y * w] > 127) white++;
    if (data[y * w + w - 1] > 127) white++;
    total += 2;
  }
  return white / total > 0.5;
}
