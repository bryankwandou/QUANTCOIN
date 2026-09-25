// Browser check of the landing page, plus screenshots for the report.
// Usage: node scripts/verify.mjs [baseUrl]
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const BASE = process.argv[2] ?? "http://localhost:4329";
const OUT = new URL("../../docs/site-proof/", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const fails = [];
const check = (ok, msg) => { console.log(`${ok ? "PASS" : "FAIL"}  ${msg}`); if (!ok) fails.push(msg); };

async function open(path, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, ...opts });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto(BASE + path, { waitUntil: "networkidle" });
  return { ctx, page, errors };
}
async function revealAll(page) {
  await page.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += 500) { scrollTo(0, y); await new Promise((r) => setTimeout(r, 60)); }
    scrollTo(0, 0);
  });
  await page.waitForTimeout(1200);
}

// 1. English, dark
{
  const { ctx, page, errors } = await open("/", { colorScheme: "dark" });
  await page.waitForTimeout(1500);
  check(await page.locator(".stage.live").count() === 1, "3D hero started (WebGL canvas live)");
  check((await page.locator("h1").textContent()).includes("two keys"), "English is the default language");
  await page.screenshot({ path: OUT + "01-hero-dark.png" });
  await revealAll(page);
  await page.screenshot({ path: OUT + "02-full-dark.png", fullPage: true });

  // simulator
  await page.locator("#how").scrollIntoViewIfNeeded();
  const out = page.locator(".sim-out");
  await page.locator('.key[data-k="a"]').click();
  check((await out.getAttribute("data-state")) === "1", "Simulator: one key -> vault still locked");
  await page.locator('.key[data-k="b"]').click();
  check((await out.getAttribute("data-state")) === "2", "Simulator: both keys -> funds move");
  await page.locator(".sim").screenshot({ path: OUT + "03-simulator.png" });

  // theme toggle persists
  await page.locator("#theme").click();
  check(await page.evaluate(() => document.documentElement.dataset.theme) === "light", "Theme toggle switches to light");
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  check(bg === "rgb(250, 250, 247)", `Light background applied (${bg})`);
  await page.reload({ waitUntil: "networkidle" });
  check(await page.evaluate(() => document.documentElement.dataset.theme) === "light", "Theme choice survives reload");
  await page.waitForTimeout(1500);
  await page.screenshot({ path: OUT + "04-hero-light.png" });
  await revealAll(page);
  await page.screenshot({ path: OUT + "05-full-light.png", fullPage: true });
  check(errors.length === 0, `No console errors on / (${errors.join(" | ") || "none"})`);
  await ctx.close();
}

// 2. Every hand-written language renders and the picker navigates
for (const [l, word] of [["id", "dua kunci"], ["es", "dos llaves"], ["pt", "duas chaves"], ["fr", "deux clés"], ["de", "zwei Schlüsseln"], ["ja", "二つの鍵"], ["zh", "两把钥匙"], ["ko", "두 개의 열쇠"], ["ru", "двумя ключами"]]) {
  const { ctx, page, errors } = await open(`/${l}/`, { colorScheme: "dark", deviceScaleFactor: 1 });
  const h1 = await page.locator("h1").textContent();
  check(h1.includes(word) && errors.length === 0, `/${l}/ renders in its language: "${h1}"`);
  if (l === "ja" || l === "id") { await page.waitForTimeout(1200); await page.screenshot({ path: OUT + `06-lang-${l}.png` }); }
  await ctx.close();
}
{
  const { ctx, page } = await open("/", { colorScheme: "dark", deviceScaleFactor: 1 });
  await Promise.all([page.waitForURL("**/de/"), page.selectOption("#lang-pick", "/de/")]);
  check(page.url().endsWith("/de/"), "Language picker navigates to /de/");
  check(await page.locator('link[hreflang="ja"]').count() === 1, "hreflang alternates present");
  await ctx.close();
}

// 3. Phone
{
  const { ctx, page, errors } = await open("/", { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, colorScheme: "dark" });
  await page.waitForTimeout(1500);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  check(overflow <= 0, `No horizontal scroll at 390px (overflow ${overflow}px)`);
  await page.screenshot({ path: OUT + "07-mobile-hero.png" });
  await revealAll(page);
  await page.screenshot({ path: OUT + "08-mobile-full.png", fullPage: true });
  check(errors.length === 0, "No console errors on mobile");
  await ctx.close();
}

// 4. Other pages still load
for (const p of ["/whitepaper/", "/docs/", "/audit/", "/launch/", "/app/", "/transparency/"]) {
  const { ctx, page, errors } = await open(p, { deviceScaleFactor: 1 });
  check(errors.length === 0 && (await page.title()).length > 0, `${p} loads without errors`);
  await ctx.close();
}

await browser.close();
console.log(fails.length ? `\n${fails.length} FAILED` : "\nALL PASS");
process.exit(fails.length ? 1 : 0);
