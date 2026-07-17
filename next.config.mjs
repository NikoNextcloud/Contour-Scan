/** @type {import('next').NextConfig} */
const nextConfig = {
  // Static-friendly: the whole app runs in the browser (OpenCV.js / WASM).
  reactStrictMode: true,
  webpack: (config, { isServer }) => {
    if (!isServer) {
      // @techstark/opencv-js (Emscripten UMD) проверява за Node среда и
      // реферира fs/path/crypto — в браузъра те не са нужни.
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        path: false,
        crypto: false,
      };
    }
    return config;
  },
};
export default nextConfig;
