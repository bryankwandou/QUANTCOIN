// Packs dist/ into the release zip and appends its SHA-256 to SHA256SUMS.txt.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";

const outDir = process.env.OUT_DIR ?? "release";
const zip = `${outDir}/QuantumSafe-extension.zip`;
mkdirSync(outDir, { recursive: true });
if (existsSync(zip)) rmSync(zip);
// bsdtar (Windows, macOS) picks zip from the extension with -a; GNU tar would not.
execFileSync(process.platform === "win32" ? "C:/Windows/System32/tar.exe" : "tar", ["-a", "-c", "-f", zip, "-C", "dist", "."], { stdio: "inherit" });
const sum = createHash("sha256").update(readFileSync(zip)).digest("hex");
appendFileSync(`${outDir}/SHA256SUMS.txt`, `${sum}  QuantumSafe-extension.zip\n`);
console.log(sum, zip);
