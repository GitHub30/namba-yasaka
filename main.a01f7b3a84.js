// WebGPU host: loads the baked world + the Rust/WASM core, renders with hand-written WGSL. No rendering libraries.
import { COMMON, WORLD, SKY, POST, TAA } from "./shaders.329a95c47d.js";

const $ = (id) => document.getElementById(id);
const hud = $("hud"), msg = $("msg"), canvas = $("c");
const Q = new URLSearchParams(location.search);
const fail = (t) => { msg.textContent = t; msg.style.display = "grid"; throw new Error(t); };
const A = new URL(document.body.dataset.assets || "../assets/", location.href).href;
// phones and tablets get touch controls, automatic fullscreen and landscape; desktops are left alone
const BUILD = document.body.dataset.build || "dev";
addEventListener("error", (e) => { const h = document.getElementById("err"); if (h) h.textContent = `エラー: ${e.message} (${(e.filename || "").split("/").pop()}:${e.lineno})`; });
addEventListener("unhandledrejection", (e) => { const h = document.getElementById("err"); if (h && !/pointer lock/i.test(String(e.reason))) h.textContent = `エラー: ${e.reason?.message || e.reason}`; });
const MOBILE = Q.has("mobile") ? Q.get("mobile") !== "0"
  : (navigator.maxTouchPoints > 0 && (/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || (matchMedia("(pointer: coarse)").matches && !matchMedia("(any-pointer: fine)").matches)));
if (MOBILE) document.body.classList.add("mobile");

