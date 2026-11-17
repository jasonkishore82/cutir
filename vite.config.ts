import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// COOP/COEP headers are required for multi-threaded ffmpeg.wasm (Phase 5)
const isolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

export default defineConfig({
  plugins: [react()],
  server: { headers: isolation },
  preview: { headers: isolation },
});
