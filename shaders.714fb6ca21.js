// WGSL shaders. No textures from photos anywhere: albedo comes from baked vertex colours, all micro detail is procedural.
export const COMMON = /* wgsl */`
struct Frame {
  viewProj: mat4x4f,
  invViewProj: mat4x4f,
  lightViewProj: mat4x4f,
  camPos: vec3f, time: f32,
  lightDir: vec3f, day: f32,
  lightColor: vec3f, exposure: f32,
  sunDir: vec3f, hour: f32,
  res: vec2f, shadowTexel: f32, quality: f32,
  car0: vec4f,         // police car: x, y, yaw, present
  car1: vec4f,         // fire engine
  beaconA: vec4f,      // warning-lamp glow: xyz, intensity
  beaconB: vec4f,
};
@group(0) @binding(0) var<uniform> F: Frame;

const PI = 3.14159265;

fn octDecode(e: vec2f) -> vec3f {
  var v = vec3f(e.xy, 1.0 - abs(e.x) - abs(e.y));
  let t = max(-v.z, 0.0);
  v.x += select(t, -t, v.x >= 0.0);
  v.y += select(t, -t, v.y >= 0.0);
  return normalize(v);
}
fn srgbToLinear(c: vec3f) -> vec3f { return pow(c, vec3f(2.2)); }

fn hash31(p: vec3f) -> f32 {
  var q = fract(p * vec3f(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yxz + 33.33);
  return fract((q.x + q.y) * q.z);
}
fn hash21(p: vec2f) -> f32 { return hash31(vec3f(p, 7.13)); }
fn vnoise(p: vec3f) -> f32 {
  let i = floor(p); let f = fract(p); let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash31(i), hash31(i + vec3f(1,0,0)), u.x), mix(hash31(i + vec3f(0,1,0)), hash31(i + vec3f(1,1,0)), u.x), u.y),
             mix(mix(hash31(i + vec3f(0,0,1)), hash31(i + vec3f(1,0,1)), u.x), mix(hash31(i + vec3f(0,1,1)), hash31(i + vec3f(1,1,1)), u.x), u.y), u.z);
}
fn fbm(p: vec3f) -> f32 {
  return vnoise(p) * 0.5 + vnoise(p * 2.03 + 11.7) * 0.25 + vnoise(p * 4.01 + 3.1) * 0.125 + vnoise(p * 8.07 + 5.9) * 0.0625;
}

// ---------------------------------------------------------------- sky
fn skyBase(dir: vec3f) -> vec3f {
  let sun = F.sunDir;
  let h = max(dir.z, 0.0);
  let day = smoothstep(-0.12, 0.10, sun.z);
  let mu = max(dot(dir, sun), 0.0);
  let zen = mix(vec3f(0.012, 0.016, 0.035), vec3f(0.10, 0.27, 0.72), day);
  let hor = mix(vec3f(0.030, 0.036, 0.060), vec3f(0.62, 0.78, 0.98), day);
  var col = mix(hor, zen, pow(h, 0.42));
  let low = (1.0 - smoothstep(0.0, 0.34, sun.z)) * smoothstep(-0.16, 0.02, sun.z);
  col = mix(col, vec3f(1.25, 0.52, 0.16), clamp(low * (0.30 * (1.0 - h) + 0.85 * mu * mu * mu * (1.0 - h)), 0.0, 1.0));
  col += vec3f(1.0, 0.92, 0.78) * (mu * mu * mu * mu * mu * mu * 0.10) * day;
  return col;
}

fn skyColor(dir: vec3f, withSun: bool) -> vec3f {
  let sun = F.sunDir;
  let h = max(dir.z, 0.0);
  let sunH = sun.z;
  let day = smoothstep(-0.12, 0.10, sunH);
  let mu = max(dot(dir, sun), 0.0);
  // Rayleigh-ish gradient
  let zen = mix(vec3f(0.012, 0.016, 0.035), vec3f(0.10, 0.27, 0.72), day);
  let hor = mix(vec3f(0.030, 0.036, 0.060), vec3f(0.62, 0.78, 0.98), day);
  var col = mix(hor, zen, pow(h, 0.42));
  // sunset tint near the sun azimuth and horizon
  let low = (1.0 - smoothstep(0.0, 0.34, sunH)) * smoothstep(-0.16, 0.02, sunH);
  let glow = pow(mu, 3.0) * (1.0 - h) ;
  col = mix(col, vec3f(1.25, 0.52, 0.16), clamp(low * (0.30 * (1.0 - h) + 0.85 * glow), 0.0, 1.0));
  // Mie halo
  col += vec3f(1.0, 0.92, 0.78) * (pow(mu, 48.0) * 0.55 + pow(mu, 6.0) * 0.10) * day;
  // ground haze below horizon
  if (dir.z < 0.0) { col = mix(col, hor * 0.55, smoothstep(0.0, -0.25, dir.z)); }
  // clouds: two fbm layers on a plane, lit by the sun
  if (dir.z > 0.015) {
    let p = dir.xy / (dir.z + 0.08) * 1.6 + vec2f(F.time * 0.004, F.time * 0.0015);
    let d = fbm(vec3f(p * 0.9, 1.3)) * 0.65 + fbm(vec3f(p * 2.7, 4.1)) * 0.35;
    let cov = smoothstep(0.50, 0.78, d) * smoothstep(0.015, 0.16, dir.z);
    let lit = mix(vec3f(0.34, 0.37, 0.43), vec3f(1.0, 0.98, 0.95), 0.45 + 0.55 * pow(mu, 2.0));
    let cc = lit * mix(vec3f(0.035, 0.04, 0.06), mix(vec3f(1.5, 0.75, 0.42), vec3f(1.25), smoothstep(0.02, 0.3, sunH)), day);
    col = mix(col, cc, cov * 0.85);
  }
  // stars
  let night = 1.0 - day;
  if (night > 0.01 && dir.z > 0.0) {
    let sp = dir * 900.0;
    let g = floor(sp);
    let s = hash31(g);
    let dot2 = 1.0 - smoothstep(0.05, 0.45, length(fract(sp) - 0.5));
    col += vec3f(step(0.9972, s)) * dot2 * smoothstep(0.75, 1.0, night) * 1.4 * smoothstep(0.0, 0.2, dir.z);
  }
  if (withSun) {
    let disc = smoothstep(0.99975, 0.99992, dot(dir, sun));
    col += vec3f(60.0, 52.0, 40.0) * disc * smoothstep(-0.02, 0.03, sunH);
  }
  return col;
}
// What a mirror on the street sees: sky (with clouds and the sun when sharp is set), a skyline of buildings around the
// horizon and the road below. Used for vehicle paint, glass and lamp lenses.
fn envColor(dir: vec3f, rough: f32, sharp: bool) -> vec3f {
  let d = normalize(vec3f(dir.xy, max(dir.z, 0.0) + 0.015));
  var c: vec3f;
  if (sharp) { c = skyColor(d, true); } else { c = skyBase(d); }
  let day = F.day;
  let sunUp = max(F.sunDir.z, 0.0);
  // skyline: blocks of different heights by azimuth, lit on the sun side
  let az = atan2(dir.y, dir.x);
  let k = floor(az * 7.0);
  let hb = 0.05 + 0.30 * hash21(vec2f(k, 3.1)) * hash21(vec2f(k, 9.7));
  let soft = 0.012 + rough * 0.25;
  let b = 1.0 - smoothstep(hb - soft, hb + soft, dir.z);
  let facing = 0.5 + 0.5 * dot(normalize(dir.xy + 1e-4), normalize(F.sunDir.xy + 1e-4));
  let wall = mix(vec3f(0.006, 0.007, 0.010), vec3f(0.30, 0.29, 0.27) * (0.35 + 0.9 * facing * sunUp), day) * (0.7 + 0.6 * hash21(vec2f(k, 5.3)));
  c = mix(c, wall, b);
  // road
  let road = mix(vec3f(0.003), vec3f(0.085, 0.085, 0.090) * (0.45 + 1.1 * sunUp), day);
  c = mix(c, road, 1.0 - smoothstep(-0.05 - rough * 0.3, 0.015, dir.z));
  return c;
}

fn ambientSky(n: vec3f) -> vec3f {
  let day = smoothstep(-0.12, 0.10, F.sunDir.z);
  let up = mix(vec3f(0.010, 0.013, 0.026), vec3f(0.30, 0.44, 0.74), day);
  let side = mix(vec3f(0.012, 0.014, 0.022), vec3f(0.36, 0.40, 0.44), day);
  let gnd = mix(vec3f(0.006, 0.006, 0.008), vec3f(0.16, 0.145, 0.125), day);
  let t = n.z * 0.5 + 0.5;
  return mix(gnd, mix(side, up, smoothstep(0.5, 1.0, t)), smoothstep(0.0, 0.55, t));
}
`;

