/**
 * Optional lazy loader for OpenCV.js.
 * The scanner has a built-in TypeScript fallback, so a failed CDN request must
 * never block uploads or BMP processing on Vercel.
 */

const OPENCV_URL = "https://docs.opencv.org/4.10.0/opencv.js";

let loader: Promise<any> | null = null;

export function loadOpenCV(options: { timeoutMs?: number } = {}): Promise<any> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("OpenCV.js is browser-only"));
  }

  const existing = (window as any).cv;
  if (existing && existing.Mat) return Promise.resolve(existing);

  if (!loader) {
    loader = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = OPENCV_URL;
      script.async = true;
      script.onload = async () => {
        try {
          let cv = (window as any).cv;
          if (cv && typeof cv.then === "function") {
            cv = await cv;
            (window as any).cv = cv;
          }
          if (cv && cv.Mat) return resolve(cv);
          if (cv) {
            cv.onRuntimeInitialized = () => resolve((window as any).cv);
            return;
          }
          reject(new Error("OpenCV loaded but cv is undefined"));
        } catch (error) {
          reject(error);
        }
      };
      script.onerror = () => {
        loader = null;
        reject(new Error("OpenCV.js could not be loaded"));
      };
      document.head.appendChild(script);
    });
  }

  if (!options.timeoutMs) return loader;

  return Promise.race([
    loader,
    new Promise((_, reject) => {
      window.setTimeout(() => reject(new Error("OpenCV.js load timed out")), options.timeoutMs);
    }),
  ]);
}
