/**
 * Lazy loader за OpenCV.js с два източника:
 * 1) Пакетиран модул (@techstark/opencv-js) — качва се с приложението на Vercel,
 *    зарежда се винаги, дори при adblock / блокиран CDN. Основен път.
 * 2) Официален CDN — резервен, ако пакетът по някаква причина не се зареди.
 * Скенерът има и чист TypeScript fallback-детектор, така че провал тук никога
 * не блокира работата.
 */

const OPENCV_URL = "https://docs.opencv.org/4.10.0/opencv.js";

let loader: Promise<any> | null = null;

/** Изчаква cv обект да е готов (thenable или onRuntimeInitialized стил). */
async function resolveCv(cvModule: any): Promise<any> {
  let cv = cvModule?.default ?? cvModule;
  if (cv && typeof cv.then === "function") {
    cv = await cv;
  }
  if (cv && cv.Mat) return cv;
  if (cv) {
    await new Promise<void>((resolve) => {
      const prev = cv.onRuntimeInitialized;
      cv.onRuntimeInitialized = () => {
        if (typeof prev === "function") prev();
        resolve();
      };
      // Ако вече е инициализиран междувременно:
      if (cv.Mat) resolve();
    });
    if (cv.Mat) return cv;
  }
  throw new Error("OpenCV module resolved but cv.Mat is missing");
}

function loadFromCdn(): Promise<any> {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = OPENCV_URL;
    script.async = true;
    script.onload = async () => {
      try {
        resolve(await resolveCv((window as any).cv));
      } catch (error) {
        reject(error);
      }
    };
    script.onerror = () => reject(new Error("OpenCV.js CDN could not be loaded"));
    document.head.appendChild(script);
  });
}

export function loadOpenCV(options: { timeoutMs?: number } = {}): Promise<any> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("OpenCV.js is browser-only"));
  }

  const existing = (window as any).cv;
  if (existing && existing.Mat) return Promise.resolve(existing);

  if (!loader) {
    loader = (async () => {
      try {
        // Основен път: пакетиран модул — отделен chunk, тегли се при нужда.
        const mod = await import("@techstark/opencv-js");
        const cv = await resolveCv(mod);
        (window as any).cv = cv;
        return cv;
      } catch {
        // Резервен път: официалният CDN.
        const cv = await loadFromCdn();
        (window as any).cv = cv;
        return cv;
      }
    })();
    loader.catch(() => {
      loader = null; // позволи повторен опит при следващо извикване
    });
  }

  if (!options.timeoutMs) return loader;

  return Promise.race([
    loader,
    new Promise<any>((_, reject) => {
      window.setTimeout(() => reject(new Error("OpenCV.js load timed out")), options.timeoutMs);
    }),
  ]);
}
