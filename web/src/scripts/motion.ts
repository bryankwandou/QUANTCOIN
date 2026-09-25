// Scroll reveals, count-ups, the growing allocation bar, card tilt,
// and the two-key simulator. Motion is skipped under reduced motion.
const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
document.documentElement.classList.add("js");

const io = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    const el = e.target as HTMLElement;
    el.classList.add("in");
    io.unobserve(el);
    el.querySelectorAll<HTMLElement>("[data-count]").forEach(countUp);
  }
}, { rootMargin: "0px 0px -8% 0px", threshold: 0.12 });

let stagger = 0;
document.querySelectorAll<HTMLElement>(".reveal, .grow, .draw").forEach((el) => {
  // Siblings that enter together fan out a little instead of popping at once.
  el.style.setProperty("--d", `${(stagger++ % 4) * 70}ms`);
  if (reduce) el.classList.add("in"); else io.observe(el);
});

function countUp(el: HTMLElement) {
  const end = Number(el.dataset.count);
  if (reduce || !end) return;
  const t0 = performance.now(), dur = 1100;
  const step = (now: number) => {
    const p = Math.min(1, (now - t0) / dur);
    el.textContent = String(Math.round(end * (1 - Math.pow(1 - p, 3))));
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

if (!reduce && matchMedia("(hover: hover)").matches) {
  document.querySelectorAll<HTMLElement>(".tilt").forEach((card) => {
    card.addEventListener("pointermove", (ev) => {
      const r = card.getBoundingClientRect();
      const x = (ev.clientX - r.left) / r.width - 0.5, y = (ev.clientY - r.top) / r.height - 0.5;
      card.style.transform = `perspective(900px) rotateY(${x * 8}deg) rotateX(${-y * 8}deg) translateY(-4px)`;
    });
    card.addEventListener("pointerleave", () => { card.style.transform = ""; });
  });
}

const sim = document.getElementById("sim");
if (sim) {
  const out = sim.querySelector<HTMLElement>(".sim-out")!;
  const keys = [...sim.querySelectorAll<HTMLButtonElement>(".key")];
  const update = () => {
    const n = keys.filter((k) => k.getAttribute("aria-pressed") === "true").length;
    out.dataset.state = String(n);
    out.textContent = out.dataset[`r${n}`] ?? "";
    document.querySelector(".diagram")?.setAttribute("data-state", String(n));
  };
  keys.forEach((k) => k.addEventListener("click", () => {
    k.setAttribute("aria-pressed", String(k.getAttribute("aria-pressed") !== "true"));
    update();
  }));
}
