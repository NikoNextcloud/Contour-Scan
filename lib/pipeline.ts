import type { ContourSet, PipelineParams, Pt } from "./types";

type ByteArray = Uint8Array<ArrayBufferLike>;

export interface ImageOptions {
  contrast: number;
  brightness: number;
  gamma: number;
  invert: boolean;
  grayscale: boolean;
  borderEnabled: boolean;
  borderShape: "rect" | "oval";
  borderWidth: number;
}

export const DEFAULT_IMAGE_OPTIONS: ImageOptions = {
  contrast: 0,
  brightness: 0,
  gamma: 1,
  invert: false,
  grayscale: false,
  borderEnabled: false,
  borderShape: "rect",
  borderWidth: 0,
};

/** Longest image side we process; larger inputs are downscaled for speed. */
export const MAX_PROCESS_SIDE = 2400;

/**
 * Load a File/Blob into an ImageData, downscaling to MAX_PROCESS_SIDE.
 * Returns the (possibly scaled) ImageData plus the original dimensions.
 */
export async function fileToImageData(
  file: Blob
): Promise<{ imageData: ImageData; originalW: number; originalH: number; scale: number }> {
  const bitmap = await blobToBitmap(file);
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

export function applyImageOptions(imageData: ImageData, options: ImageOptions): ImageData {
  const out = new ImageData(new Uint8ClampedArray(imageData.data), imageData.width, imageData.height);
  const data = out.data;
  const contrastFactor = (259 * (options.contrast + 255)) / (255 * (259 - options.contrast));
  const gamma = Math.max(0.1, options.gamma);

  for (let i = 0; i < data.length; i += 4) {
    let r = data[i];
    let g = data[i + 1];
    let b = data[i + 2];
    if (options.grayscale) {
      const y = Math.round(r * 0.299 + g * 0.587 + b * 0.114);
      r = y;
      g = y;
      b = y;
    }
    r = adjustChannel(r, contrastFactor, options.brightness, gamma, options.invert);
    g = adjustChannel(g, contrastFactor, options.brightness, gamma, options.invert);
    b = adjustChannel(b, contrastFactor, options.brightness, gamma, options.invert);
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
  }

  if (options.borderEnabled && options.borderWidth > 0) {
    addBorder(out, options.borderWidth, options.borderShape);
  }

  return out;
}

function adjustChannel(value: number, contrastFactor: number, brightness: number, gamma: number, invert: boolean): number {
  let next = contrastFactor * (value - 128) + 128 + brightness;
  next = 255 * Math.pow(Math.max(0, Math.min(255, next)) / 255, 1 / gamma);
  if (invert) next = 255 - next;
  return Math.max(0, Math.min(255, Math.round(next)));
}

function addBorder(imageData: ImageData, width: number, shape: "rect" | "oval") {
  const canvas = document.createElement("canvas");
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  const ctx = canvas.getContext("2d")!;
  ctx.putImageData(imageData, 0, 0);
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = Math.max(1, width);
  if (shape === "oval") {
    ctx.beginPath();
    ctx.ellipse(canvas.width / 2, canvas.height / 2, canvas.width / 2 - width, canvas.height / 2 - width, 0, 0, Math.PI * 2);
    ctx.stroke();
  } else {
    ctx.strokeRect(width / 2, width / 2, canvas.width - width, canvas.height - width);
  }
  imageData.data.set(ctx.getImageData(0, 0, canvas.width, canvas.height).data);
}

async function blobToBitmap(file: Blob): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file);
  } catch {
    const url = URL.createObjectURL(file);
    try {
      const image = new Image();
      image.decoding = "async";
      image.src = url;
      await image.decode();
      return await createImageBitmap(image);
    } finally {
      URL.revokeObjectURL(url);
    }
  }
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

/**
 * Built-in fallback detector used when OpenCV.js cannot be loaded.
 * It is intentionally dependency-free so Vercel deployments keep working even
 * when the OpenCV CDN is blocked, slow, or offline.
 */
