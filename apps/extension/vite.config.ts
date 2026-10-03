// Same vite/vitest versions as app/ (pinned in apps/package.json) so app/src/lib is reused byte-for-byte via the @app alias.
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";

const appLib = fileURLToPath(new URL("../../app/src/lib", import.meta.url));
const appNm = fileURLToPath(new URL("../../app/node_modules/", import.meta.url));
export default defineConfig({
  base: "./",
  plugins: [react()],
  resolve: { alias: [
    { find: "@app", replacement: appLib },
    // the extension's own imports use the same copies as app/src/lib
    { find: /^(@solana\/web3\.js|@solana\/spl-token|buffer)$/, replacement: appNm + "$1" },
  ] },
  define: { global: "globalThis" },
  build: { outDir: "dist", emptyOutDir: true, modulePreload: false, sourcemap: false, rollupOptions: { input: "popup.html" } },
  test: { environment: "node", testTimeout: 120000, include: ["test/**/*.test.ts", "../../app/test/**/*.test.ts"] },
} as never);
