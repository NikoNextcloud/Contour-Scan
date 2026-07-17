/** A 2D point in image pixel coordinates. */
export interface Pt {
  x: number;
  y: number;
}

/** Result of the contour detection pipeline. */
export interface ContourSet {
  /** The single outer contour of the object (closed polygon). */
  outer: Pt[];
  /** Inner contours: holes / slots / cut-outs inside the object. */
  inner: Pt[][];
  /** Open tool paths / polylines drawn by the user. */
  polylines?: Pt[][];
}

/** Parameters that control the contour pipeline. */
export interface PipelineParams {
  /** Gaussian blur kernel size (odd, 1 = off). */
  blur: number;
  /** Threshold mode. */
  threshold: "otsu" | "adaptive";
  /** Morphological open/close kernel size (0 = off). */
  morph: number;
  /** Contour simplification, as % of perimeter (approxPolyDP epsilon). */
  epsilonPct: number;
  /** Minimum inner-contour area, as % of the outer contour area. */
  minHolePct: number;
  /** Force invert of the binary image ("auto" decides from image borders). */
  invert: "auto" | "yes" | "no";
  /** Build a symmetric contour from one scanned side. */
  mirrorMode: "off" | "leftToRight" | "rightToLeft" | "topToBottom" | "bottomToTop";
  /** Smooth detected contour after scanning, before measurements/export. */
  smoothIterations: number;
}

export const DEFAULT_PARAMS: PipelineParams = {
  blur: 1,
  threshold: "otsu",
  morph: 1,
  epsilonPct: 0.03,
  minHolePct: 0.5,
  invert: "auto",
  mirrorMode: "off",
  smoothIterations: 0,
};

/** Geometric measurements of a contour, in pixels. */
export interface MeasurementsPx {
  widthPx: number;
  heightPx: number;
  areaPx: number;
  perimeterPx: number;
  /** Axis-aligned bounding box. */
  bbox: { x: number; y: number; w: number; h: number };
  /** Minimum-area (rotated) rectangle. */
  minRect: { w: number; h: number; angleDeg: number };
  /** Diameter of a circle with the same area. */
  circleDiameterPx: number;
  /** minRect long side / short side. */
  aspectRatio: number;
  /** Number of detected holes / inner contours. */
  holeCount: number;
}

/** Calibration: how many millimetres one pixel represents. */
export interface Calibration {
  mmPerPx: number;
  /** Human-readable source, e.g. "Credit card (85.60 mm)". */
  source: string;
}

/** A saved scan in history (IndexedDB). */
export interface ScanRecord {
  id: string;
  name: string;
  createdAt: number;
  /** Small JPEG data-URL preview. */
  thumbnail: string;
  contours: ContourSet;
  measurements: MeasurementsPx;
  calibration: Calibration | null;
  /** Source image size, for correct export scaling. */
  imageSize: { w: number; h: number };
}

/** Reference objects for calibration presets. */
export const CALIBRATION_PRESETS: { id: string; mm: number }[] = [
  { id: "creditCard", mm: 85.6 }, // ISO/IEC 7810 ID-1 width
  { id: "a4Long", mm: 297 }, // A4 long side
  { id: "a4Short", mm: 210 }, // A4 short side
  { id: "coin2lv", mm: 26.5 }, // 2 лв. coin diameter
  { id: "coin1lv", mm: 24.5 }, // 1 лв. coin diameter
  { id: "coin50st", mm: 22.5 }, // 50 ст. coin diameter
  { id: "coin1eur", mm: 23.25 }, // 1 € coin diameter
  { id: "coin2eur", mm: 25.75 }, // 2 € coin diameter
];
