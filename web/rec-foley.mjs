import { chromium } from "playwright";
import path from "node:path";
import { pathToFileURL } from "node:url"; const f = pathToFileURL(path.resolve("public/motion/foley.html")).href;
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 460, height: 860 }, recordVideo: { dir: "rec", size: { width: 460, height: 860 } } });
const errs = []; p.on("pageerror", e => errs.push(e.message)); p.on("console", m => m.type() === "error" && errs.push(m.text()));
await p.goto(f); await p.waitForTimeout(800);
await p.click("#play");
const shots = [1100, 3500, 6200, 8100, 11200, 13600, 15900, 17600];
let t0 = 0;
for (const [i, t] of shots.entries()) { await p.waitForTimeout(t - t0); t0 = t; await p.screenshot({ path: `rec/f${i}.png` }); }
await p.waitForTimeout(2000);
console.log("errors:", JSON.stringify(errs));
const v = p.video(); await p.close(); console.log("video", await v.path()); await b.close();
