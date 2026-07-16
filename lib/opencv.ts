/**
 * Lazy loader for OpenCV.js (WebAssembly build, ~9 MB).
 * The library is fetched once from the official OpenCV CDN and cached by the browser.
 * Handles both legacy builds (cv.onRuntimeInitialized) and newer builds where `cv` is a Promise.
 */

const OPENCV_URL = "https://docs.opencv.org/4.10.0/opencv.js";

let loader: Promise<any> | null = null;

export function loadOpenCV(): Promise<any> {
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
          // Newer WASM builds expose `cv` as a thenable that resolves to the module.
          if (cv && typeof cv.then === "function") {
            cv = await cv;
            (window as any).cv = cv;
          }
          if (cv && cv.Mat) return resolve(cv);
          if (cv) {
            cv.onRuntimeInitialized = () => resolve((window as any).cv);
            return;
          }
          reject(new Error("OpenCV loaded but `cv` is undefined"));
        } catch (e) {
          reject(e);
        }
      };
      script.onerror = () => {
        loader = null;
        reject(new Error("Failed to load OpenCV.js — check your connection"));
      };
      document.head.appendChild(script);
    });
  }
  return loader;
}
