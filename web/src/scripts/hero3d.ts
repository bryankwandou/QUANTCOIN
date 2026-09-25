// The hero: the QuantCoin qubit in 3D. A faceted core (the vault), two
// tilted orbits carrying the two keys, and a slow field of dust.
// Drag to spin; it drifts back to its own rotation when released.
import {
  WebGLRenderer, Scene, PerspectiveCamera, Group, Mesh, LineSegments, Points,
  IcosahedronGeometry, EdgesGeometry, TorusGeometry, SphereGeometry, BufferGeometry, Float32BufferAttribute,
  MeshStandardMaterial, MeshBasicMaterial, LineBasicMaterial, PointsMaterial, AmbientLight, DirectionalLight, PointLight, Color,
} from "three";

const canvas = document.getElementById("qubit") as HTMLCanvasElement | null;
const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

function palette() {
  const s = getComputedStyle(document.documentElement);
  const v = (n: string) => new Color(s.getPropertyValue(n).trim() || "#2EE6D6");
  return { accent: v("--accent"), fg: v("--fg"), muted: v("--muted"), blue: new Color("#5B8CFF") };
}

function start(canvas: HTMLCanvasElement) {
  let renderer: WebGLRenderer;
  try { renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true }); }
  catch { return; } // no WebGL: the SVG logo behind the canvas stays visible
  canvas.closest(".stage")?.classList.add("live");
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

  const scene = new Scene();
  const camera = new PerspectiveCamera(38, 1, 0.1, 100);
  camera.position.set(0, 0, 9);
  const world = new Group();
  scene.add(world);

  let c = palette();
  const coreMat = new MeshStandardMaterial({ color: c.accent, metalness: 0.35, roughness: 0.35, flatShading: true, transparent: true, opacity: 0.92 });
  const core = new Mesh(new IcosahedronGeometry(1.25, 1), coreMat);
  const edgeMat = new LineBasicMaterial({ color: c.fg, transparent: true, opacity: 0.35 });
  const edges = new LineSegments(new EdgesGeometry(new IcosahedronGeometry(1.6, 1)), edgeMat);
  world.add(core, edges);

  const orbit = (tilt: number, spin: number, color: Color, r: number) => {
    const g = new Group();
    g.rotation.set(tilt, 0, spin);
    const ringMat = new MeshBasicMaterial({ color, transparent: true, opacity: 0.55 });
    const ring = new Mesh(new TorusGeometry(r, 0.018, 8, 160), ringMat);
    const beadMat = new MeshBasicMaterial({ color });
    const bead = new Mesh(new SphereGeometry(0.16, 24, 24), beadMat);
    const glow = new PointLight(color, 6, 4);
    bead.add(glow);
    g.add(ring, bead);
    world.add(g);
    return { bead, r, ringMat, beadMat, glow };
  };
  const o1 = orbit(1.15, -0.5, c.accent, 2.7);
  const o2 = orbit(1.9, 0.9, c.blue, 3.2);

  const N = 700, pos = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    const r = 4 + Math.random() * 6, th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1);
    pos.set([r * Math.sin(ph) * Math.cos(th), r * Math.sin(ph) * Math.sin(th), r * Math.cos(ph)], i * 3);
  }
  const dustGeo = new BufferGeometry();
  dustGeo.setAttribute("position", new Float32BufferAttribute(pos, 3));
  const dustMat = new PointsMaterial({ color: c.muted, size: 0.03, transparent: true, opacity: 0.7 });
  const dust = new Points(dustGeo, dustMat);
  scene.add(dust);

  scene.add(new AmbientLight(0xffffff, 0.55));
  const key = new DirectionalLight(0xffffff, 1.6);
  key.position.set(3, 4, 5);
  scene.add(key);

  const recolor = () => {
    c = palette();
    coreMat.color = c.accent; edgeMat.color = c.fg; dustMat.color = c.muted;
    o1.ringMat.color = c.accent; o1.beadMat.color = c.accent; o1.glow.color = c.accent;
    if (reduce) requestAnimationFrame(frame);
  };
  addEventListener("qc-theme", () => requestAnimationFrame(recolor));
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", recolor);

  const resize = () => {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    if (reduce) requestAnimationFrame(frame);
  };
  new ResizeObserver(resize).observe(canvas);

  // drag to spin, with inertia
  let dragging = false, lx = 0, ly = 0, vx = 0, vy = 0, px = 0, py = 0;
  canvas.addEventListener("pointerdown", (e) => { dragging = true; lx = e.clientX; ly = e.clientY; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener("pointerup", () => { dragging = false; });
  canvas.addEventListener("pointermove", (e) => {
    const r = canvas.getBoundingClientRect();
    px = (e.clientX - r.left) / r.width - 0.5; py = (e.clientY - r.top) / r.height - 0.5;
    if (!dragging) return;
    vy = (e.clientX - lx) * 0.006; vx = (e.clientY - ly) * 0.006;
    lx = e.clientX; ly = e.clientY;
    if (reduce) requestAnimationFrame(frame);
  });

  let visible = true, running = false, t = 0, last = performance.now();
  new IntersectionObserver(([e]) => {
    visible = e.isIntersecting;
    if (visible && !reduce && !running) { last = performance.now(); running = true; requestAnimationFrame(frame); }
  }).observe(canvas);

  function frame(now: number) {
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    if (!reduce) t += dt;
    world.rotation.y += vy + (reduce ? 0 : dt * 0.18);
    world.rotation.x += vx;
    vx *= 0.92; vy *= 0.92;
    world.rotation.x += (py * 0.4 - world.rotation.x) * 0.02;
    camera.position.x += (px * 1.2 - camera.position.x) * 0.04;
    camera.lookAt(0, 0, 0);
    core.rotation.y = t * 0.3; core.rotation.z = t * 0.12;
    edges.rotation.y = -t * 0.15; edges.rotation.x = t * 0.08;
    core.scale.setScalar(1 + Math.sin(t * 1.6) * 0.025);
    o1.bead.position.set(Math.cos(t * 1.1 + 0.6) * o1.r, Math.sin(t * 1.1 + 0.6) * o1.r, 0);
    o2.bead.position.set(Math.cos(-t * 0.8 + 2) * o2.r, Math.sin(-t * 0.8 + 2) * o2.r, 0);
    dust.rotation.y = t * 0.02;
    renderer.render(scene, camera);
    running = visible && !reduce;
    if (running) requestAnimationFrame(frame);
  }
  resize();
  requestAnimationFrame(frame);
}

if (canvas) start(canvas);
