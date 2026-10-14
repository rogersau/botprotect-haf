import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig(({ mode }) => ({
  plugins: [react(), ...(mode === "docker" ? [] : [cloudflare()])],
  ...(mode === "docker" ? { build: { outDir: "dist/client" } } : {}),
  server: { port: 5173 },
}));
