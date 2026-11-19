import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// COOP/COEP headers are required for multi-threaded ffmpeg.wasm (Phase 5)
const isolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

export default defineConfig({
  plugins: [react()],
  // ffmpeg.wasm spawns its own worker; pre-bundling would break its worker/core URLs
  optimizeDeps: { exclude: ["@ffmpeg/ffmpeg", "@ffmpeg/util"] },
  worker: { format: "es" },
  server: { headers: isolation },
  preview: { headers: isolation },
});