export function detectContoursFallback(imageData: ImageData, params: PipelineParams): ContourSet {
  const { width, height, data } = imageData;
  const gray: ByteArray = new Uint8Array(width * height);

  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    gray[p] = Math.round(data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114);
  }

  const blurred = params.blur > 1 ? boxBlurGray(gray, width, height, Math.min(3, params.blur >> 1)) : gray;
  const threshold =
    params.threshold === "adaptive"
      ? adaptiveThreshold(blurred, width, height)
      : otsuThreshold(blurred);
  let mask: ByteArray = new Uint8Array(width * height);
  for (let i = 0; i < blurred.length; i++) {
    mask[i] = blurred[i] > threshold ? 1 : 0;
  }

  const invert =
    params.invert === "yes" || (params.invert === "auto" && borderMaskIsMostlyObject(mask, width, height));
  if (invert) {
    for (let i = 0; i < mask.length; i++) mask[i] = mask[i] ? 0 : 1;
  }

  const passes = Math.max(0, Math.min(4, Math.round(params.morph)));
  if (passes > 0) {
    mask = closeMask(openMask(mask, width, height, passes), width, height, passes);
  }

  const components = connectedComponents(mask, width, height, 1, true);
  const minArea = Math.max(25, width * height * 0.001);
  const outerComponent = components.filter((item) => item.area >= minArea).sort((a, b) => b.area - a.area)[0];
  if (!outerComponent) {
    throw new Error("NO_CONTOUR");
  }

  const objectMask: ByteArray = new Uint8Array(width * height);
  for (const index of outerComponent.indices) objectMask[index] = 1;
  const outerBoundary = boundaryPoints(objectMask, width, height, 1);
  const outer = simplifyClosedPolygon(orderBoundaryByAngle(outerBoundary), params.epsilonPct);

  const holes: Pt[][] = [];
  const backgroundInside: ByteArray = new Uint8Array(width * height);
  for (let i = 0; i < objectMask.length; i++) backgroundInside[i] = objectMask[i] ? 0 : 1;
  const bgComponents = connectedComponents(backgroundInside, width, height, 1, false);
  const minHoleArea = (params.minHolePct / 100) * outerComponent.area;
  for (const component of bgComponents) {
    if (component.touchesBorder || component.area < minHoleArea) continue;
    const holeMask: ByteArray = new Uint8Array(width * height);
    for (const index of component.indices) holeMask[index] = 1;
    const holeBoundary = boundaryPoints(holeMask, width, height, 1);
    const hole = simplifyClosedPolygon(orderBoundaryByAngle(holeBoundary), params.epsilonPct);
    if (hole.length >= 3 && pointInPolygon(hole[0], outer)) holes.push(hole);
  }

  return { outer, inner: holes };
}

function otsuThreshold(gray: ByteArray): number {
  const hist = new Array<number>(256).fill(0);
  for (const value of gray) hist[value]++;

  const total = gray.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];

  let sumB = 0;
  let wB = 0;
  let maxVariance = -1;
  let threshold = 127;

  for (let i = 0; i < 256; i++) {
    wB += hist[i];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += i * hist[i];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const variance = wB * wF * (mB - mF) ** 2;
    if (variance > maxVariance) {
      maxVariance = variance;
      threshold = i;
    }
  }

  return threshold;
}

function adaptiveThreshold(gray: ByteArray, width: number, height: number): number {
  const samples: number[] = [];
  const step = Math.max(1, Math.floor(Math.min(width, height) / 80));
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      samples.push(gray[y * width + x]);
    }
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length * 0.48)] ?? 127;
}

function boxBlurGray(gray: ByteArray, width: number, height: number, radius: number): ByteArray {
  if (radius <= 0) return gray;
  const out = new Uint8Array(gray.length);
  const size = radius * 2 + 1;
  const area = size * size;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        const yy = clamp(y + dy, 0, height - 1);
        for (let dx = -radius; dx <= radius; dx++) {
          sum += gray[yy * width + clamp(x + dx, 0, width - 1)];
        }
      }
      out[y * width + x] = Math.round(sum / area);
    }
  }
  return out;
}

function openMask(mask: ByteArray, width: number, height: number, passes: number): ByteArray {
  let next = mask;
  for (let i = 0; i < passes; i++) next = erode(next, width, height);
  for (let i = 0; i < passes; i++) next = dilate(next, width, height);
  return next;
}

function closeMask(mask: ByteArray, width: number, height: number, passes: number): ByteArray {
  let next = mask;
  for (let i = 0; i < passes; i++) next = dilate(next, width, height);
  for (let i = 0; i < passes; i++) next = erode(next, width, height);
  return next;
}

function erode(mask: ByteArray, width: number, height: number): ByteArray {
  const out = new Uint8Array(mask.length);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      out[i] =
        mask[i] &&
        mask[i - 1] &&
        mask[i + 1] &&
        mask[i - width] &&
        mask[i + width] &&
        mask[i - width - 1] &&
        mask[i - width + 1] &&
        mask[i + width - 1] &&
        mask[i + width + 1]
          ? 1
          : 0;
    }
  }
  return out;
}

function dilate(mask: ByteArray, width: number, height: number): ByteArray {
  const out = new Uint8Array(mask.length);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      out[i] =
        mask[i] ||
        mask[i - 1] ||
        mask[i + 1] ||
        mask[i - width] ||
        mask[i + width] ||
        mask[i - width - 1] ||
        mask[i - width + 1] ||
        mask[i + width - 1] ||
        mask[i + width + 1]
          ? 1
          : 0;
    }
  }
  return out;
}

