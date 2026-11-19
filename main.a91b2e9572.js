// WebGPU host: loads the baked world + the Rust/WASM core, renders with hand-written WGSL. No rendering libraries.
import { COMMON, WORLD, SKY, POST, TAA } from "./shaders.223b8177d1.js";

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
  const [world, vtxBuf, idxBuf, instBuf, colBuf, wasmBuf, charJ, charV, charI, cityJ, cityV, cityI, rabJ, rabV, rabI, rabA, rabC, rabO, ...vehData] = await Promise.all([
    json("world.json"), bin("world_vtx.bin"), bin("world_idx.bin"), bin("inst.bin"), bin("collide.bin"),
    fetch(new URL("core.wasm?v=" + BUILD, import.meta.url)).then((r) => r.arrayBuffer()),
    json("char.json"), bin("char_vtx.bin"), bin("char_idx.bin"),
    json("city.json"), bin("city_vtx.bin"), bin("city_idx.bin"),
    json("rabbit.json"), bin("rabbit_vtx.bin"), bin("rabbit_idx.bin"), bin("rabbit_anim.bin"),
    ...["rabbit_color.png", "rabbit_orm.png"].map((n) => fetch(A + n + "?v=" + BUILD).then((r) => { if (!r.ok) throw new Error(`${n}: HTTP ${r.status}`); return r.blob(); })
      .then((b) => createImageBitmap(b, { resizeWidth: 1024, resizeHeight: 1024, resizeQuality: "high", colorSpaceConversion: "none" }))),
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
  {
    // surrounding buildings that reach into the walkable area become solid
    const g = new Uint8Array(colBuf);
    for (const poly of cityJ.collide || []) {
      let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
      for (const q of poly) { x0 = Math.min(x0, q[0]); x1 = Math.max(x1, q[0]); y0 = Math.min(y0, q[1]); y1 = Math.max(y1, q[1]); }
      const i0 = Math.max(0, Math.floor((x0 - C.x0) / C.cell)), i1 = Math.min(C.w - 1, Math.ceil((x1 - C.x0) / C.cell));
      const j0 = Math.max(0, Math.floor((y0 - C.y0) / C.cell)), j1 = Math.min(C.h - 1, Math.ceil((y1 - C.y0) / C.cell));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const x = C.x0 + (i + 0.5) * C.cell, y = C.y0 + (j + 0.5) * C.cell; let c = false;
        for (let k = 0, n = poly.length; k < n; k++) {
          const a = poly[(k + n - 1) % n], b = poly[k];
          if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) c = !c;
        }
        if (c) g[j * C.w + i] = 1;
      }
    }
  }
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
  // loose props (cones, bicycles, pots ...): rigid bodies simulated by the core
  const props = world.props || [];
  if (props.length) {
    const pa = new Float32Array(props.length * 6);
    props.forEach((q, i) => pa.set([...q.pos, ...q.half, q.h], i * 6));
    wasm.set_props(put(pa), props.length);
  }
  const [propV, propI] = props.length ? await Promise.all([bin("props_vtx.bin"), bin("props_idx.bin")]) : [null, null];

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
  // ---- surrounding city: real footprints and heights (PLATEAU LOD1) and road polygons, exported by tools/export_city.py.
  // The shader (kind 27) draws the window grid, weathering and lit rooms at night.
  const city = { vtx: cityV, idx: new Uint32Array(cityI) };
  const CVB = mkBuf(city.vtx, GPUBufferUsage.VERTEX), CIB = mkBuf(city.idx, GPUBufferUsage.INDEX);
  const IVB = mkBuf(iv, GPUBufferUsage.VERTEX), IIB = mkBuf(ii, GPUBufferUsage.INDEX), IMB = mkBuf(im, GPUBufferUsage.VERTEX);
  const hasInst = L.count > 0;
  // dynamic objects: matrix slots follow the core (0 police body, 1-4 wheels, 5 engine body, 6-11 wheels, 12-21 character)
  const DYN_BASE = [0, 5];
  const vehicles = VEH.map((n, i) => ({ name: n, info: vehData[i * 3], vb: mkBuf(vehData[i * 3 + 1], GPUBufferUsage.VERTEX), ib: mkBuf(vehData[i * 3 + 2], GPUBufferUsage.INDEX), base: DYN_BASE[i], door: 22 + i * 2 }));
  const PVB = propV ? mkBuf(propV, GPUBufferUsage.VERTEX) : null, PIB = propI ? mkBuf(propI, GPUBufferUsage.INDEX) : null;
  const chr = { info: charJ, vb: mkBuf(charV, GPUBufferUsage.VERTEX), ib: mkBuf(charI, GPUBufferUsage.INDEX), base: 12 };

  // ---------------------------------------------------------------- pipelines
  const SHADOW = Math.min(MOBILE ? 2048 : 4096, device.limits.maxTextureDimension2D);
  const shadowTex = device.createTexture({ size: [SHADOW, SHADOW], format: "depth32float", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
  const shadowView = shadowTex.createView();
  const FRAME_FLOATS = 100;
  const frameUBO = device.createBuffer({ size: FRAME_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const shadowUBO = device.createBuffer({ size: FRAME_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const lFrame = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {} }] });
  const lWorld = device.createBindGroupLayout({ entries: [
    { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {} },
    { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "depth" } },
    { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "comparison" } },
    { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "depth" } },
    { binding: 4, visibility: GPUShaderStage.FRAGMENT, buffer: {} },
  ] });
  const MAX_LAMPS = 12;
  const lampUBO = device.createBuffer({ size: 16 + MAX_LAMPS * 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const lampData = new Float32Array(4 + MAX_LAMPS * 8);
  const lamps = (world.lights || []).map((l) => ({ ...l, d: 0 }));
  const DSHADOW = 1024;
  const dynShadowView = device.createTexture({ size: [DSHADOW, DSHADOW], format: "depth32float", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING }).createView();
  const dynShadowUBO = device.createBuffer({ size: FRAME_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const cmpSamp = device.createSampler({ compare: "less-equal", magFilter: "linear", minFilter: "linear" });
  const bgWorld = device.createBindGroup({ layout: lWorld, entries: [{ binding: 0, resource: { buffer: frameUBO } }, { binding: 1, resource: shadowView }, { binding: 2, resource: cmpSamp }, { binding: 3, resource: dynShadowView }, { binding: 4, resource: { buffer: lampUBO } }] });
  const bgFrame = device.createBindGroup({ layout: lFrame, entries: [{ binding: 0, resource: { buffer: frameUBO } }] });
  const bgShadow = device.createBindGroup({ layout: lFrame, entries: [{ binding: 0, resource: { buffer: shadowUBO } }] });
  const bgDynShadow = device.createBindGroup({ layout: lFrame, entries: [{ binding: 0, resource: { buffer: dynShadowUBO } }] });

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
  const pShadowDyn = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [lFrame, lModel] }), vertex: { module: modWorld, entryPoint: "vsShadowDyn", buffers: [vAttr] },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: { format: "depth32float", depthWriteEnabled: true, depthCompare: "less", depthBias: 2, depthBiasSlopeScale: 2.0 } });
  // ---- skinned player character (assets/rabbit.*, from tools/export_rabbit.py)
  const NJ = rabJ.joints.length;
  const lSkin = device.createBindGroupLayout({ entries: [
    { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: {} },
    { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
    { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: {} },
    { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: {} }] });
  const sAttr = { arrayStride: 32, attributes: [
    { shaderLocation: 0, offset: 0, format: "float32x3" }, { shaderLocation: 1, offset: 12, format: "snorm16x2" },
    { shaderLocation: 2, offset: 16, format: "float32x2" }, { shaderLocation: 3, offset: 24, format: "uint8x4" }, { shaderLocation: 4, offset: 28, format: "unorm8x4" }] };
  const mkTex = (bmp) => {
    // mip chain built on the CPU side with canvas scaling: the character is small on screen most of the time
    const levels = Math.floor(Math.log2(bmp.width)) + 1;
    const t = device.createTexture({ size: [bmp.width, bmp.height], format: "rgba8unorm", mipLevelCount: levels,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT });
    let src = bmp;
    for (let l = 0; l < levels; l++) {
      const w = Math.max(1, bmp.width >> l), h = Math.max(1, bmp.height >> l);
      if (l > 0) { const c = new OffscreenCanvas(w, h); const g = c.getContext("2d"); g.imageSmoothingQuality = "high"; g.drawImage(src, 0, 0, w, h); src = c; }
      device.queue.copyExternalImageToTexture({ source: src }, { texture: t, mipLevel: l }, [w, h]);
    }
    return t.createView();
  };
  const skinUBO = device.createBuffer({ size: 24 * 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const skinData = new Float32Array(24 * 16);
  const triSamp = device.createSampler({ magFilter: "linear", minFilter: "linear", mipmapFilter: "linear", maxAnisotropy: 4 });
  const bgSkin = device.createBindGroup({ layout: lSkin, entries: [{ binding: 0, resource: { buffer: skinUBO } },
    { binding: 1, resource: mkTex(rabC) }, { binding: 2, resource: mkTex(rabO) }, { binding: 3, resource: triSamp }] });
  const pSkin = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [lWorld, lModel, lSkin] }), vertex: { module: modWorld, entryPoint: "vsSkin", buffers: [sAttr] },
    fragment: { module: modWorld, entryPoint: "fsSkin", targets: [{ format: HDR }] },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: { format: DEPTH, depthWriteEnabled: true, depthCompare: "less" } });
  const pShadowSkin = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [lFrame, lModel, lSkin] }), vertex: { module: modWorld, entryPoint: "vsShadowSkin", buffers: [sAttr] },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: { format: "depth32float", depthWriteEnabled: true, depthCompare: "less", depthBias: 2, depthBiasSlopeScale: 2.0 } });
  const rab = { vb: mkBuf(rabV, GPUBufferUsage.VERTEX), ib: mkBuf(rabI, GPUBufferUsage.INDEX), count: rabJ.ni, anim: new Float32Array(rabA),
    clip: Object.fromEntries(rabJ.clips.map((c) => [c.name, c])), w: { Walk: 0, Run: 0, Jump: 0, Sit: 0 }, t: { Walk: 0, Run: 0 },
    air: -1, last: null, seat: 0, scale: 1.72 / rabJ.height };
  const REST = rabJ.joints.map((j) => [...j.t, ...j.r, ...j.s]);
  const IBM = rabJ.joints.map((j) => Float32Array.from(j.ibm));
  const mul4 = (a, b, o) => {            // column-major 4x4: o = a * b
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++)
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    return o;
  };
  const jw = rabJ.joints.map(() => new Float32Array(16)), jl = new Float32Array(16), jp = new Float32Array(10), tmpM = new Float32Array(16);
  // sample one clip at time t (seconds) for joint k into out[10] (translation, quaternion, scale)
  const sampleClip = (c, t, k, out) => {
    const ft = Math.max(0, Math.min(c.frames - 1.001, t * rabJ.fps)), f0 = Math.floor(ft), u = ft - f0;
    const a = c.offset + (f0 * NJ + k) * 10, b = a + NJ * 10;
    for (let i = 0; i < 10; i++) out[i] = rab.anim[a + i] + (rab.anim[b + i] - rab.anim[a + i]) * u;
  };
  const tmpP = new Float32Array(10);
  // pose from the game state: clip weights follow speed / air / seat, the remainder is the rest pose
  function animateRabbit(f, dyn, dt) {
    const mode = f[89], jz = f[95];
    let v = 0;
    if (rab.last && dt > 0) v = Math.hypot(f[68] - rab.last[0], f[69] - rab.last[1]) / dt;
    rab.last = [f[68], f[69]];
    if (mode !== 0) v = mode === 2 ? 0 : 1.2;
    if (jz > 0 && rab.air < 0) rab.air = 0; else if (jz <= 0) rab.air = -1;
    if (rab.air >= 0) rab.air += dt;
    const tgt = { Walk: 0, Run: 0, Jump: 0, Sit: 0 };
    if (mode === 2) tgt.Sit = 1; else if (rab.air >= 0) tgt.Jump = 1; else if (v > 3.0) tgt.Run = 1; else if (v > 0.15) tgt.Walk = 1;
    const k = Math.min(1, dt * 10);
    for (const n in tgt) rab.w[n] += (tgt[n] - rab.w[n]) * (n === "Jump" && tgt.Jump ? Math.min(1, dt * 25) : k);
    rab.seat += ((mode === 2 ? 1 : mode === 1 ? 0.6 : 0) - rab.seat) * Math.min(1, dt * 5);
    rab.t.Walk = (rab.t.Walk + dt * Math.max(0.6, v / 1.45)) % rab.clip.Walk.duration;
    rab.t.Run = (rab.t.Run + dt * Math.max(0.7, v / 5.2)) % rab.clip.Run.duration;
    const times = { Walk: rab.t.Walk, Run: rab.t.Run, Jump: Math.max(0, rab.air) * rab.clip.Jump.duration, Sit: rab.clip.Sit.duration * 0.45 };
    let hips = rabJ.hips;
    for (const kj of rabJ.order) {
      const R = REST[kj];
      let ws = 0; jp.fill(0);
      for (const n in rab.w) {
        const w = rab.w[n]; if (w < 0.002 || !rab.clip[n]) continue;
        sampleClip(rab.clip[n], times[n], kj, tmpP);
        const sgn = tmpP[3] * R[3] + tmpP[4] * R[4] + tmpP[5] * R[5] + tmpP[6] * R[6] < 0 ? -1 : 1;
        for (let i = 0; i < 10; i++) jp[i] += tmpP[i] * w * (i >= 3 && i < 7 ? sgn : 1);
        ws += w;
      }
      const wr = Math.max(0, 1 - ws), inv = 1 / (ws + wr);
      for (let i = 0; i < 10; i++) jp[i] = (jp[i] + R[i] * wr) * inv;
      const ql = Math.hypot(jp[3], jp[4], jp[5], jp[6]) || 1, x = jp[3] / ql, y = jp[4] / ql, z = jp[5] / ql, w = jp[6] / ql;
      const sx = jp[7], sy = jp[8], sz = jp[9];
      jl[0] = (1 - 2 * (y * y + z * z)) * sx; jl[1] = 2 * (x * y + z * w) * sx; jl[2] = 2 * (x * z - y * w) * sx; jl[3] = 0;
      jl[4] = 2 * (x * y - z * w) * sy; jl[5] = (1 - 2 * (x * x + z * z)) * sy; jl[6] = 2 * (y * z + x * w) * sy; jl[7] = 0;
      jl[8] = 2 * (x * z + y * w) * sz; jl[9] = 2 * (y * z - x * w) * sz; jl[10] = (1 - 2 * (x * x + y * y)) * sz; jl[11] = 0;
      jl[12] = jp[0]; jl[13] = jp[1]; jl[14] = jp[2]; jl[15] = 1;
      const par = rabJ.joints[kj].parent;
      if (par < 0) jw[kj].set(jl); else mul4(jw[par], jl, jw[kj]);
      if (rabJ.joints[kj].name === "Hips") hips = jw[kj][13];
      skinData.set(mul4(jw[kj], IBM[kj], tmpM), kj * 16);
    }
    device.queue.writeBuffer(skinUBO, 0, skinData);
    // root: the core's torso matrix (origin at the human pelvis); on foot the feet stand on the ground below it,
    // seated the rabbit's own hips sit where the pelvis is. glTF y-up / z-forward -> game z-up / x-forward.
    const T = dyn.subarray(12 * 20, 12 * 20 + 16), S = rab.scale;
    const drop = 0.955 + 0.03 + (hips * S - 0.985) * rab.seat;
    const local = new Float32Array([0, S, 0, 0, 0, 0, S, 0, S, 0, 0, 0, 0, 0, -drop, 1]);
    return mul4(T, local, new Float32Array(16));
  }
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
    hold("bBrake", "brake"); hold("bJump", "brake"); hold("bRun", "run");
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
    frame: () => Array.from(new Float32Array(mem(), wasm.frame_ptr(), 128)),
    dyn: (i) => Array.from(new Float32Array(mem(), wasm.dyn_ptr() + i * 80, 16)),
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
    const f = new Float32Array(mem(), wasm.frame_ptr(), 128);
    hour = f[63]; flying = f[67] > 0.5;
    fu.set(f.subarray(0, 64)); fu[64] = RW; fu[65] = RH; fu[66] = 1 / SHADOW; fu[67] = world.ao ? 1 : 0;
    fu.set(f.subarray(72, 88), 68);                    // car0, car1, beaconA, beaconB
    fu.set(f.subarray(112, 128), 84);                  // dynamic shadow matrix
    device.queue.writeBuffer(frameUBO, 0, fu);
    {
      // lamps: the nearest few to the camera, switched on as daylight goes
      const night = 1 - f[55];
      const on = Math.max(0, Math.min(1, (night - 0.25) / 0.45));
      let n = 0;
      if (on > 0 && lamps.length) {
        const cx = f[48], cy = f[49], cz = f[50];
        for (const l of lamps) l.d = (l.pos[0] - cx) ** 2 + (l.pos[1] - cy) ** 2 + (l.pos[2] - cz) ** 2 - l.power * 60;
        lamps.sort((a, b) => a.d - b.d);
        n = Math.min(MAX_LAMPS, lamps.length);
        for (let i = 0; i < n; i++) {
          const l = lamps[i], range = 9 + 9 * l.power, e = (l.street ? 13 : 9) * (0.35 + 0.65 * l.power);
          lampData.set([l.pos[0], l.pos[1], l.pos[2], range], 4 + i * 4);
          lampData.set([l.col[0] * e, l.col[1] * e, l.col[2] * e, 0], 4 + MAX_LAMPS * 4 + i * 4);
        }
      }
      lampData[0] = n; lampData[1] = on;
      device.queue.writeBuffer(lampUBO, 0, lampData);
    }
    const dyn = new Float32Array(mem(), wasm.dyn_ptr(), N_DYN * 20);
    for (let i = 0; i < N_DYN; i++) dynData.set(dyn.subarray(i * 20, i * 20 + 20), (i * DYN_ALIGN) / 4);
    { const tn = performance.now(); dynData.set(animateRabbit(f, dyn, Math.min(0.1, Math.max(0, (tn - (rab.now ?? tn)) / 1000))), (12 * DYN_ALIGN) / 4); rab.now = tn; }
    device.queue.writeBuffer(dynUBO, 0, dynData);
    const enc = device.createCommandEncoder();
    if (f[64] > 0.5 || shadowFrames === 0) {
      device.queue.writeBuffer(shadowUBO, 0, fu);
      drawShadow(enc); shadowFrames++;
    }
    {
      const du = fu.slice(); du.set(f.subarray(112, 128), 32);       // same block, with the light matrix swapped in
      device.queue.writeBuffer(dynShadowUBO, 0, du);
      const sp = enc.beginRenderPass({ colorAttachments: [], depthStencilAttachment: { view: dynShadowView, depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "store" } });
      sp.setPipeline(pShadowDyn); sp.setBindGroup(0, bgDynShadow);
      const sd = (part, slot) => { sp.setBindGroup(1, bgModel, [slot * DYN_ALIGN]); sp.drawIndexed(part.count, 1, part.first, part.base, 0); };
      for (const v of vehicles) {
        sp.setVertexBuffer(0, v.vb); sp.setIndexBuffer(v.ib, "uint32");
        sd(v.info.parts.body, v.base); if (v.info.parts.glass) sd(v.info.parts.glass, v.base);
        v.info.wheels.forEach((_, i) => sd(v.info.parts.wheel, v.base + 1 + i));
        ["door_r", "door_l"].forEach((n, k) => { if (v.info.parts[n]) sd(v.info.parts[n], v.door + k); });
      }
      if (f[92] < 0.5 || f[94] > 0.5) {                               // in first person the body is hidden but still casts a shadow
        sp.setPipeline(pShadowSkin); sp.setBindGroup(0, bgDynShadow); sp.setBindGroup(1, bgModel, [12 * DYN_ALIGN]); sp.setBindGroup(2, bgSkin);
        sp.setVertexBuffer(0, rab.vb); sp.setIndexBuffer(rab.ib, "uint32"); sp.drawIndexed(rab.count, 1, 0, 0, 0);
        sp.setPipeline(pShadowDyn); sp.setBindGroup(0, bgDynShadow);
      }
      if (PVB) { sp.setVertexBuffer(0, PVB); sp.setIndexBuffer(PIB, "uint32"); for (let i = 0; i < props.length; i++) sd(props[i], 26 + i); }
      sp.end();
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
    p.setVertexBuffer(0, CVB); p.setIndexBuffer(CIB, "uint32"); p.drawIndexed(city.idx.length, 1, 0, 0, 0); tris += city.idx.length / 3; draws++;
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
      p.setPipeline(pSkin); p.setBindGroup(1, bgModel, [12 * DYN_ALIGN]); p.setBindGroup(2, bgSkin);
      p.setVertexBuffer(0, rab.vb); p.setIndexBuffer(rab.ib, "uint32"); p.drawIndexed(rab.count, 1, 0, 0, 0); tris += rab.count / 3; draws++;
      p.setPipeline(pDyn);
    }
    if (PVB) {
      p.setVertexBuffer(0, PVB); p.setIndexBuffer(PIB, "uint32");
      for (let i = 0; i < props.length; i++) drawDyn(p, null, props[i], 26 + i);
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
    device.queue.writeBuffer(postUBO, 0, new Float32Array([RW, RH, 1.0 + 0.55 * (1 - f[55]), f[51], f[65], f[66], Math.tan(1.05 / 2), RW / RH, fx.ssao ? 0.85 : 0, fx.taa ? 1 : 0, frameNo % 64, 0]));
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
