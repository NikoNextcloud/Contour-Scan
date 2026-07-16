import type { Calibration } from "./types";

export const DEFAULT_SCANNER_DPI = 300;

export function dpiToMmPerPx(dpi: number): number {
  return 25.4 / Math.max(1, dpi);
}

export async function calibrationFromImageFile(
  file: File,
  fallbackDpi = DEFAULT_SCANNER_DPI
): Promise<Calibration> {
  const dpi = (await readEmbeddedDpi(file)) ?? fallbackDpi;
  const roundedDpi = Math.round(dpi * 100) / 100;
  const source = dpi === fallbackDpi ? `Scanner default ${roundedDpi} DPI` : `Image metadata ${roundedDpi} DPI`;
  return {
    mmPerPx: dpiToMmPerPx(dpi),
    source,
  };
}

async function readEmbeddedDpi(file: File): Promise<number | null> {
  const header = new Uint8Array(await file.slice(0, 128).arrayBuffer());
  return readBmpDpi(header) ?? readPngDpi(header) ?? readJpegDpi(header);
}

function readBmpDpi(header: Uint8Array): number | null {
  if (header.length < 46 || header[0] !== 0x42 || header[1] !== 0x4d) return null;
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const xPixelsPerMeter = view.getInt32(38, true);
  const yPixelsPerMeter = view.getInt32(42, true);
  const ppm = xPixelsPerMeter > 0 ? xPixelsPerMeter : yPixelsPerMeter;
  return ppm > 0 ? ppm * 0.0254 : null;
}

function readPngDpi(header: Uint8Array): number | null {
  const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!pngSignature.every((byte, index) => header[index] === byte)) return null;
  for (let offset = 8; offset + 21 <= header.length; ) {
    const length = readUint32BE(header, offset);
    const type = String.fromCharCode(...header.slice(offset + 4, offset + 8));
    if (type === "pHYs" && offset + 17 <= header.length) {
      const xPixelsPerMeter = readUint32BE(header, offset + 8);
      const unit = header[offset + 16];
      return unit === 1 && xPixelsPerMeter > 0 ? xPixelsPerMeter * 0.0254 : null;
    }
    offset += 12 + length;
  }
  return null;
}

function readJpegDpi(header: Uint8Array): number | null {
  if (header[0] !== 0xff || header[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 16 < header.length) {
    if (header[offset] !== 0xff) return null;
    const marker = header[offset + 1];
    const length = (header[offset + 2] << 8) | header[offset + 3];
    if (marker === 0xe0) {
      const id = String.fromCharCode(...header.slice(offset + 4, offset + 9));
      if (id === "JFIF\0") {
        const units = header[offset + 11];
        const xDensity = (header[offset + 12] << 8) | header[offset + 13];
        if (units === 1 && xDensity > 0) return xDensity;
        if (units === 2 && xDensity > 0) return xDensity * 2.54;
      }
      return null;
    }
    offset += 2 + length;
  }
  return null;
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}