export const WORLD = /* wgsl */`
@group(0) @binding(1) var shadowMap: texture_depth_2d;
@group(0) @binding(2) var shadowSamp: sampler_comparison;

struct VIn {
  @location(0) pos: vec3f,
  @location(1) nrm: vec2f,      // snorm16 x2 (octahedral)
  @location(2) col: vec4f,      // unorm8: sRGB albedo, roughness
  @location(3) mat: vec4u,      // kind, metallic, emission, alpha
};
struct VOut {
  @builtin(position) clip: vec4f,
  @location(0) wpos: vec3f,
  @location(1) nrm: vec3f,
  @location(2) col: vec4f,
  @location(3) @interpolate(flat) mat: vec4u,
  @location(4) fade: f32,
  @location(5) lpos: vec3f,                       // object-space position (dynamic objects)
  @location(6) @interpolate(flat) lights: vec4f,  // beacon, left signal, right signal, brake
};

@vertex fn vsWorld(v: VIn) -> VOut {
  var o: VOut;
  o.wpos = v.pos; o.nrm = octDecode(v.nrm); o.col = v.col; o.mat = v.mat; o.fade = 1.0;
  o.clip = F.viewProj * vec4f(v.pos, 1.0);
  return o;
}

struct IIn { @location(4) r0: vec4f, @location(5) r1: vec4f, @location(6) r2: vec4f };
@vertex fn vsInst(v: VIn, i: IIn, @builtin(instance_index) ii: u32) -> VOut {
  var o: VOut;
  var p = vec3f(dot(i.r0.xyz, v.pos) + i.r0.w, dot(i.r1.xyz, v.pos) + i.r1.w, dot(i.r2.xyz, v.pos) + i.r2.w);
  let origin = vec3f(i.r0.w, i.r1.w, i.r2.w);
  // LOD: fewer sprigs are drawn far away, so fatten the survivors
  let d = distance(origin, F.camPos);
  let grow = 1.0 + clamp((d - 38.0) / 60.0, 0.0, 1.6);
  p = origin + (p - origin) * grow;
  // wind
  let ph = F.time * 1.7 + origin.x * 0.37 + origin.y * 0.29;
  let amp = 0.012 + 0.02 * hash21(origin.xy);
  p += vec3f(sin(ph), cos(ph * 0.83), sin(ph * 1.31) * 0.5) * amp * length(p - origin) * 6.0;
  o.wpos = p;
  let n = octDecode(v.nrm);
  o.nrm = normalize(vec3f(dot(i.r0.xyz, n), dot(i.r1.xyz, n), dot(i.r2.xyz, n)));
  o.col = v.col; o.mat = v.mat; o.fade = 1.0;
  o.clip = F.viewProj * vec4f(p, 1.0);
  return o;
}

struct Model { m: mat4x4f, lights: vec4f };
@group(1) @binding(0) var<uniform> M: Model;
@vertex fn vsDyn(v: VIn) -> VOut {
  var o: VOut;
  let p = M.m * vec4f(v.pos, 1.0);
  let n = octDecode(v.nrm);
  o.wpos = p.xyz; o.nrm = normalize((M.m * vec4f(n, 0.0)).xyz); o.col = v.col; o.mat = v.mat; o.fade = 0.0;
  o.lpos = v.pos; o.lights = M.lights;
  o.clip = F.viewProj * p;
  return o;
}

@vertex fn vsShadow(v: VIn) -> @builtin(position) vec4f { return F.lightViewProj * vec4f(v.pos, 1.0); }
@vertex fn vsShadowInst(v: VIn, i: IIn) -> @builtin(position) vec4f {
  let p = vec3f(dot(i.r0.xyz, v.pos) + i.r0.w, dot(i.r1.xyz, v.pos) + i.r1.w, dot(i.r2.xyz, v.pos) + i.r2.w);
  return F.lightViewProj * vec4f(p, 1.0);
}

fn shadow(wpos: vec3f, n: vec3f, ndl: f32) -> f32 {
  let bias = n * (0.035 + 0.09 * (1.0 - ndl));
  let lp = F.lightViewProj * vec4f(wpos + bias, 1.0);
  let uv = lp.xy * vec2f(0.5, -0.5) + 0.5;
  let inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
  let z = lp.z - 0.0006;
  var s = 0.0;
  let t = F.shadowTexel;
  // 5-tap rotated PCF (comparison sampler does bilinear 2x2 per tap)
  let r = 0.7;
  let cs = vec2f(cos(r), sin(r));
  s += textureSampleCompareLevel(shadowMap, shadowSamp, uv, z);
  s += textureSampleCompareLevel(shadowMap, shadowSamp, uv + vec2f(cs.x, cs.y) * t * 1.6, z);
  s += textureSampleCompareLevel(shadowMap, shadowSamp, uv + vec2f(-cs.y, cs.x) * t * 1.6, z);
  s += textureSampleCompareLevel(shadowMap, shadowSamp, uv - vec2f(cs.x, cs.y) * t * 1.6, z);
  s += textureSampleCompareLevel(shadowMap, shadowSamp, uv - vec2f(-cs.y, cs.x) * t * 1.6, z);
  return mix(1.0, s * 0.2, inside);
}

fn D_GGX(nh: f32, a: f32) -> f32 { let a2 = a * a; let d = nh * nh * (a2 - 1.0) + 1.0; return a2 / (PI * d * d + 1e-6); }
fn V_Smith(nv: f32, nl: f32, a: f32) -> f32 { let k = a * 0.5; return 0.25 / ((nv * (1.0 - k) + k) * (nl * (1.0 - k) + k) + 1e-5); }
fn F_Schlick(f0: vec3f, vh: f32) -> vec3f { return f0 + (1.0 - f0) * pow(1.0 - vh, 5.0); }

// triplanar-free procedural detail: world-space noise keyed by the dominant axis
struct Detail { albedo: vec3f, rough: f32, bump: vec3f, ao: f32 };

fn surfUV(p: vec3f, n: vec3f) -> vec2f {
  let a = abs(n);
  if (a.z > a.x && a.z > a.y) { return p.xy; }
  if (a.x > a.y) { return p.yz; }
  return p.xz;
}

// fade for a pattern of spatial frequency f (cycles per metre) given the pixel footprint px (metres): no aliasing shimmer
fn lod(f: f32, px: f32) -> f32 { return clamp(1.0 - px * f * 2.2, 0.0, 1.0); }

fn detail(kind: u32, p: vec3f, n: vec3f, dist: f32, px: f32) -> Detail {
  var d: Detail; d.albedo = vec3f(1.0); d.rough = 0.0; d.bump = vec3f(0.0); d.ao = 1.0;
  let fade = lod(90.0, px);                              // finest grain only where a pixel can resolve it
  let uv = surfUV(p, n);
  let big = vnoise(p * 0.45) * 0.65 + vnoise(p * 1.7 + 9.1) * 0.35;   // large-scale tonal variation (all kinds)
  d.albedo *= 0.90 + 0.20 * big;
  let e = 0.02;
  if (kind == 1u) {            // asphalt: aggregate + patches + cracks
    let g = hash21(floor(uv * 180.0));
    let g2 = vnoise(vec3f(uv * 45.0, 0.0));
    d.albedo *= 1.0 + (g - 0.5) * 0.45 * lod(180.0, px) + (g2 - 0.5) * 0.25 * lod(45.0, px);
    let patchK = smoothstep(0.52, 0.56, fbm(vec3f(floor(uv * 0.35) * 3.1, 2.0))) ;
    d.albedo *= mix(1.0, 0.78, patchK * 0.6);
    let cr = abs(vnoise(vec3f(uv * 2.3, 9.0)) - 0.5);
    d.albedo *= mix(1.0, mix(0.55, 1.0, smoothstep(0.0, 0.012, cr)), lod(8.0, px));
    d.rough = 0.08 * (g - 0.5);
    d.bump = vec3f(g - 0.5, hash21(floor(uv * 180.0) + 7.0) - 0.5, 0.0) * 0.55 * lod(180.0, px);
  } else if (kind == 2u || kind == 6u) {   // concrete / plaster: pores, stains
    let g = vnoise(vec3f(uv * 60.0, 1.0));
    d.albedo *= 1.0 + (g - 0.5) * 0.14 * lod(60.0, px);
    let st = fbm(vec3f(uv.x * 1.3, uv.y * 0.25, 3.0));
    d.albedo *= mix(1.0, 0.80, smoothstep(0.52, 0.80, st) * abs(n.z - 1.0));
    d.bump = vec3f(vnoise(vec3f(uv * 90.0, 2.0)) - 0.5, vnoise(vec3f(uv * 90.0, 5.0)) - 0.5, 0.0) * 0.25 * fade;
  } else if (kind == 3u || kind == 15u) {  // stone / gravel: speckle
    let g = hash21(floor(uv * 260.0));
    let m = vnoise(vec3f(uv * 12.0, 4.0));
    d.albedo *= 1.0 + (g - 0.5) * 0.30 * lod(260.0, px) + (m - 0.5) * 0.18 * lod(12.0, px);
    d.bump = vec3f(g - 0.5, hash21(floor(uv * 260.0) + 3.0) - 0.5, 0.0) * 0.35 * lod(260.0, px);
    if (kind == 15u) { d.bump *= 2.2; d.albedo *= 1.0 + (hash21(floor(uv * 60.0)) - 0.3) * 0.3 * lod(60.0, px); }
  } else if (kind == 4u) {     // brick: running bond 240 x 80 mm
    let bw = 0.24; let bh = 0.08;
    let row = floor(uv.y / bh);
    let u2 = vec2f(uv.x + 0.5 * bw * (row - 2.0 * floor(row * 0.5)), uv.y);
    let cell = floor(u2 / vec2f(bw, bh));
    let f = fract(u2 / vec2f(bw, bh));
    let jx = smoothstep(0.0, 0.035, f.x) * smoothstep(1.0, 0.965, f.x);
    let jy = smoothstep(0.0, 0.10, f.y) * smoothstep(1.0, 0.90, f.y);
    let j = jx * jy;
    let tone = hash21(cell);
    let bf = lod(14.0, px);
    d.albedo *= mix(vec3f(0.98), mix(vec3f(1.25, 1.22, 1.15), vec3f(0.80 + 0.40 * tone), j), bf);
    d.bump = vec3f((f.x - 0.5) * (1.0 - jx), (f.y - 0.5) * (1.0 - jy), 0.0) * 1.8 * bf;
    d.ao = mix(1.0, 0.75 + 0.25 * j, bf);
  } else if (kind == 5u) {     // small wall tile
    let ts = 0.06;
    let f = fract(uv / ts); let cell = floor(uv / ts);
    let j = smoothstep(0.0, 0.07, f.x) * smoothstep(1.0, 0.93, f.x) * smoothstep(0.0, 0.07, f.y) * smoothstep(1.0, 0.93, f.y);
    let tf = lod(18.0, px);
    d.albedo *= mix(vec3f(0.97), mix(vec3f(0.72), vec3f(0.93 + 0.14 * hash21(cell)), j), tf);
    d.rough = -0.18 * j * tf;
    d.bump = vec3f((f.x - 0.5) * (1.0 - j), (f.y - 0.5) * (1.0 - j), 0.0) * 1.2 * tf;
  } else if (kind == 7u || kind == 13u) {  // wood / bark: grain along the long axis
    let g = fbm(vec3f(uv.x * 4.0, uv.y * 60.0, p.z * 2.0));
    let g2 = fbm(vec3f(uv.x * 60.0, uv.y * 4.0, 1.0));
    let gr = select(g, g2, abs(n.z) > 0.7);
    let wf = lod(40.0, px);
    d.albedo *= 1.0 + (gr - 0.5) * 0.40 * wf;
    d.bump = vec3f(gr - 0.5, 0.0, 0.0) * select(0.5, 1.6, kind == 13u) * wf;
  } else if (kind == 8u || kind == 10u) {  // metal / copper: brushed + spots
    let g = vnoise(vec3f(uv * 30.0, 6.0));
    d.albedo *= 1.0 + (g - 0.5) * 0.16 * lod(30.0, px);
    d.rough = (g - 0.5) * 0.18 * lod(30.0, px);
  } else if (kind == 9u) {     // roof tiles: rows
    let g = vnoise(vec3f(uv * 25.0, 8.0));
    d.albedo *= 1.0 + (g - 0.5) * 0.28 * lod(25.0, px);
    d.rough = (g - 0.5) * 0.2 * lod(25.0, px);
  } else if (kind == 12u) {    // leaf
    d.albedo *= 1.0 + (hash31(floor(p * 9.0)) - 0.5) * 0.35 * lod(9.0, px);
    d.albedo *= vec3f(1.25, 1.30, 0.50);      // sky-lit foliage reads too blue otherwise: push towards warm green
  } else if (kind == 14u) {    // paint (road markings, signs): wear
    let w = fbm(vec3f(uv * 7.0, 2.0));
    d.albedo *= mix(1.0, mix(0.72, 1.0, smoothstep(0.30, 0.62, w)), lod(14.0, px));
  } else {
    let g = vnoise(vec3f(uv * 40.0, 3.0));
    d.albedo *= 1.0 + (g - 0.5) * 0.08 * fade;
  }
  return d;
}

fn applyFog(col: vec3f, wpos: vec3f) -> vec3f {
  let v = wpos - F.camPos;
  let dist = length(v);
  let dir = v / max(dist, 1e-4);
  let h = max(F.camPos.z, 0.0);
  let dens = 0.0009 * exp(-h * 0.012);
  let f = 1.0 - exp(-dist * dens);
  let fc = skyBase(normalize(vec3f(dir.xy, max(dir.z, 0.0) * 0.3 + 0.03)));
  return mix(col, fc, clamp(f, 0.0, 1.0));
}

fn underCar(wpos: vec3f, car: vec4f, half: vec2f, cx: f32) -> f32 {
  if (car.w < 0.5) { return 0.0; }
  let cp = wpos.xy - car.xy - F.lightDir.xy / max(F.lightDir.z, 0.25) * 0.35;
  let cs = cos(car.z); let sn = sin(car.z);
  let q = vec2f(cp.x * cs + cp.y * sn - cx, -cp.x * sn + cp.y * cs);
  let dq = max(abs(q) - half, vec2f(0.0));
  return 1.0 - smoothstep(0.0, 0.55, length(dq));
}
fn beaconLight(b: vec4f, wpos: vec3f, N: vec3f) -> f32 {
  if (b.w < 0.01) { return 0.0; }
  let lv = b.xyz - wpos;
  let d2 = dot(lv, lv);
  return b.w * 46.0 / (1.5 + d2) * max(dot(N, lv * inverseSqrt(d2 + 1e-4)), 0.0) * (1.0 - smoothstep(18.0, 30.0, sqrt(d2)));
}

struct FOut { @location(0) color: vec4f };

fn shade(i: VOut, front: bool) -> vec4f {
  let kind = i.mat.x;
  var N = normalize(i.nrm);
  if (!front) { N = -N; }
  let V = normalize(F.camPos - i.wpos);
  let dist = distance(F.camPos, i.wpos);
  var albedo = srgbToLinear(i.col.rgb);
  var rough = i.col.a;
  let metal = f32(i.mat.y) / 255.0;
  let emis = f32(i.mat.z) / 255.0 * 8.0;
  let alpha = f32(i.mat.w) / 255.0;

  let px = max(length(dpdx(i.wpos)), length(dpdy(i.wpos)));
  let d = detail(kind, i.wpos, N, dist, px);
  albedo *= d.albedo;
  rough = clamp(rough + d.rough, 0.045, 1.0);
  // bump: perturb in the tangent frame of the dominant axis
  let a = abs(N);
  var T = vec3f(1.0, 0.0, 0.0);
  if (a.x > a.y && a.x > a.z) { T = vec3f(0.0, 1.0, 0.0); }
  let B = normalize(cross(N, T)); T = cross(B, N);
  N = normalize(N + (T * d.bump.x + B * d.bump.y) * 0.9);

  // wetness-free ground contact darkening near z = 0 on vertical faces (grime band)
  let grime = (1.0 - smoothstep(0.0, 0.55, i.wpos.z)) * (1.0 - abs(N.z)) * 0.35 * step(1.0, f32(kind));
  albedo *= 1.0 - grime * (0.6 + 0.4 * vnoise(i.wpos * 6.0) * lod(6.0, px));

  let L = F.lightDir;
  let ndl = max(dot(N, L), 0.0);
  let nv = max(dot(N, V), 1e-3);
  let H = normalize(L + V);
  let nh = max(dot(N, H), 0.0);
  let vh = max(dot(V, H), 0.0);
  var sh = 1.0;
  if (ndl > 0.0) { sh = shadow(i.wpos, normalize(i.nrm) * select(-1.0, 1.0, front), ndl); }
  // vehicles are not in the static shadow map: analytic contact shadow under them (static geometry only)
  var carOcc = 0.0;
  if (i.fade > 0.5 && i.wpos.z < 0.5) {
    carOcc = max(underCar(i.wpos, F.car0, vec2f(2.30, 0.82), -0.10), underCar(i.wpos, F.car1, vec2f(2.95, 0.98), -0.29));
    sh *= 1.0 - 0.92 * carOcc;
  }

  let f0 = mix(vec3f(0.04), albedo, metal);
  let diff = albedo * (1.0 - metal);
  let ar = rough * rough;
  let spec = D_GGX(nh, ar) * V_Smith(nv, ndl, ar) * F_Schlick(f0, vh);
  var col = (diff / PI + spec) * F.lightColor * ndl * sh;

  // red glow of the warning lamps on everything nearby
  col += diff / PI * vec3f(1.0, 0.05, 0.03) * (beaconLight(F.beaconA, i.wpos, N) + beaconLight(F.beaconB, i.wpos, N));

  // foliage: cheap translucency
  if (kind == 12u) {
    let back = max(dot(-N, L), 0.0);
    col += albedo * vec3f(0.9, 1.0, 0.45) * F.lightColor * back * 0.22 * shadow(i.wpos, -N, 1.0);
  }

  // ambient: sky hemisphere diffuse + sky reflection, with a cheap geometric occlusion term
  let hemiAO = mix(0.55, 1.0, smoothstep(-0.2, 0.9, N.z)) * d.ao;
  let lowAO = mix(0.72, 1.0, smoothstep(0.0, 2.5, i.wpos.z + N.z * 2.0));
  let amb = ambientSky(N) * hemiAO * lowAO * (1.0 - 0.55 * carOcc);
  col += diff * amb;
  let R = reflect(-V, N);
  let env = skyBase(normalize(vec3f(R.xy, abs(R.z) * 0.9 + 0.05)));
  let fr = f0 + (max(vec3f(1.0 - rough), f0) - f0) * pow(1.0 - nv, 5.0);
  col += env * fr * mix(1.0, 0.25, rough) * hemiAO * mix(0.35, 1.0, sh * 0.5 + 0.5);

  if (i.fade < 0.5 && kind != 11u) {
    let cc = 0.04 + 0.96 * pow(1.0 - nv, 5.0);
    col += envColor(R, rough, false) * cc * (1.0 - rough) * 0.85 * mix(0.55, 1.0, sh);
  }
  // emission: lamps and lit interiors come up at dusk
  let night = 1.0 - F.day;
  col += albedo * emis * mix(0.35, 2.6, night);

  // vehicle lamps (tagged at export): 20 warning lamp, 21 tail / stop, 22 turn signal, 23 headlamp.
  // A lamp is a smooth clear shell over a faceted chrome reflector: light enters, bounces off a facet and leaves through
  // the tinted lens, so the lamp shows a broken-up, coloured mirror image of its surroundings under a sharp reflection.
  if (kind >= 20u) {
    let left = i.lpos.y > 0.0;
    let Ng = normalize(i.nrm) * select(-1.0, 1.0, front);
    let nvg = max(dot(Ng, V), 1e-3);
    // lens tint from the baked lens colour (saturated), clear for headlamps
    var tint = srgbToLinear(i.col.rgb);
    tint = tint / max(max(tint.r, max(tint.g, tint.b)), 1e-3);
    tint = pow(tint, vec3f(1.6));
    // reflector optics in object space, pushed back along the view ray for depth (the pattern sits behind the lens)
    let depth = 0.012;
    let pin = i.lpos * 64.0 + (V - Ng * nvg) * (depth * 64.0 / nvg);
    let cell = floor(pin);
    let fc = fract(pin) - 0.5;
    let facet = normalize(vec3f(fc.x, fc.y, fc.z) + (vec3f(hash31(cell), hash31(cell + 7.3), hash31(cell + 13.1)) - 0.5) * 0.5);
    let Nin = normalize(Ng + facet * 0.85);
    let Rin = reflect(-V, Nin);
    var inner = envColor(Rin, 0.08, false);
    inner += F.lightColor * sh * pow(max(dot(Rin, L), 0.0), 90.0) * 14.0;            // sun glints off facets
    inner += ambientSky(Ng) * 0.25 + F.lightColor * ndl * sh * 0.10;                   // light scattered inside the housing
    // dark gaps between optics give the lamp structure
    let gap = smoothstep(0.50, 0.42, max(abs(fc.x), max(abs(fc.y), abs(fc.z))));
    inner *= mix(0.35, 1.0, gap);
    let fres = 0.04 + 0.96 * pow(1.0 - nvg, 5.0);
    let Rs = reflect(-V, Ng);
    var surf = envColor(Rs, 0.0, true) * fres;
    let Hs = normalize(L + V);
    surf += F.lightColor * max(dot(Ng, L), 0.0) * sh * D_GGX(max(dot(Ng, Hs), 0.0), 0.0025) * V_Smith(nvg, max(dot(Ng, L), 1e-3), 0.0025) * 0.04;
    var e = vec3f(0.0);
    let guide = 0.55 + 0.9 * smoothstep(0.30, 0.05, abs(fract(i.lpos.z * 16.0) - 0.5));   // LED light-guide lines
    if (kind == 20u) {
      let ph = fract(F.time * 1.7);
      let lit = step(fract(ph * 6.0), 0.55) * select(step(0.5, ph), 1.0 - step(0.5, ph), left);
      e = vec3f(1.0, 0.035, 0.02) * (26.0 * lit * i.lights.x) * (0.6 + 0.8 * gap);
    } else if (kind == 21u) {
      e = vec3f(1.0, 0.03, 0.02) * (1.3 * night + 11.0 * i.lights.w) * guide;
    } else if (kind == 22u) {
      e = vec3f(1.0, 0.36, 0.02) * 14.0 * select(i.lights.z, i.lights.y, left) * (0.6 + 0.8 * gap);
    } else {
      e = vec3f(1.0, 0.95, 0.86) * (0.4 + 10.0 * night) * (0.5 + gap);
    }
    col = inner * tint * (1.0 - fres) * 1.15 + surf + e;
    // nearby warning-lamp glow still lands on the lens
    col += tint * vec3f(1.0, 0.05, 0.03) * (beaconLight(F.beaconA, i.wpos, Ng) + beaconLight(F.beaconB, i.wpos, Ng)) * 0.1;
  }

  var outA = 1.0;
  if (kind == 11u) {   // glass: reflective, mostly see-through
    let fres = 0.04 + 0.96 * pow(1.0 - nv, 5.0);
    var envG = skyColor(normalize(vec3f(R.xy, abs(R.z) + 0.02)), true);
    if (i.fade < 0.5) { envG = envColor(R, 0.0, true); }
    col = envG * fres * 1.0 + vec3f(0.02, 0.025, 0.03) * ambientSky(N) + spec * F.lightColor * ndl * sh;
    // interior glow at night
    let lit = step(0.55, hash21(floor(i.wpos.xy * 0.35) + floor(i.wpos.z * 0.33)));
    col += vec3f(1.0, 0.82, 0.55) * lit * night * 0.9;
    outA = clamp(max(fres, 0.38) + lit * night * 0.5, 0.0, 1.0) * max(alpha, 0.35) + 0.25;
  }
  col = applyFog(col, i.wpos);
  return vec4f(col, clamp(outA, 0.0, 1.0));
}

@fragment fn fsWorld(i: VOut, @builtin(front_facing) ff: bool) -> FOut { var o: FOut; o.color = shade(i, ff); return o; }
`;