async function main() {
  if (!navigator.gpu) fail("このブラウザは WebGPU に対応していません。Chrome / Edge の最新版で開いてください。");
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) fail("WebGPU アダプターを取得できませんでした。");
  const device = await adapter.requestDevice({ requiredLimits: { maxBufferSize: Math.min(adapter.limits.maxBufferSize, 1 << 30) } });
  device.lost.then((e) => { msg.textContent = "GPU デバイスが失われました: " + e.message; msg.style.display = "grid"; });
  const ctx = canvas.getContext("webgpu");
  const fmt = navigator.gpu.getPreferredCanvasFormat();
  ctx.configure({ device, format: fmt, alphaMode: "opaque" });

  // ---------------------------------------------------------------- assets
  let loadedBytes = 0;
  const stage = (t) => { window.__stage = t; msg.textContent = t; };
  msg.style.display = "grid"; stage("ワールドを読み込み中…");
  // large files may be split into parts for hosting (see tools/make_dist.py): assets/manifest.json lists them
  const manifest = await fetch(A + "manifest.json?v=" + BUILD, { cache: "no-store" }).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
  const getBuf = async (url) => {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    const b = await r.arrayBuffer();
    loadedBytes += b.byteLength; stage(`ワールドを読み込み中… ${(loadedBytes / 1048576).toFixed(0)} MB`);
    return b;
  };
  const bin = async (name) => {
    const parts = manifest[name];
    const ver = "?v=" + ((manifest.__versions || {})[name] || BUILD);
    if (!parts) return getBuf(A + name + ver);
    const bufs = await Promise.all(parts.map((p) => getBuf(A + p + ver)));
    const out = new Uint8Array(bufs.reduce((n, b) => n + b.byteLength, 0));
    let o = 0; for (const b of bufs) { out.set(new Uint8Array(b), o); o += b.byteLength; }
    return out.buffer;
  };
  const json = (name) => fetch(A + name + "?v=" + ((manifest.__versions || {})[name] || BUILD)).then((r) => { if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`); return r.json(); });
  const VEH = ["police", "firetruck"];
  const [world, vtxBuf, idxBuf, instBuf, colBuf, wasmBuf, charJ, charV, charI, ...vehData] = await Promise.all([
    json("world.json"), bin("world_vtx.bin"), bin("world_idx.bin"), bin("inst.bin"), bin("collide.bin"),
    fetch(new URL("core.wasm?v=" + BUILD, import.meta.url)).then((r) => r.arrayBuffer()),
    json("char.json"), bin("char_vtx.bin"), bin("char_idx.bin"),
    ...VEH.flatMap((n) => [json(n + ".json"), bin(n + "_vtx.bin"), bin(n + "_idx.bin")]),
  ]);
  stage("コアを起動中…");
  const wasm = (await WebAssembly.instantiate(wasmBuf, {})).instance.exports;
  wasm.init();
  const mem = () => wasm.memory.buffer;
  const put = (src) => {
    const bytes = src.byteLength; const p = wasm.alloc(bytes);
    new Uint8Array(mem(), p, bytes).set(new Uint8Array(src.buffer ?? src, src.byteOffset ?? 0, bytes));
    return p;
  };
  const C = world.collide;
  wasm.set_collision(put(new Uint8Array(colBuf)), C.w, C.h, C.x0, C.y0, C.cell);
  const chunks = world.chunks;
  const ca = new Float32Array(chunks.length * 7);
  chunks.forEach((c, i) => ca.set([...c.min, ...c.max, c.transparent ? 1 : 0], i * 7));
  wasm.set_chunks(put(ca), chunks.length);
  const groups = [];
  for (const m of world.instances.meshes) for (const g of m.groups) groups.push({ m, g });
  const ga = new Float32Array(Math.max(groups.length, 1) * 7);
  groups.forEach(({ g }, i) => ga.set([...g.min, ...g.max, g.count], i * 7));
  wasm.set_groups(put(ga), groups.length);

  stage("GPU にデータを転送中…");
  const mkBuf = (data, usage) => {
    const size = Math.max(4, (data.byteLength + 3) & ~3);
    const b = device.createBuffer({ size, usage, mappedAtCreation: true });
    new Uint8Array(b.getMappedRange()).set(new Uint8Array(data.buffer ?? data, data.byteOffset ?? 0, data.byteLength));
    b.unmap(); return b;
  };
  const VB = mkBuf(vtxBuf, GPUBufferUsage.VERTEX), IB = mkBuf(idxBuf, GPUBufferUsage.INDEX);
  const L = world.instances.layout;
  const iv = new Uint8Array(instBuf, 0, L.vtx_bytes), ii = new Uint8Array(instBuf, L.vtx_bytes, L.idx_bytes);
  const im = new Uint8Array(instBuf, L.vtx_bytes + L.idx_bytes, L.mat_bytes);
  const IVB = mkBuf(iv, GPUBufferUsage.VERTEX), IIB = mkBuf(ii, GPUBufferUsage.INDEX), IMB = mkBuf(im, GPUBufferUsage.VERTEX);
  const hasInst = L.count > 0;
  // dynamic objects: matrix slots follow the core (0 police body, 1-4 wheels, 5 engine body, 6-11 wheels, 12-21 character)
  const DYN_BASE = [0, 5];
  const vehicles = VEH.map((n, i) => ({ name: n, info: vehData[i * 3], vb: mkBuf(vehData[i * 3 + 1], GPUBufferUsage.VERTEX), ib: mkBuf(vehData[i * 3 + 2], GPUBufferUsage.INDEX), base: DYN_BASE[i], door: 22 + i * 2 }));
  const chr = { info: charJ, vb: mkBuf(charV, GPUBufferUsage.VERTEX), ib: mkBuf(charI, GPUBufferUsage.INDEX), base: 12 };

  // ---------------------------------------------------------------- pipelines
  const SHADOW = Math.min(MOBILE ? 2048 : 4096, device.limits.maxTextureDimension2D);
  const shadowTex = device.createTexture({ size: [SHADOW, SHADOW], format: "depth32float", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
  const shadowView = shadowTex.createView();
  const FRAME_FLOATS = 84;
  const frameUBO = device.createBuffer({ size: FRAME_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const shadowUBO = device.createBuffer({ size: FRAME_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const lFrame = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {} }] });
  const lWorld = device.createBindGroupLayout({ entries: [
    { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {} },
    { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "depth" } },
    { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "comparison" } },
  ] });
  const cmpSamp = device.createSampler({ compare: "less-equal", magFilter: "linear", minFilter: "linear" });
  const bgWorld = device.createBindGroup({ layout: lWorld, entries: [{ binding: 0, resource: { buffer: frameUBO } }, { binding: 1, resource: shadowView }, { binding: 2, resource: cmpSamp }] });
  const bgFrame = device.createBindGroup({ layout: lFrame, entries: [{ binding: 0, resource: { buffer: frameUBO } }] });
  const bgShadow = device.createBindGroup({ layout: lFrame, entries: [{ binding: 0, resource: { buffer: shadowUBO } }] });

  stage("シェーダーをコンパイル中…");
  const modWorld = device.createShaderModule({ code: COMMON + WORLD });
  const modSky = device.createShaderModule({ code: COMMON + SKY });
  const modPost = device.createShaderModule({ code: POST });
  const modTaa = device.createShaderModule({ code: TAA });
  for (const [n, m] of [["world", modWorld], ["sky", modSky], ["post", modPost], ["taa", modTaa]]) {
    const info = await m.getCompilationInfo();
    for (const e of info.messages) if (e.type === "error") fail(`シェーダー ${n} のエラー: ${e.lineNum}:${e.linePos} ${e.message}`);
  }
  stage("パイプラインを作成中…");
  const vAttr = { arrayStride: 24, attributes: [
    { shaderLocation: 0, offset: 0, format: "float32x3" }, { shaderLocation: 1, offset: 12, format: "snorm16x2" },
    { shaderLocation: 2, offset: 16, format: "unorm8x4" }, { shaderLocation: 3, offset: 20, format: "uint8x4" }] };
  const iAttr = { arrayStride: 48, stepMode: "instance", attributes: [
    { shaderLocation: 4, offset: 0, format: "float32x4" }, { shaderLocation: 5, offset: 16, format: "float32x4" }, { shaderLocation: 6, offset: 32, format: "float32x4" }] };
  const HDR = "rgba16float", DEPTH = "depth24plus";
  const plWorld = device.createPipelineLayout({ bindGroupLayouts: [lWorld] });
  const plFrame = device.createPipelineLayout({ bindGroupLayouts: [lFrame] });
  const mkMain = (entry, buffers, blend, depthWrite) => device.createRenderPipeline({
    layout: plWorld, vertex: { module: modWorld, entryPoint: entry, buffers },
    fragment: { module: modWorld, entryPoint: "fsWorld", targets: [{ format: HDR, blend }] },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: { format: DEPTH, depthWriteEnabled: depthWrite, depthCompare: "less" } });
  const alphaBlend = { color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" }, alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" } };
  // one uniform buffer for every dynamic object's matrix + lamp state, addressed with a dynamic offset
  const N_DYN = wasm.dyn_count(), DYN_ALIGN = 256;
  const lModel = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { hasDynamicOffset: true, minBindingSize: 80 } }] });
  const dynUBO = device.createBuffer({ size: N_DYN * DYN_ALIGN, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const bgModel = device.createBindGroup({ layout: lModel, entries: [{ binding: 0, resource: { buffer: dynUBO, size: 80 } }] });
  const dynData = new Float32Array((N_DYN * DYN_ALIGN) / 4);
  const plDyn = device.createPipelineLayout({ bindGroupLayouts: [lWorld, lModel] });
  const mkDyn = (blend, depthWrite) => device.createRenderPipeline({
    layout: plDyn, vertex: { module: modWorld, entryPoint: "vsDyn", buffers: [vAttr] },
    fragment: { module: modWorld, entryPoint: "fsWorld", targets: [{ format: HDR, blend }] },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: { format: DEPTH, depthWriteEnabled: depthWrite, depthCompare: "less" } });
  const pOpaque = mkMain("vsWorld", [vAttr], undefined, true);
  const pInst = mkMain("vsInst", [vAttr, iAttr], undefined, true);
  const pTrans = mkMain("vsWorld", [vAttr], alphaBlend, false);
  const pDyn = mkDyn(undefined, true), pDynTrans = mkDyn(alphaBlend, false);
  const mkShadow = (entry, buffers) => device.createRenderPipeline({
    layout: plFrame, vertex: { module: modWorld, entryPoint: entry, buffers },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: { format: "depth32float", depthWriteEnabled: true, depthCompare: "less", depthBias: 2, depthBiasSlopeScale: 2.0 } });
  const pShadow = mkShadow("vsShadow", [vAttr]), pShadowInst = mkShadow("vsShadowInst", [vAttr, iAttr]);
  const pSky = device.createRenderPipeline({ layout: plFrame, vertex: { module: modSky, entryPoint: "vs" },
    fragment: { module: modSky, entryPoint: "fs", targets: [{ format: HDR }] },
    primitive: { topology: "triangle-list" }, depthStencil: { format: DEPTH, depthWriteEnabled: false, depthCompare: "less-equal" } });
  const lPost = device.createBindGroupLayout({ entries: [
    { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: {} }, { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
    { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: {} },
    { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "depth" } }] });
  const pPost = device.createRenderPipeline({ layout: device.createPipelineLayout({ bindGroupLayouts: [lPost] }),
    vertex: { module: modPost, entryPoint: "vs" }, fragment: { module: modPost, entryPoint: "fs", targets: [{ format: fmt }] } });
  const linSamp = device.createSampler({ magFilter: "linear", minFilter: "linear" });
  const lTaa = device.createBindGroupLayout({ entries: [
    { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: {} }, { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
    { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: {} }, { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "depth" } },
    { binding: 4, visibility: GPUShaderStage.FRAGMENT, buffer: {} }] });
  const pTaa = device.createRenderPipeline({ layout: device.createPipelineLayout({ bindGroupLayouts: [lTaa] }),
    vertex: { module: modTaa, entryPoint: "vs" }, fragment: { module: modTaa, entryPoint: "fs", targets: [{ format: "rgba16float" }] } });
  const taaUBO = device.createBuffer({ size: 176, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const taaData = new Float32Array(44);
  const prevVP = new Float32Array(16);
  const HALTON = Array.from({ length: 8 }, (_, i) => { const h = (n, b) => { let f = 1, r = 0; while (n > 0) { f /= b; r += f * (n % b); n = Math.floor(n / b); } return r; }; return [h(i + 1, 2) - 0.5, h(i + 1, 3) - 0.5]; });
  let histTex = [], histView = [], bgTaa = [], bgPostHist = [], histValid = false, frameNo = 0;
  const postUBO = device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

  // ---------------------------------------------------------------- render targets (dynamic resolution)
  let scale = Number(Q.get("scale") || (MOBILE ? 0.55 : 0.66)), autoScale = !Q.has("scale");
  let hdrTex, hdrView, depthTex, depthView, bgPost, RW = 0, RH = 0;
  function resize() {
    const dpr = Math.min(devicePixelRatio || 1, 1.5);
    const cw = Math.max(2, Math.floor(canvas.clientWidth * dpr)), ch = Math.max(2, Math.floor(canvas.clientHeight * dpr));
    if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
    const w = Math.max(2, Math.round(cw * scale / 2) * 2), h = Math.max(2, Math.round(ch * scale / 2) * 2);
    if (w === RW && h === RH) return;
    RW = w; RH = h; hdrTex?.destroy(); depthTex?.destroy();
    hdrTex = device.createTexture({ size: [w, h], format: HDR, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    hdrView = hdrTex.createView();
    depthTex = device.createTexture({ size: [w, h], format: DEPTH, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    depthView = depthTex.createView();
    const postGroup = (view) => device.createBindGroup({ layout: lPost, entries: [{ binding: 0, resource: view }, { binding: 1, resource: linSamp }, { binding: 2, resource: { buffer: postUBO } }, { binding: 3, resource: depthView }] });
    bgPost = postGroup(hdrView);
    histTex.forEach((t) => t.destroy());
    histTex = [0, 1].map(() => device.createTexture({ size: [w, h], format: HDR, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING }));
    histView = histTex.map((t) => t.createView());
    // bgTaa[i] reads history i and is used while writing history 1 - i
    bgTaa = [0, 1].map((i) => device.createBindGroup({ layout: lTaa, entries: [{ binding: 0, resource: hdrView }, { binding: 1, resource: histView[i] },
      { binding: 2, resource: linSamp }, { binding: 3, resource: depthView }, { binding: 4, resource: { buffer: taaUBO } }] }));
    bgPostHist = histView.map(postGroup);
    histValid = false;
  }

  // ---------------------------------------------------------------- input
  const keys = new Set();
  const fx = { ssao: Q.get("ssao") !== "0", taa: Q.get("taa") !== "0" };
  const once = { use: false, fly: false, beacon: false, left: false, right: false, view: false };
  let lookX = 0, lookY = 0, timeSpeed = Number(Q.get("speed") || 0), lodBias = 1, flying = false, hour = 0;
  addEventListener("keydown", (e) => {
    keys.add(e.code);
    if (e.repeat) return;
    if (e.code === "KeyF") once.fly = true;
    if (e.code === "KeyE" && !flying) once.use = true;
    if (e.code === "KeyL") once.beacon = true;
    if (e.code === "KeyZ") once.left = true;
    if (e.code === "KeyC") once.right = true;
    if (e.code === "KeyV") once.view = true;
    if (e.code === "KeyO") fx.ssao = !fx.ssao;
    if (e.code === "KeyP") { fx.taa = !fx.taa; histValid = false; }
    if (e.code === "KeyT") timeSpeed = timeSpeed ? 0 : 0.5;
    if (e.code === "BracketRight") wasm.set_hour(hour + 1);
    if (e.code === "BracketLeft") wasm.set_hour(hour - 1);
    if (e.code === "KeyH") { const d = hud.style.display === "none" ? "block" : "none"; hud.style.display = d; $("help").style.display = d; }
    if (e.code === "Minus") { autoScale = false; scale = Math.max(0.3, scale - 0.05); }
    if (e.code === "Equal") { autoScale = false; scale = Math.min(1.0, scale + 0.05); }
    if (e.code === "Space") e.preventDefault();
  });
  addEventListener("keyup", (e) => keys.delete(e.code));
  addEventListener("blur", () => keys.clear());
  // mouse look: pointer lock where the browser allows it, otherwise hold the mouse button and drag
  let dragging = false;
  canvas.addEventListener("mousedown", () => { if (MOBILE) return; dragging = true; try { const r = canvas.requestPointerLock?.(); r?.catch?.(() => {}); } catch {} });
  addEventListener("mouseup", () => { dragging = false; });
  addEventListener("mousemove", (e) => { if (document.pointerLockElement === canvas || dragging) { lookX += e.movementX; lookY += e.movementY; } });
  document.addEventListener("pointerlockchange", () => { $("help").style.opacity = document.pointerLockElement === canvas ? 0.25 : 1; });

  // ---------------------------------------------------------------- touch controls (mobile only)
  const touch = { mx: 0, my: 0, run: false, brake: false };
  if (MOBILE) {
    const rootEl = $("root"), stick = $("stick"), knob = $("knob");
    // when the page is turned on its side by CSS (portrait phone without orientation lock) screen deltas turn with it
    const rotated = () => document.body.classList.contains("rotated");
    const toLocal = (dx, dy) => (rotated() ? [dy, -dx] : [dx, dy]);
    const updateRotation = () => document.body.classList.toggle("rotated", innerHeight > innerWidth);
    addEventListener("resize", updateRotation); addEventListener("orientationchange", updateRotation); updateRotation();
    const goFullscreen = async () => {
      try { if (!document.fullscreenElement) await (document.documentElement.requestFullscreen?.({ navigationUI: "hide" }) ?? document.documentElement.webkitRequestFullscreen?.()); } catch {}
      try { await screen.orientation?.lock?.("landscape"); } catch {}
      updateRotation();
    };
    const fullBtn = $("bFull");
    const syncFull = () => { fullBtn.style.display = document.fullscreenElement || !document.documentElement.requestFullscreen ? "none" : "grid"; };
    document.addEventListener("fullscreenchange", syncFull);
    $("start").addEventListener("pointerup", async () => { $("start").style.display = "none"; await goFullscreen(); syncFull(); });
    fullBtn.addEventListener("pointerup", goFullscreen);
    // Movement stick and look, both driven by raw touch events on the whole screen and by how far each finger has moved
    // since it went down (no element rectangles involved, so page rotation, safe areas and browser bars cannot skew it):
    //  - a finger that lands on the left half makes the stick appear under it and drives movement
    //  - any other finger drags the view
    const SR = 56;                                       // stick travel in CSS px
    const toScreenLocal = (x, y) => (rotated() ? [y, innerWidth - x] : [x, y]);   // screen px -> px inside #root
    const rootW = () => (rotated() ? innerHeight : innerWidth);
    let moveId = null, moveFrom = [0, 0];
    const looks = new Map();
    const onControl = (t) => !!(t.target && t.target.closest && t.target.closest(".tb, #start"));
    const stickSet = (dx, dy) => {
      const l = Math.hypot(dx, dy);
      if (l > SR) { dx *= SR / l; dy *= SR / l; }
      knob.style.transform = `translate(${dx}px, ${dy}px)`;
      const dead = (v) => (Math.abs(v) < 0.12 ? 0 : v);
      touch.mx = dead(dx / SR); touch.my = dead(-dy / SR);
    };
    const dbg = { touches: 0, pointers: 0, last: "-" };
    const fingerDown = (id, x, y, target) => {
      if (target && target.closest && target.closest(".tb, #start")) return false;
      updateRotation();
      const [lx, ly] = toScreenLocal(x, y);
      if (moveId === null && lx < rootW() * 0.5) {
        moveId = id; moveFrom = [x, y];
        stick.style.left = `${lx - 66}px`; stick.style.top = `${ly - 66}px`; stick.style.display = "block";
        stickSet(0, 0); dbg.last = "move";
      } else {
        looks.set(id, [x, y]); dbg.last = "look";
      }
      return true;
    };
    const fingerMove = (id, x, y) => {
      if (id === moveId) {
        const [dx, dy] = toLocal(x - moveFrom[0], y - moveFrom[1]);
        stickSet(dx, dy);
      } else if (looks.has(id)) {
        const q = looks.get(id);
        const [dx, dy] = toLocal(x - q[0], y - q[1]);
        lookX += dx * 2.2; lookY += dy * 2.2;
        looks.set(id, [x, y]);
      }
    };
    const fingerUp = (id) => {
      if (id === moveId) { moveId = null; touch.mx = touch.my = 0; stick.style.display = "none"; knob.style.transform = ""; }
      looks.delete(id);
    };
    // Touch events are the primary source. Pointer events are a fallback for browsers that deliver no touch events,
    // and are ignored as soon as one touch event has been seen (so nothing is counted twice).
    let sawTouch = false;
    const opt = { passive: false, capture: true };
    document.addEventListener("touchstart", (e) => {
      sawTouch = true; dbg.touches++;
      let ours = false;
      for (const t of e.changedTouches) ours = fingerDown(t.identifier, t.clientX, t.clientY, t.target) || ours;
      if (ours && e.cancelable) e.preventDefault();
    }, opt);
    document.addEventListener("touchmove", (e) => {
      for (const t of e.changedTouches) fingerMove(t.identifier, t.clientX, t.clientY);
      if (e.cancelable) e.preventDefault();
    }, opt);
    const touchEnd = (e) => { for (const t of e.changedTouches) fingerUp(t.identifier); };
    document.addEventListener("touchend", touchEnd, opt); document.addEventListener("touchcancel", touchEnd, opt);
    document.addEventListener("pointerdown", (e) => { if (!sawTouch && e.pointerType !== "mouse") { dbg.pointers++; fingerDown(1000 + e.pointerId, e.clientX, e.clientY, e.target); } }, opt);
    document.addEventListener("pointermove", (e) => { if (!sawTouch && e.pointerType !== "mouse") fingerMove(1000 + e.pointerId, e.clientX, e.clientY); }, opt);
    const pEnd = (e) => { if (!sawTouch && e.pointerType !== "mouse") fingerUp(1000 + e.pointerId); };
    document.addEventListener("pointerup", pEnd, opt); document.addEventListener("pointercancel", pEnd, opt);
    window.__touchDebug = () => `touch ${dbg.touches} ptr ${dbg.pointers} ${dbg.last} stick ${touch.mx.toFixed(2)},${touch.my.toFixed(2)}${rotated() ? " rot" : ""}`;
    window.__touch = touch;
    // buttons
    const tap = (id, fn) => $(id).addEventListener("pointerdown", (e) => { e.preventDefault(); fn(); });
    const hold = (id, key) => {
      const el = $(id);
      el.addEventListener("pointerdown", (e) => { e.preventDefault(); el.setPointerCapture(e.pointerId); touch[key] = true; el.classList.add("on"); });
      const up = () => { touch[key] = false; el.classList.remove("on"); };
      el.addEventListener("pointerup", up); el.addEventListener("pointercancel", up);
    };
    tap("bUse", () => { once.use = true; }); tap("bBeacon", () => { once.beacon = true; }); tap("bLeft", () => { once.left = true; });
    tap("bRight", () => { once.right = true; }); tap("bView", () => { once.view = true; });
    hold("bBrake", "brake"); hold("bRun", "run");
    rootEl.addEventListener("contextmenu", (e) => e.preventDefault());
    document.addEventListener("touchmove", (e) => e.preventDefault(), { passive: false });
  }

  if (Q.has("pos")) { const p = Q.get("pos").split(",").map(Number); wasm.teleport(p[0], p[1], p[2] || 0, p[3] ?? 0, p[4] ?? 0, Q.get("fly") === "1" ? 1 : 0); }
  if (Q.has("hour")) wasm.set_hour(Number(Q.get("hour")));

  // ---------------------------------------------------------------- sirens (recordings supplied by the project owner)
  // One looping sound per vehicle, heard while driving it with the warning lamps on. Decoded with Web Audio so the
  // loop has no gap; the context can only start after a key press or touch, which getting into a vehicle always is.
  const siren = { ctx: null, buf: {}, src: null, gain: null, playing: 0 };
  const sirenFiles = { 1: "siren_police.m4a", 2: "siren_firetruck.m4a" };
  const sirenInit = () => {
    if (siren.ctx) { if (siren.ctx.state === "suspended") siren.ctx.resume().catch(() => {}); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    siren.ctx = new AC();
    for (const [k, file] of Object.entries(sirenFiles)) {
      fetch(A + file + "?v=" + ((manifest.__versions || {})[file] || BUILD)).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(file + " " + r.status))))
        .then((b) => siren.ctx.decodeAudioData(b)).then((buf) => { siren.buf[k] = buf; }).catch((e) => console.warn("siren", e));
    }
  };
  for (const ev of ["keydown", "pointerdown", "touchend"]) addEventListener(ev, sirenInit, { passive: true });
  const sirenSet = (which) => {                           // 0 = silence, 1 = police car, 2 = fire engine
    if (!siren.ctx || which === siren.playing) return;
    if (which && !siren.buf[which]) return;               // not decoded yet: try again next frame
    const t = siren.ctx.currentTime;
    if (siren.src) { const g = siren.gain, s = siren.src; g.gain.setTargetAtTime(0, t, 0.08); setTimeout(() => { try { s.stop(); } catch {} }, 400); siren.src = null; }
    siren.playing = which;
    if (!which) return;
    const src = siren.ctx.createBufferSource(), gain = siren.ctx.createGain();
    src.buffer = siren.buf[which]; src.loop = true;
    gain.gain.setValueAtTime(0, t); gain.gain.setTargetAtTime(Number(Q.get("vol") ?? 0.6), t, 0.12);
    src.connect(gain).connect(siren.ctx.destination); src.start();
    siren.src = src; siren.gain = gain;
  };
  addEventListener("visibilitychange", () => { if (document.hidden) sirenSet(0); });
  window.__siren = siren;

  // ---------------------------------------------------------------- frame loop
  const fu = new Float32Array(FRAME_FLOATS);
  let last = performance.now(), acc = 0, frames = 0, fps = 0, ms = 0, shadowFrames = 0, tris = 0, draws = 0;
  const stats = (window.__stats = { fps: 0, ms: 0, tris: 0, draws: 0, scale, w: 0, h: 0, ready: false });
  msg.style.display = "none";

  function drawShadow(enc) {
    const p = enc.beginRenderPass({ colorAttachments: [], depthStencilAttachment: { view: shadowView, depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "store" } });
    p.setBindGroup(0, bgShadow);
    p.setPipeline(pShadow); p.setVertexBuffer(0, VB); p.setIndexBuffer(IB, "uint32");
    for (const c of chunks) if (!c.transparent) p.drawIndexed(c.count, 1, c.first, c.base, 0);
    if (hasInst) {
      p.setPipeline(pShadowInst); p.setVertexBuffer(0, IVB); p.setVertexBuffer(1, IMB); p.setIndexBuffer(IIB, "uint32");
      for (const { m, g } of groups) p.drawIndexed(m.count, g.count, m.first, m.base, g.first);
    }
    p.end();
  }

  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    step(dt);
    requestAnimationFrame(frame);
  }
  // Benchmark that does not depend on requestAnimationFrame: renders n frames back to back, waiting for the GPU each time.
  window.__bench = async (n = 40) => {
    const t = [];
    for (let i = 0; i < n + 5; i++) {
      const t0 = performance.now(); step(1 / 30); await device.queue.onSubmittedWorkDone();
      if (i >= 5) t.push(performance.now() - t0);
    }
    t.sort((a, b) => a - b);
    const avg = t.reduce((a, b) => a + b, 0) / t.length;
    return { avg_ms: +avg.toFixed(2), median_ms: +t[t.length >> 1].toFixed(2), fps: +(1000 / avg).toFixed(1), tris, draws, w: RW, h: RH, scale };
  };
  window.__fx = fx;
  window.__game = {
    teleport: (...a) => wasm.teleport(...a), hour: (h) => wasm.set_hour(h), setScale: (v) => { autoScale = false; scale = v; },
    placeVehicle: (i, x, y, yaw) => wasm.place_vehicle(i, x, y, yaw), press: (k) => { once[k] = true; },
    frame: () => Array.from(new Float32Array(mem(), wasm.frame_ptr(), 96)),
  };

  function drawDyn(p, obj, part, slot) {
    p.setBindGroup(1, bgModel, [slot * DYN_ALIGN]);
    p.drawIndexed(part.count, 1, part.first, part.base, 0); tris += part.count / 3; draws++;
  }

  function step(dt) {
    resize();
    const inp = new Float32Array(mem(), wasm.input_ptr(), 24);
    const k = (c) => (keys.has(c) ? 1 : 0);
    const cl = (v) => Math.max(-1, Math.min(1, v));
    inp[0] = cl(k("KeyD") - k("KeyA") + touch.mx); inp[1] = cl(k("KeyW") - k("KeyS") + touch.my);
    inp[2] += lookX * 0.0022; inp[3] += lookY * 0.0022; lookX = lookY = 0;
    inp[2] += (k("ArrowRight") - k("ArrowLeft")) * dt * 1.6; inp[3] += (k("ArrowDown") - k("ArrowUp")) * dt * 1.2;
    inp[4] = k("ShiftLeft") | k("ShiftRight") | (touch.run ? 1 : 0); inp[5] = RW / RH; inp[6] = timeSpeed;
    inp[8] = k("KeyE") - k("KeyQ"); inp[9] = 1.05; inp[10] = lodBias; inp[12] = k("Space") | (touch.brake ? 1 : 0);
    if (once.fly) inp[7] = 1; if (once.use) inp[11] = 1; if (once.beacon) inp[13] = 1;
    if (once.left) inp[14] = 1; if (once.right) inp[15] = 1; if (once.view) inp[16] = 1;
    for (const key in once) once[key] = false;
    frameNo++;
    const jit = fx.taa ? HALTON[frameNo % 8] : [0, 0];
    const jx = (jit[0] * 2) / RW, jy = (jit[1] * 2) / RH;        // NDC units
    inp[17] = jx; inp[18] = jy;
    wasm.update(dt);
    const f = new Float32Array(mem(), wasm.frame_ptr(), 112);
    hour = f[63]; flying = f[67] > 0.5;
    fu.set(f.subarray(0, 64)); fu[64] = RW; fu[65] = RH; fu[66] = 1 / SHADOW; fu[67] = world.ao ? 1 : 0;
    fu.set(f.subarray(72, 88), 68);                    // car0, car1, beaconA, beaconB
    device.queue.writeBuffer(frameUBO, 0, fu);
    const dyn = new Float32Array(mem(), wasm.dyn_ptr(), N_DYN * 20);
    for (let i = 0; i < N_DYN; i++) dynData.set(dyn.subarray(i * 20, i * 20 + 20), (i * DYN_ALIGN) / 4);
    device.queue.writeBuffer(dynUBO, 0, dynData);
    const enc = device.createCommandEncoder();
    if (f[64] > 0.5 || shadowFrames === 0) {
      device.queue.writeBuffer(shadowUBO, 0, fu);
      drawShadow(enc); shadowFrames++;
    }
    const visO = new Uint32Array(mem(), wasm.vis_opaque_ptr(), wasm.vis_opaque_len());
    const visT = new Uint32Array(mem(), wasm.vis_trans_ptr(), wasm.vis_trans_len());
    const visG = new Uint32Array(mem(), wasm.vis_groups_ptr(), wasm.vis_groups_len() * 2);
    tris = 0; draws = 0;
    const p = enc.beginRenderPass({
      colorAttachments: [{ view: hdrView, loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 1] }],
      depthStencilAttachment: { view: depthView, depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "store" } });
    p.setBindGroup(0, bgWorld);
    p.setPipeline(pOpaque); p.setVertexBuffer(0, VB); p.setIndexBuffer(IB, "uint32");
    for (const id of visO) { const c = chunks[id]; p.drawIndexed(c.count, 1, c.first, c.base, 0); tris += c.count / 3; draws++; }
    if (hasInst && visG.length) {
      p.setPipeline(pInst); p.setVertexBuffer(0, IVB); p.setVertexBuffer(1, IMB); p.setIndexBuffer(IIB, "uint32");
      for (let i = 0; i < visG.length; i += 2) {
        const { m, g } = groups[visG[i]]; const n = Math.min(visG[i + 1], g.count);
        p.drawIndexed(m.count, n, m.first, m.base, g.first); tris += (m.count / 3) * n; draws++;
      }
    }
    // dynamic objects: vehicles (body + wheels) and the character's body parts
    p.setPipeline(pDyn);
    for (const v of vehicles) {
      p.setVertexBuffer(0, v.vb); p.setIndexBuffer(v.ib, "uint32");
      drawDyn(p, v, v.info.parts.body, v.base);
      v.info.wheels.forEach((_, i) => drawDyn(p, v, v.info.parts.wheel, v.base + 1 + i));
      ["door_r", "door_l"].forEach((n, k) => { if (v.info.parts[n]) drawDyn(p, v, v.info.parts[n], v.door + k); });
    }
    if (f[92] < 0.5) {
      p.setVertexBuffer(0, chr.vb); p.setIndexBuffer(chr.ib, "uint32");
      chr.info.order.forEach((name, i) => drawDyn(p, chr, chr.info.parts[name], chr.base + i));
    }
    p.setPipeline(pSky); p.setBindGroup(0, bgFrame); p.draw(3);
    p.setBindGroup(0, bgWorld);
    if (visT.length) {
      p.setPipeline(pTrans); p.setVertexBuffer(0, VB); p.setIndexBuffer(IB, "uint32");
      for (const id of visT) { const c = chunks[id]; p.drawIndexed(c.count, 1, c.first, c.base, 0); tris += c.count / 3; draws++; }
    }
    p.setPipeline(pDynTrans);
    for (const v of vehicles) if (v.info.parts.glass) {
      p.setVertexBuffer(0, v.vb); p.setIndexBuffer(v.ib, "uint32");
      drawDyn(p, v, v.info.parts.glass, v.base);
      ["door_r_glass", "door_l_glass"].forEach((n, k) => { if (v.info.parts[n]) drawDyn(p, v, v.info.parts[n], v.door + k); });
    }
    p.end();
    device.queue.writeBuffer(postUBO, 0, new Float32Array([RW, RH, 1.0 + 0.9 * (1 - f[55]), f[51], f[65], f[66], Math.tan(1.05 / 2), RW / RH, fx.ssao ? 0.85 : 0, fx.taa ? 1 : 0, frameNo % 64, 0]));
    let postBG = bgPost;
    if (fx.taa) {
      const w = frameNo & 1, r = 1 - w;                         // write history w, read history r
      taaData.set(f.subarray(16, 32), 0); taaData.set(histValid ? prevVP : f.subarray(96, 112), 16);
      taaData[32] = RW; taaData[33] = RH; taaData[34] = jx; taaData[35] = jy; taaData[36] = histValid ? 0.12 : 1.0;
      taaData[37] = fx.ssao ? 0.85 : 0; taaData[38] = frameNo % 64; taaData.set([f[65], f[66], Math.tan(1.05 / 2), RW / RH], 40);
      device.queue.writeBuffer(taaUBO, 0, taaData);
      const t = enc.beginRenderPass({ colorAttachments: [{ view: histView[w], loadOp: "clear", storeOp: "store" }] });
      t.setPipeline(pTaa); t.setBindGroup(0, bgTaa[r]); t.draw(3); t.end();
      postBG = bgPostHist[w]; histValid = true;
    }
    prevVP.set(f.subarray(96, 112));
    const q = enc.beginRenderPass({ colorAttachments: [{ view: ctx.getCurrentTexture().createView(), loadOp: "clear", storeOp: "store" }] });
    q.setPipeline(pPost); q.setBindGroup(0, postBG); q.draw(3); q.end();
    device.queue.submit([enc.finish()]);

    sirenSet(f[89] === 2 && f[93] > 0.5 && !document.hidden ? f[91] : 0);
    const NAMES = ["", "パトカー", "消防車"];
    if (MOBILE) {
      const driving = f[89] === 2;
      document.body.classList.toggle("driving", driving);
      const use = $("bUse");
      use.textContent = f[90] === 3 ? "降りる" : f[90] > 0 ? "乗る" : driving ? "降りる" : "乗る";
      use.style.opacity = f[90] > 0 ? 1 : 0.35;
      $("bBeacon").classList.toggle("on", f[93] > 0.5);
    }
    $("prompt").textContent = f[90] === 1 || f[90] === 2 ? `E  ${NAMES[f[90]]}に乗る` : f[90] === 3 ? "E  降りる" : "";
    acc += dt; frames++;
    if (acc >= 0.5) {
      fps = frames / acc; ms = (acc / frames) * 1000; acc = 0; frames = 0;
      if (autoScale) {           // hold 24-30 fps by trading internal resolution
        if (fps < 22 && scale > 0.4) scale = Math.max(0.4, scale - 0.05);
        else if (fps > 29 && scale < 1.0) scale = Math.min(1.0, scale + 0.03);
      }
      const hh = Math.floor(hour), mm = Math.floor((hour - hh) * 60);
      hud.textContent = `${fps.toFixed(1)} fps  ${ms.toFixed(1)} ms   ${RW}x${RH} (x${scale.toFixed(2)})\n` +
        `${(tris / 1e6).toFixed(2)}M tris  ${draws} draws   ${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}${flying ? "  [FLY]" : ""}\n` +
        (MOBILE ? `${BUILD}  ${window.__touchDebug?.() ?? ""}\n` : "") +
        `pos ${f[68].toFixed(1)}, ${f[69].toFixed(1)}` + (f[89] === 2 ? `   ${NAMES[f[91]]}  ${Math.abs(f[88] * 3.6).toFixed(0)} km/h${f[93] > 0.5 ? "  赤色灯 ON" : ""}` : "");
      Object.assign(stats, { fps, ms, tris, draws, scale, w: RW, h: RH, ready: true, hour, x: f[68], y: f[69], mode: f[89], vehicle: f[91], speed: f[88] });
    }
  }
  stats.loaded = true;
  requestAnimationFrame(frame);
}
main().catch((e) => { console.error(e); msg.textContent = String(e.message || e); msg.style.display = "grid"; });
