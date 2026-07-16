import { ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export type ContourPoint = {
  x: number;
  y: number;
};

export type ScanMeasurements = {
  widthMm: number;
  heightMm: number;
  areaMm2: number;
  perimeterMm: number;
  aspectRatio: number;
  confidence: number;
};

export const apiBaseUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export const demoContour: ContourPoint[] = [
  { x: 140, y: 80 },
  { x: 330, y: 92 },
  { x: 412, y: 188 },
  { x: 378, y: 340 },
  { x: 205, y: 386 },
  { x: 88, y: 292 },
  { x: 96, y: 152 }
];

export const demoMeasurements: ScanMeasurements = {
  widthMm: 286.4,
  heightMm: 214.8,
  areaMm2: 42186,
  perimeterMm: 941.7,
  aspectRatio: 1.33,
  confidence: 98.6
};

export const exportOptions = ["DXF", "SVG", "PNG", "PDF", "JSON", "CSV", "G-Code"];

export const objectClasses = [
  "Sticker",
  "Label",
  "Gasket",
  "Flange",
  "Metal plate",
  "PVC board",
  "Rubber seal",
  "Textile pattern"
];