export const SKY = /* wgsl */`
struct SV { @builtin(position) clip: vec4f, @location(0) ndc: vec2f };
@vertex fn vs(@builtin(vertex_index) vi: u32) -> SV {
  var o: SV;
  let p = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u)) * 2.0 - 1.0;
  o.clip = vec4f(p, 1.0, 1.0); o.ndc = p;
  return o;
}
@fragment fn fs(i: SV) -> @location(0) vec4f {
  let a = F.invViewProj * vec4f(i.ndc, 0.2, 1.0);
  let b = F.invViewProj * vec4f(i.ndc, 0.9, 1.0);
  let dir = normalize(b.xyz / b.w - a.xyz / a.w);
  return vec4f(skyColor(dir, true), 1.0);
}
`;

export const POST = /* wgsl */`
@group(0) @binding(0) var hdr: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
struct P { res: vec2f, exposure: f32, time: f32 };
@group(0) @binding(2) var<uniform> U: P;
struct SV { @builtin(position) clip: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) vi: u32) -> SV {
  var o: SV;
  let p = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u));
  o.clip = vec4f(p * 2.0 - 1.0, 0.0, 1.0); o.uv = vec2f(p.x, 1.0 - p.y);
  return o;
}
fn aces(x: vec3f) -> vec3f {
  let a = x * (x * 2.51 + 0.03); let b = x * (x * 2.43 + 0.59) + 0.14;
  return clamp(a / b, vec3f(0.0), vec3f(1.0));
}
fn luma(c: vec3f) -> f32 { return dot(c, vec3f(0.299, 0.587, 0.114)); }
@fragment fn fs(i: SV) -> @location(0) vec4f {
  let px = 1.0 / U.res;
  // FXAA-style edge blend on the HDR buffer (cheap 5-tap)
  let c  = textureSampleLevel(hdr, samp, i.uv, 0.0).rgb;
  let n  = textureSampleLevel(hdr, samp, i.uv + vec2f(0.0, -px.y), 0.0).rgb;
  let s  = textureSampleLevel(hdr, samp, i.uv + vec2f(0.0,  px.y), 0.0).rgb;
  let e  = textureSampleLevel(hdr, samp, i.uv + vec2f( px.x, 0.0), 0.0).rgb;
  let w  = textureSampleLevel(hdr, samp, i.uv + vec2f(-px.x, 0.0), 0.0).rgb;
  let lc = luma(aces(c)); let ln = luma(aces(n)); let ls = luma(aces(s)); let le = luma(aces(e)); let lw = luma(aces(w));
  let lmin = min(lc, min(min(ln, ls), min(le, lw))); let lmax = max(lc, max(max(ln, ls), max(le, lw)));
  var col = c;
  let range = lmax - lmin;
  if (range > max(0.04, lmax * 0.12)) {
    let gx = abs(le - lw); let gy = abs(ln - ls);
    let blend = clamp(range / (lmax + 1e-4), 0.0, 1.0) * 0.5;
    let avg = select((n + s) * 0.5, (e + w) * 0.5, gx > gy);
    col = mix(c, avg, blend);
  }
  // soft bloom from a wide low-res tap
  var bloom = vec3f(0.0);
  for (var k = 0; k < 6; k++) {
    let a = f32(k) * 1.0472;
    bloom += max(textureSampleLevel(hdr, samp, i.uv + vec2f(cos(a), sin(a)) * px * 7.0, 0.0).rgb - 1.6, vec3f(0.0));
  }
  col += bloom * 0.05;
  col *= U.exposure;
  col = aces(col);
  // vignette + film grain + gentle grade
  let q = i.uv - 0.5;
  col *= 1.0 - dot(q, q) * 0.38;
  col = pow(col, vec3f(1.0 / 2.2));
  let g = fract(sin(dot(i.clip.xy + U.time * 61.0, vec2f(12.9898, 78.233))) * 43758.5453);
  col += (g - 0.5) * 0.012;
  return vec4f(col, 1.0);
}
`;