type Component = {
  area: number;
  indices: number[];
  touchesBorder: boolean;
};

function connectedComponents(
  mask: ByteArray,
  width: number,
  height: number,
  target: 0 | 1,
  ignoreBorderComponents: boolean
): Component[] {
  const visited: ByteArray = new Uint8Array(mask.length);
  const components: Component[] = [];
  const queue = new Int32Array(mask.length);

  for (let start = 0; start < mask.length; start++) {
    if (visited[start] || mask[start] !== target) continue;
    let head = 0;
    let tail = 0;
    let touchesBorder = false;
    const indices: number[] = [];
    visited[start] = 1;
    queue[tail++] = start;

    while (head < tail) {
      const index = queue[head++];
      indices.push(index);
      const x = index % width;
      const y = Math.floor(index / width);
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) touchesBorder = true;

      const neighbors = [index - 1, index + 1, index - width, index + width];
      for (const next of neighbors) {
        if (next < 0 || next >= mask.length || visited[next] || mask[next] !== target) continue;
        const nx = next % width;
        if (Math.abs(nx - x) > 1) continue;
        visited[next] = 1;
        queue[tail++] = next;
      }
    }

    if (!(ignoreBorderComponents && touchesBorder)) {
      components.push({ area: indices.length, indices, touchesBorder });
    }
  }

  return components;
}

function boundaryPoints(mask: ByteArray, width: number, height: number, value: 0 | 1): Pt[] {
  const points: Pt[] = [];
  const stride = Math.max(1, Math.floor(Math.max(width, height) / 900));
  for (let y = 1; y < height - 1; y += stride) {
    for (let x = 1; x < width - 1; x += stride) {
      const i = y * width + x;
      if (mask[i] !== value) continue;
      if (
        mask[i - 1] !== value ||
        mask[i + 1] !== value ||
        mask[i - width] !== value ||
        mask[i + width] !== value
      ) {
        points.push({ x, y });
      }
    }
  }
  return points;
}

function orderBoundaryByAngle(points: Pt[]): Pt[] {
  if (points.length <= 2) return points;
  const cx = points.reduce((sum, point) => sum + point.x, 0) / points.length;
  const cy = points.reduce((sum, point) => sum + point.y, 0) / points.length;
  return [...points].sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
}

function simplifyClosedPolygon(points: Pt[], epsilonPct: number): Pt[] {
  if (points.length <= 12) return points;
  const epsilon = Math.max(1, (epsilonPct / 100) * polygonPerimeter(points));
  const simplified = rdp(points, epsilon);
  return simplified.length >= 3 ? simplified : points.slice(0, 3);
}

function rdp(points: Pt[], epsilon: number): Pt[] {
  if (points.length < 3) return points;
  let maxDist = 0;
  let index = 0;
  const end = points.length - 1;
  for (let i = 1; i < end; i++) {
    const dist = perpendicularDistance(points[i], points[0], points[end]);
    if (dist > maxDist) {
      index = i;
      maxDist = dist;
    }
  }
  if (maxDist > epsilon) {
    const left = rdp(points.slice(0, index + 1), epsilon);
    const right = rdp(points.slice(index), epsilon);
    return left.slice(0, -1).concat(right);
  }
  return [points[0], points[end]];
}

function perpendicularDistance(point: Pt, lineStart: Pt, lineEnd: Pt): number {
  const dx = lineEnd.x - lineStart.x;
  const dy = lineEnd.y - lineStart.y;
  if (dx === 0 && dy === 0) return Math.hypot(point.x - lineStart.x, point.y - lineStart.y);
  return Math.abs(dy * point.x - dx * point.y + lineEnd.x * lineStart.y - lineEnd.y * lineStart.x) / Math.hypot(dx, dy);
}

function polygonPerimeter(points: Pt[]): number {
  let total = 0;
  for (let i = 0; i < points.length; i++) {
    const next = points[(i + 1) % points.length];
    total += Math.hypot(next.x - points[i].x, next.y - points[i].y);
  }
  return total;
}

function pointInPolygon(point: Pt, polygon: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x;
    const yi = polygon[i].y;
    const xj = polygon[j].x;
    const yj = polygon[j].y;
    const intersects = yi > point.y !== yj > point.y && point.x < ((xj - xi) * (point.y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function borderMaskIsMostlyObject(mask: ByteArray, width: number, height: number): boolean {
  let count = 0;
  let total = 0;
  const stepX = Math.max(1, Math.floor(width / 100));
  for (let x = 0; x < width; x += stepX) {
    count += mask[x] + mask[(height - 1) * width + x];
    total += 2;
  }
  const stepY = Math.max(1, Math.floor(height / 100));
  for (let y = 0; y < height; y += stepY) {
    count += mask[y * width] + mask[y * width + width - 1];
    total += 2;
  }
  return count / total > 0.5;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
