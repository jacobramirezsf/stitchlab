// Stitch Lab tool: 3D Garment - a spinnable 3D preview built from the ACTUAL
// blank photo. We take the selected colorway's cutout image, read its alpha
// silhouette, and inflate it into a rounded, photo-textured shell (front +
// back) - so the 3D form is literally the real garment image with volume. Drop
// a design onto the chest, spin it, grab a snapshot. A visualization, not a
// stitch file.
//
// The inflation is a distance-transform of the silhouette (puffier toward the
// middle, flat at the edges), textured with the full-res photo and clipped by
// alphaTest so the edges stay crisp.

import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { SectionBox } from "./shared";
import { GARMENTS } from "../../data/garments";

const LAB_BLANKS = GARMENTS.filter((g) => g.colors.length > 0);
const BACKGROUNDS: Record<string, string> = { studio: "#2a2c31", light: "#e7e5df", dark: "#0d0e11" };

// ─── silhouette → inflated shell ─────────────────────────────────────────────

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = url;
  });
}

/** Two-pass chamfer distance transform: for every opaque pixel, distance to the
 *  nearest transparent pixel (0 outside). Drives how far the shell inflates. */
function edgeDistance(mask: Uint8Array, w: number, h: number): { dist: Float32Array; max: number } {
  const INF = 1e9;
  const d = new Float32Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = mask[i] ? INF : 0;
  const at = (x: number, y: number) => y * w + x;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = at(x, y); if (!mask[i]) continue;
    let m = d[i];
    if (x > 0) m = Math.min(m, d[i - 1] + 1);
    if (y > 0) m = Math.min(m, d[i - w] + 1);
    if (x > 0 && y > 0) m = Math.min(m, d[i - w - 1] + 1.4142);
    if (x < w - 1 && y > 0) m = Math.min(m, d[i - w + 1] + 1.4142);
    d[i] = m;
  }
  let max = 0;
  for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
    const i = at(x, y); if (!mask[i]) continue;
    let m = d[i];
    if (x < w - 1) m = Math.min(m, d[i + 1] + 1);
    if (y < h - 1) m = Math.min(m, d[i + w] + 1);
    if (x < w - 1 && y < h - 1) m = Math.min(m, d[i + w + 1] + 1.4142);
    if (x > 0 && y < h - 1) m = Math.min(m, d[i + w - 1] + 1.4142);
    d[i] = m;
    if (m > max) max = m;
  }
  return { dist: d, max };
}

type Shell = { group: THREE.Group; frontZ: number; decalY: number; dispose: () => void };

