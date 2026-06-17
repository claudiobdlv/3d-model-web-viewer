import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true
  },
  server: {
    proxy: {
      "/api": "http://localhost:3009",
      "/downloads": "http://localhost:3009",
      "/model-files": "http://localhost:3009",
      "/admin/logs": "http://localhost:3009",
      "/admin/models": "http://localhost:3009"
    }
  }
});
