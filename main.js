// WebGPU host: loads the baked world + the Rust/WASM core, renders with hand-written WGSL. No rendering libraries.
import { COMMON, WORLD, SKY, POST } from "./shaders.js";

const $ = (id) => document.getElementById(id);
const hud = $("hud"), msg = $("msg"), canvas = $("c");
const Q = new URLSearchParams(location.search);
const fail = (t) => { msg.textContent = t; msg.style.display = "grid"; throw new Error(t); };
const A = new URL(document.body.dataset.assets || "../assets/", location.href).href;

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
  const manifest = await fetch(A + "manifest.json").then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
  const getBuf = async (url) => {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    const b = await r.arrayBuffer();
    loadedBytes += b.byteLength; stage(`ワールドを読み込み中… ${(loadedBytes / 1048576).toFixed(0)} MB`);
    return b;
  };
  const bin = async (name) => {
    const parts = manifest[name];
    if (!parts) return getBuf(A + name);
    const bufs = await Promise.all(parts.map((p) => getBuf(A + p)));
    const out = new Uint8Array(bufs.reduce((n, b) => n + b.byteLength, 0));
    let o = 0; for (const b of bufs) { out.set(new Uint8Array(b), o); o += b.byteLength; }
    return out.buffer;
  };
  const json = (name) => fetch(A + name).then((r) => { if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`); return r.json(); });
  const VEH = ["police", "firetruck"];
  const [world, vtxBuf, idxBuf, instBuf, colBuf, wasmBuf, charJ, charV, charI, ...vehData] = await Promise.all([
    json("world.json"), bin("world_vtx.bin"), bin("world_idx.bin"), bin("inst.bin"), bin("collide.bin"),
    fetch(new URL("core.wasm", import.meta.url)).then((r) => r.arrayBuffer()),
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
  const vehicles = VEH.map((n, i) => ({ name: n, info: vehData[i * 3], vb: mkBuf(vehData[i * 3 + 1], GPUBufferUsage.VERTEX), ib: mkBuf(vehData[i * 3 + 2], GPUBufferUsage.INDEX), base: DYN_BASE[i] }));
  const chr = { info: charJ, vb: mkBuf(charV, GPUBufferUsage.VERTEX), ib: mkBuf(charI, GPUBufferUsage.INDEX), base: 12 };

  // ---------------------------------------------------------------- pipelines
  const SHADOW = Math.min(4096, device.limits.maxTextureDimension2D);
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
  for (const [n, m] of [["world", modWorld], ["sky", modSky], ["post", modPost]]) {
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
    { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: {} }] });
  const pPost = device.createRenderPipeline({ layout: device.createPipelineLayout({ bindGroupLayouts: [lPost] }),
    vertex: { module: modPost, entryPoint: "vs" }, fragment: { module: modPost, entryPoint: "fs", targets: [{ format: fmt }] } });
  const linSamp = device.createSampler({ magFilter: "linear", minFilter: "linear" });
  const postUBO = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

  // ---------------------------------------------------------------- render targets (dynamic resolution)
  let scale = Number(Q.get("scale") || 0.66), autoScale = !Q.has("scale");
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
    depthTex = device.createTexture({ size: [w, h], format: DEPTH, usage: GPUTextureUsage.RENDER_ATTACHMENT });
    depthView = depthTex.createView();
    bgPost = device.createBindGroup({ layout: lPost, entries: [{ binding: 0, resource: hdrView }, { binding: 1, resource: linSamp }, { binding: 2, resource: { buffer: postUBO } }] });
  }

  // ---------------------------------------------------------------- input
  const keys = new Set();
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
  canvas.addEventListener("mousedown", () => { dragging = true; try { const r = canvas.requestPointerLock?.(); r?.catch?.(() => {}); } catch {} });
  addEventListener("mouseup", () => { dragging = false; });
  addEventListener("mousemove", (e) => { if (document.pointerLockElement === canvas || dragging) { lookX += e.movementX; lookY += e.movementY; } });
  document.addEventListener("pointerlockchange", () => { $("help").style.opacity = document.pointerLockElement === canvas ? 0.25 : 1; });

  if (Q.has("pos")) { const p = Q.get("pos").split(",").map(Number); wasm.teleport(p[0], p[1], p[2] || 0, p[3] ?? 0, p[4] ?? 0, Q.get("fly") === "1" ? 1 : 0); }
  if (Q.has("hour")) wasm.set_hour(Number(Q.get("hour")));

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
    inp[0] = k("KeyD") - k("KeyA"); inp[1] = k("KeyW") - k("KeyS");
    inp[2] += lookX * 0.0022; inp[3] += lookY * 0.0022; lookX = lookY = 0;
    inp[2] += (k("ArrowRight") - k("ArrowLeft")) * dt * 1.6; inp[3] += (k("ArrowDown") - k("ArrowUp")) * dt * 1.2;
    inp[4] = k("ShiftLeft") | k("ShiftRight"); inp[5] = RW / RH; inp[6] = timeSpeed;
    inp[8] = k("KeyE") - k("KeyQ"); inp[9] = 1.05; inp[10] = lodBias; inp[12] = k("Space");
    if (once.fly) inp[7] = 1; if (once.use) inp[11] = 1; if (once.beacon) inp[13] = 1;
    if (once.left) inp[14] = 1; if (once.right) inp[15] = 1; if (once.view) inp[16] = 1;
    for (const key in once) once[key] = false;
    wasm.update(dt);
    const f = new Float32Array(mem(), wasm.frame_ptr(), 96);
    hour = f[63]; flying = f[67] > 0.5;
    fu.set(f.subarray(0, 64)); fu[64] = RW; fu[65] = RH; fu[66] = 1 / SHADOW; fu[67] = 1;
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
      depthStencilAttachment: { view: depthView, depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "discard" } });
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
    }
    p.end();
    device.queue.writeBuffer(postUBO, 0, new Float32Array([RW, RH, 1.0 + 0.9 * (1 - f[55]), f[51]]));
    const q = enc.beginRenderPass({ colorAttachments: [{ view: ctx.getCurrentTexture().createView(), loadOp: "clear", storeOp: "store" }] });
    q.setPipeline(pPost); q.setBindGroup(0, bgPost); q.draw(3); q.end();
    device.queue.submit([enc.finish()]);

    const NAMES = ["", "パトカー", "消防車"];
    $("prompt").textContent = f[90] === 1 || f[90] === 2 ? `E  ${NAMES[f[90]]}に乗る` : f[90] === 3 ? "E  降りる" : "";
    acc += dt; frames++;
    if (acc >= 0.5) {
      fps = frames / acc; ms = (acc / frames) * 1000; acc = 0; frames = 0;
      if (autoScale) {           // hold 24-30 fps by trading internal resolution
        if (fps < 23 && scale > 0.4) scale = Math.max(0.4, scale - 0.05);
        else if (fps > 34 && scale < 1.0) scale = Math.min(1.0, scale + 0.03);
      }
      const hh = Math.floor(hour), mm = Math.floor((hour - hh) * 60);
      hud.textContent = `${fps.toFixed(1)} fps  ${ms.toFixed(1)} ms   ${RW}x${RH} (x${scale.toFixed(2)})\n` +
        `${(tris / 1e6).toFixed(2)}M tris  ${draws} draws   ${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}${flying ? "  [FLY]" : ""}\n` +
        `pos ${f[68].toFixed(1)}, ${f[69].toFixed(1)}` + (f[89] === 2 ? `   ${NAMES[f[91]]}  ${Math.abs(f[88] * 3.6).toFixed(0)} km/h${f[93] > 0.5 ? "  赤色灯 ON" : ""}` : "");
      Object.assign(stats, { fps, ms, tris, draws, scale, w: RW, h: RH, ready: true, hour, x: f[68], y: f[69], mode: f[89], vehicle: f[91], speed: f[88] });
    }
  }
  stats.loaded = true;
  requestAnimationFrame(frame);
}
main().catch((e) => { console.error(e); msg.textContent = String(e.message || e); msg.style.display = "grid"; });