function makeTexture(img: HTMLImageElement): THREE.Texture {
  const t = new THREE.Texture(img);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

/** Build the inflated garment shell from a front (and optional back) photo. */
function buildShell(front: HTMLImageElement, back: HTMLImageElement | null): Shell {
  // downscaled mask for the distance transform
  const long = 200;
  const ar = front.width / front.height;
  const mw = ar >= 1 ? long : Math.round(long * ar);
  const mh = ar >= 1 ? Math.round(long / ar) : long;
  const cvs = document.createElement("canvas");
  cvs.width = mw; cvs.height = mh;
  const ctx = cvs.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(front, 0, 0, mw, mh);
  const data = ctx.getImageData(0, 0, mw, mh).data;
  const mask = new Uint8Array(mw * mh);
  let anyAlpha = false;
  for (let i = 0; i < mask.length; i++) { const a = data[i * 4 + 3]; if (a < 250) anyAlpha = true; mask[i] = a > 40 ? 1 : 0; }
  // if the photo has no transparency, treat the whole frame as the garment
  if (!anyAlpha) mask.fill(1);
  const { dist, max } = edgeDistance(mask, mw, mh);
  const maxD = Math.max(1, max);

  // silhouette bbox → center the mesh
  let minX = mw, maxX = 0, minY = mh, maxY = 0;
  for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) if (mask[y * mw + x]) {
    if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  if (maxX < minX) { minX = 0; maxX = mw - 1; minY = 0; maxY = mh - 1; }

  // world sizing: fit the long side to ~2.9
  const fit = 2.9;
  const worldW = ar >= 1 ? fit : fit * ar;
  const worldH = ar >= 1 ? fit / ar : fit;
  const puff = 0.34 * Math.min(worldW, worldH);
  // center offset from the silhouette bbox centroid
  const cxN = ((minX + maxX) / 2) / mw, cyN = ((minY + maxY) / 2) / mh;
  const cx = (cxN - 0.5) * worldW, cy = (0.5 - cyN) * worldH;

  const profile = (d: number) => puff * Math.sin(Math.min(1, d / (maxD * 0.55)) * Math.PI / 2);
  const sampleDist = (px: number, py: number) => {
    const x0 = Math.floor(px), y0 = Math.floor(py);
    const x1 = Math.min(mw - 1, x0 + 1), y1 = Math.min(mh - 1, y0 + 1);
    const fx = px - x0, fy = py - y0;
    const a = dist[y0 * mw + x0], b = dist[y0 * mw + x1], c = dist[y1 * mw + x0], e = dist[y1 * mw + x1];
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + e * fx) * fy;
  };

  const gx = ar >= 1 ? 140 : Math.max(40, Math.round(140 * ar));
  const gy = ar >= 1 ? Math.max(40, Math.round(140 / ar)) : 140;

  const makeSheet = (sign: 1 | -1, mirror: boolean): THREE.BufferGeometry => {
    const vs = (gx + 1) * (gy + 1);
    const pos = new Float32Array(vs * 3), uv = new Float32Array(vs * 2);
    let p = 0, q = 0;
    for (let j = 0; j <= gy; j++) for (let i = 0; i <= gx; i++) {
      const u = i / gx, v = j / gy;
      const z = sign * profile(sampleDist(u * (mw - 1), v * (mh - 1)));
      pos[p++] = (u - 0.5) * worldW - cx;
      pos[p++] = (0.5 - v) * worldH - cy;
      pos[p++] = z;
      uv[q++] = mirror ? 1 - u : u;
      uv[q++] = 1 - v;
    }
    const idx: number[] = [];
    for (let j = 0; j < gy; j++) for (let i = 0; i < gx; i++) {
      const a = j * (gx + 1) + i, b = a + 1, c = a + (gx + 1), d = c + 1;
      if (sign > 0) { idx.push(a, c, b, b, c, d); } else { idx.push(a, b, c, b, d, c); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  };

  const frontTex = makeTexture(front);
  const backTex = back ? makeTexture(back) : frontTex;
  const frontMat = new THREE.MeshStandardMaterial({ map: frontTex, alphaTest: 0.5, roughness: 0.92, metalness: 0, side: THREE.FrontSide });
  const backMat = new THREE.MeshStandardMaterial({ map: backTex, alphaTest: 0.5, roughness: 0.92, metalness: 0, side: THREE.FrontSide });
  const fGeo = makeSheet(1, false), bGeo = makeSheet(-1, true);
  const group = new THREE.Group();
  group.add(new THREE.Mesh(fGeo, frontMat), new THREE.Mesh(bGeo, backMat));

  const dispose = () => {
    fGeo.dispose(); bGeo.dispose(); frontMat.dispose(); backMat.dispose();
    frontTex.dispose(); if (back) backTex.dispose();
  };
  // chest anchor: upper third of the silhouette, just off the inflated surface
  const decalY = 0.14 * worldH;
  return { group, frontZ: puff, decalY, dispose };
}

// ─── component ───────────────────────────────────────────────────────────────

export default function Garment3DTool() {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const three = useRef<{
    renderer: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.PerspectiveCamera; controls: OrbitControls;
    pivot: THREE.Group; decal: THREE.Mesh; decalMat: THREE.MeshBasicMaterial; shell: Shell | null; raf: number;
  } | null>(null);

  const [garmentId, setGarmentId] = useState(LAB_BLANKS.find((g) => g.type === "Hoodie")?.id ?? LAB_BLANKS[0].id);
  const garment = useMemo(() => LAB_BLANKS.find((g) => g.id === garmentId) ?? LAB_BLANKS[0], [garmentId]);
  const [colorSlug, setColorSlug] = useState(garment.colors[0].slug);
  const colorway = useMemo(() => garment.colors.find((c) => c.slug === colorSlug) ?? garment.colors[0], [garment, colorSlug]);

  const [bg, setBg] = useState<keyof typeof BACKGROUNDS>("studio");
  const [scale, setScale] = useState(0.5);
  const [offX, setOffX] = useState(0);
  const [offY, setOffY] = useState(0);
  const [spin, setSpin] = useState(true);
  const [depth, setDepth] = useState(1);
  const [hasArt, setHasArt] = useState(false);
  const [texAspect, setTexAspect] = useState(1);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const fileRef = useRef<HTMLInputElement | null>(null);

  const spinRef = useRef(spin); const offXRef = useRef(offX); const offYRef = useRef(offY);
  const frontZRef = useRef(0.5); const decalYRef = useRef(0.2);
  const depthRef = useRef(depth); const basePuffRef = useRef(0.5);
  useEffect(() => { spinRef.current = spin; }, [spin]);
  useEffect(() => { offXRef.current = offX; }, [offX]);
  useEffect(() => { offYRef.current = offY; }, [offY]);
  useEffect(() => {
    depthRef.current = depth;
    const t = three.current; if (!t?.shell) return;
    t.shell.group.scale.z = depth;
    frontZRef.current = basePuffRef.current * depth * 0.9 + 0.04;
  }, [depth]);

  // one-time scene
  useEffect(() => {
    const mount = mountRef.current; if (!mount) return;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(BACKGROUNDS.studio);
    const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 100);
    camera.position.set(0, 0.05, 5.0);
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    mount.appendChild(renderer.domElement);
    Object.assign(renderer.domElement.style, { width: "100%", height: "100%", display: "block", touchAction: "none" });

    // flat, bright lighting so the baked-in photo reads true; the inflation adds
    // just enough form shading to sell the volume
    scene.add(new THREE.HemisphereLight(0xffffff, 0x9a9aa2, 1.5));
    const key = new THREE.DirectionalLight(0xffffff, 0.55); key.position.set(1.5, 2, 4); scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.35); fill.position.set(-2, 0.5, 2); scene.add(fill);
    const backl = new THREE.DirectionalLight(0xffffff, 0.4); backl.position.set(0, 1, -4); scene.add(backl);

    const pivot = new THREE.Group(); scene.add(pivot);
    const decalMat = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, visible: false });
    const decal = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), decalMat);
    decal.renderOrder = 2; pivot.add(decal);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true; controls.dampingFactor = 0.08;
    controls.minDistance = 2.8; controls.maxDistance = 9; controls.target.set(0, 0, 0);

    const resize = () => {
      const w = mount.clientWidth, h = mount.clientHeight || 480;
      renderer.setSize(w, h, false); camera.aspect = w / Math.max(1, h); camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize); ro.observe(mount);

    const state = { renderer, scene, camera, controls, pivot, decal, decalMat, shell: null as Shell | null, raf: 0 };
    const loop = () => {
      if (spinRef.current) pivot.rotation.y += 0.005;
      const th = pivot.rotation.y, r = frontZRef.current;
      decal.rotation.y = th;
      decal.position.x = Math.sin(th) * r + Math.cos(th) * offXRef.current;
      decal.position.z = Math.cos(th) * r - Math.sin(th) * offXRef.current;
      decal.position.y = decalYRef.current + offYRef.current;
      controls.update();
      renderer.render(scene, camera);
      state.raf = requestAnimationFrame(loop);
    };
    state.raf = requestAnimationFrame(loop);
    three.current = state;

    return () => {
      cancelAnimationFrame(state.raf); ro.disconnect(); controls.dispose();
      state.shell?.dispose(); decal.geometry.dispose(); decalMat.dispose(); renderer.dispose();
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
      three.current = null;
    };
  }, []);

  // (re)build the shell from the selected colorway photo
  const buildToken = useRef(0);
  useEffect(() => {
    const t = three.current; if (!t) return;
    const token = ++buildToken.current;
    (async () => {
      try {
        const front = await loadImage(colorway.imageFront);
        if (token !== buildToken.current) return;
        const back = colorway.imageBack ? await loadImage(colorway.imageBack).catch(() => null) : null;
        if (token !== buildToken.current) return;
        const shell = buildShell(front, back);
        if (token !== buildToken.current) { shell.dispose(); return; }
        if (t.shell) { t.pivot.remove(t.shell.group); t.shell.dispose(); }
        shell.group.scale.z = depthRef.current;
        t.pivot.add(shell.group);
        t.shell = shell;
        basePuffRef.current = shell.frontZ;
        frontZRef.current = shell.frontZ * depthRef.current * 0.9 + 0.04;
        decalYRef.current = shell.decalY;
        setStatus("ready");
      } catch {
        if (token === buildToken.current) setStatus("error");
      }
    })();
  }, [colorway]);

  useEffect(() => { const t = three.current; if (t) (t.scene.background as THREE.Color).set(BACKGROUNDS[bg]); }, [bg]);
  useEffect(() => {
    const t = three.current; if (!t) return;
    t.decal.scale.set(scale, scale / (texAspect || 1), 1);
  }, [scale, texAspect]);

  const pickGarment = (id: string) => {
    const g = LAB_BLANKS.find((x) => x.id === id) ?? LAB_BLANKS[0];
    setStatus("loading"); setGarmentId(id); setColorSlug(g.colors[0].slug); setOffX(0); setOffY(0);
  };
  const pickColor = (slug: string) => { setStatus("loading"); setColorSlug(slug); };

  const loadArt = (file: File | undefined) => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    new THREE.TextureLoader().load(url, (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
      const t = three.current; if (!t) { URL.revokeObjectURL(url); return; }
      t.decalMat.map = tex; t.decalMat.visible = true; t.decalMat.needsUpdate = true;
      const img = tex.image as HTMLImageElement;
      setTexAspect(img && img.height ? img.width / img.height : 1);
      setHasArt(true); URL.revokeObjectURL(url);
    }, undefined, () => URL.revokeObjectURL(url));
  };

  const snapshot = () => {
    const t = three.current; if (!t) return;
    t.renderer.render(t.scene, t.camera);
    const a = document.createElement("a");
    a.href = t.renderer.domElement.toDataURL("image/png");
    a.download = `bayside-${garment.id}-${colorway.slug}-3d.png`; a.click();
  };
  const resetView = () => {
    const t = three.current; if (!t) return;
    t.pivot.rotation.y = 0; t.camera.position.set(0, 0.05, 5.0); t.controls.target.set(0, 0, 0); t.controls.update();
  };

  return (
    <div className="flex flex-col lg:flex-row gap-4">
      <div className="lg:w-[300px] shrink-0 space-y-3">
        <SectionBox eyebrow="blank">
          <select value={garmentId} onChange={(e) => pickGarment(e.target.value)}
            className="w-full bg-background border border-hairline rounded px-2 py-1.5 text-sm text-foreground">
            {LAB_BLANKS.map((g) => (<option key={g.id} value={g.id}>{g.name} · {g.brand}</option>))}
          </select>
          <p className="text-[0.6875rem] text-mid">{garment.type} · {garment.colors.length} colorways{garment.weight ? ` · ${garment.weight}` : ""}</p>
        </SectionBox>

        <SectionBox eyebrow={`colorway · ${colorway.name}`}>
          <div className="flex flex-wrap gap-1.5">
            {garment.colors.map((c) => (
              <button key={c.slug} type="button" title={c.name} onClick={() => pickColor(c.slug)}
                className={`w-7 h-7 rounded-full border transition-all ${colorSlug === c.slug ? "ring-2 ring-accent ring-offset-2 ring-offset-bg scale-110" : "border-hairline"}`}
                style={{ backgroundColor: c.hex }} />
            ))}
          </div>
        </SectionBox>

        <SectionBox eyebrow="design">
          <input ref={fileRef} type="file" accept="image/png,image/webp,image/jpeg" className="hidden" onChange={(e) => loadArt(e.target.files?.[0])} />
          <button type="button" onClick={() => fileRef.current?.click()} className="w-full border border-fg px-3 py-2 text-[0.8125rem] uppercase tracking-[0.08em] hover:bg-fg hover:text-bg transition-colors">
            {hasArt ? "Change design" : "Drop a design (PNG)"}
          </button>
          <p className="text-[0.6875rem] text-mid leading-relaxed">A transparent PNG reads best. Nothing uploads; it stays in your browser.</p>
        </SectionBox>

        <SectionBox eyebrow="form">
          <label className="block text-[0.75rem] text-mid">Depth
            <input type="range" min={0.35} max={1.7} step={0.01} value={depth} onChange={(e) => setDepth(+e.target.value)} className="w-full accent-accent" />
          </label>
          <p className="text-[0.625rem] text-dim">Flat reads like a curved panel; puffy gives it more volume.</p>
        </SectionBox>

        <SectionBox eyebrow="placement">
          <label className="block text-[0.75rem] text-mid">Scale
            <input type="range" min={0.12} max={1.4} step={0.01} value={scale} onChange={(e) => setScale(+e.target.value)} className="w-full accent-accent" />
          </label>
          <label className="block text-[0.75rem] text-mid">Left / right
            <input type="range" min={-0.6} max={0.6} step={0.01} value={offX} onChange={(e) => setOffX(+e.target.value)} className="w-full accent-accent" />
          </label>
          <label className="block text-[0.75rem] text-mid">Up / down
            <input type="range" min={-0.9} max={1} step={0.01} value={offY} onChange={(e) => setOffY(+e.target.value)} className="w-full accent-accent" />
          </label>
        </SectionBox>

        <SectionBox eyebrow="view">
          <div className="flex flex-wrap gap-1.5">
            {(Object.keys(BACKGROUNDS) as (keyof typeof BACKGROUNDS)[]).map((b) => (
              <button key={b} type="button" onClick={() => setBg(b)}
                className={`px-2.5 py-1 text-[0.6875rem] uppercase tracking-[0.06em] border ${bg === b ? "border-fg bg-fg text-bg" : "border-hairline text-mid hover:border-fg"}`}>{b}</button>
            ))}
          </div>
          <label className="flex items-center gap-2 text-[0.75rem] text-mid">
            <input type="checkbox" checked={spin} onChange={(e) => setSpin(e.target.checked)} className="accent-accent" /> auto-spin
          </label>
          <div className="flex gap-1.5">
            <button type="button" onClick={resetView} className="flex-1 border border-hairline px-2 py-1.5 text-[0.6875rem] uppercase tracking-[0.06em] text-mid hover:border-fg hover:text-fg">Reset</button>
            <button type="button" onClick={snapshot} className="flex-1 border border-fg px-2 py-1.5 text-[0.6875rem] uppercase tracking-[0.06em] hover:bg-fg hover:text-bg transition-colors">Snapshot</button>
          </div>
        </SectionBox>
      </div>

      <div className="relative flex-1 min-h-[420px] h-[62vh]">
        <div ref={mountRef} className="absolute inset-0 border border-hairline bg-card overflow-hidden rounded-sm" />
        {status !== "ready" && (
          <div className="absolute inset-0 flex items-center justify-center text-[0.8125rem] text-mid pointer-events-none">
            {status === "loading" ? "Shaping the blank…" : "Couldn't load that blank's photo."}
          </div>
        )}
      </div>
    </div>
  );
}
