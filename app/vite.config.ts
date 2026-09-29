import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ command }) => ({
  // Served under /app/ on the public site; dev stays at /
  base: command === "build" ? "/app/" : "/",
  plugins: [react()],
  define: { global: "globalThis" },
  test: { environment: "node", testTimeout: 60000 },
}) as never);
