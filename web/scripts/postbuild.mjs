// Copies the parts Astro does not build: the Quantum Safe app (Vite, base /app/)
// and the transparency dashboard (single static file).
import { cpSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const DIST = join(import.meta.dirname, "..", "dist");

const appDist = join(ROOT, "app", "dist");
if (!existsSync(appDist) || !readFileSync(join(appDist, "index.html"), "utf8").includes('src="/app/'))
  throw new Error("build app/ first with base /app/ (npm run build in app/)");
cpSync(appDist, join(DIST, "app"), { recursive: true });
cpSync(join(ROOT, "transparency", "index.html"), join(DIST, "transparency", "index.html"));
console.log("[postbuild] copied app/ and transparency/");
