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
  dynLightViewProj: mat4x4f,   // small shadow map that follows the player: vehicles, character, props
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
@group(0) @binding(3) var dynShadow: texture_depth_2d;
// the lamps nearest to the camera (street lights, shop fronts, lanterns): lit at dusk and at night
struct Lamps { count: vec4f, pos: array<vec4f, 12>, col: array<vec4f, 12> };
@group(0) @binding(4) var<uniform> LP: Lamps;

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
  @location(7) ao: f32,                           // baked ambient occlusion (1 = open sky)
};

@vertex fn vsWorld(v: VIn) -> VOut {
  var o: VOut;
  o.wpos = v.pos; o.nrm = octDecode(v.nrm); o.col = v.col; o.mat = v.mat; o.fade = 1.0;
  o.ao = f32(v.mat.w) / 255.0;
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
  o.col = v.col; o.mat = v.mat; o.fade = 1.0; o.ao = 1.0;
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
  o.lpos = v.pos; o.lights = M.lights; o.ao = 1.0;
  o.clip = F.viewProj * p;
  return o;
}

@vertex fn vsShadow(v: VIn) -> @builtin(position) vec4f { return F.lightViewProj * vec4f(v.pos, 1.0); }
@vertex fn vsShadowDyn(v: VIn) -> @builtin(position) vec4f { return F.lightViewProj * (M.m * vec4f(v.pos, 1.0)); }
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
  var res = mix(1.0, s * 0.2, inside);
  // moving things: vehicles, the character and loose props cast shadows from their own small map
  let lp2 = F.dynLightViewProj * vec4f(wpos + bias * 0.6, 1.0);
  let uv2 = lp2.xy * vec2f(0.5, -0.5) + 0.5;
  if (uv2.x > 0.0 && uv2.x < 1.0 && uv2.y > 0.0 && uv2.y < 1.0 && lp2.z > 0.0 && lp2.z < 1.0) {
    let z2 = lp2.z - 0.0009;
    let t2 = 1.0 / 1024.0;
    var d = textureSampleCompareLevel(dynShadow, shadowSamp, uv2, z2);
    d += textureSampleCompareLevel(dynShadow, shadowSamp, uv2 + vec2f(cs.x, cs.y) * t2 * 1.5, z2);
    d += textureSampleCompareLevel(dynShadow, shadowSamp, uv2 + vec2f(-cs.y, cs.x) * t2 * 1.5, z2);
    d += textureSampleCompareLevel(dynShadow, shadowSamp, uv2 - vec2f(cs.x, cs.y) * t2 * 1.5, z2);
    d += textureSampleCompareLevel(dynShadow, shadowSamp, uv2 - vec2f(-cs.y, cs.x) * t2 * 1.5, z2);
    let edge = min(min(uv2.x, 1.0 - uv2.x), min(uv2.y, 1.0 - uv2.y));
    res = min(res, mix(1.0, d * 0.2, smoothstep(0.0, 0.05, edge)));
  }
  return res;
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
  if (kind == 1u) {            // asphalt: bitumen with exposed aggregate at three sizes, tar patches, oil, polished wheel paths
    let c1 = floor(uv * 260.0); let c2 = floor(uv * 95.0); let c3 = floor(uv * 34.0);
    let s1 = hash21(c1); let s2 = hash21(c2 + 17.0); let s3 = hash21(c3 + 41.0);
    let f1 = lod(260.0, px); let f2 = lod(95.0, px); let f3 = lod(34.0, px);
    // pale stones showing through the dark binder
    let stone = step(0.80, s1) * f1 * 0.55 + step(0.86, s2) * f2 * 0.42 + step(0.93, s3) * f3 * 0.22;
    let binder = (s1 - 0.5) * 0.22 * f1 + (s2 - 0.5) * 0.14 * f2;
    d.albedo *= 1.0 + stone + binder;
    // older, greyer surface in blotches; dark tar patches with soft edges; a few oil drips
    let age = vnoise(vec3f(uv * 0.9, 3.0));
    // tone and unevenness measured on the reference photographs: neutral mid grey, about +-20 % in metre-sized blotches
    let age2 = vnoise(vec3f(uv * 0.21, 5.0));
    d.albedo *= mix(0.74, 1.08, smoothstep(0.25, 0.80, age)) * mix(0.84, 1.10, age2);
    let patchK = smoothstep(0.60, 0.66, vnoise(vec3f(uv * 0.33, 7.0)));
    d.albedo *= mix(1.0, 0.72, patchK);
    let oil = smoothstep(0.80, 0.90, vnoise(vec3f(uv * 2.6, 11.0))) * lod(3.0, px);
    d.albedo *= mix(1.0, 0.55, oil);
    d.rough = -0.22 * oil + (s1 - 0.5) * 0.10 * f1 - 0.05 * patchK;
    d.bump = vec3f(s1 - 0.5, hash21(c1 + 7.0) - 0.5, 0.0) * 0.75 * f1 + vec3f(s2 - 0.5, hash21(c2 + 5.0) - 0.5, 0.0) * 0.45 * f2;
    d.ao = 1.0 - 0.18 * (1.0 - s2) * f2;
  } else if (kind == 2u || kind == 6u) {   // concrete / plaster: pores, stains
    let g = vnoise(vec3f(uv * 60.0, 1.0));
    d.albedo *= 1.0 + (g - 0.5) * 0.14 * lod(60.0, px);
    let st = fbm(vec3f(uv.x * 1.3, uv.y * 0.25, 3.0));
    d.albedo *= mix(1.0, 0.80, smoothstep(0.52, 0.80, st) * abs(n.z - 1.0));
    d.bump = vec3f(vnoise(vec3f(uv * 90.0, 2.0)) - 0.5, vnoise(vec3f(uv * 90.0, 5.0)) - 0.5, 0.0) * 0.25 * fade;
  } else if (kind == 3u || kind == 15u) {  // stone (granite: fine crystals) / gravel (pebbles at two sizes)
    let c1 = floor(uv * 300.0); let c2 = floor(uv * 110.0);
    let s1 = hash21(c1); let s2 = hash21(c2 + 9.0);
    let f1 = lod(300.0, px); let f2 = lod(110.0, px);
    let m = vnoise(vec3f(uv * 9.0, 4.0));
    if (kind == 3u) {
      // dark mica flecks, pale feldspar, soft mottling
      d.albedo *= 1.0 + (s1 - 0.5) * 0.34 * f1 - step(0.90, s2) * 0.30 * f2 + step(0.93, hash21(c2 + 31.0)) * 0.22 * f2 + (m - 0.5) * 0.16 * lod(9.0, px);
      d.rough = (s1 - 0.5) * 0.16 * f1;
      d.bump = vec3f(s1 - 0.5, hash21(c1 + 3.0) - 0.5, 0.0) * 0.40 * f1;
    } else {
      let c3 = floor(uv * 42.0); let s3 = hash21(c3 + 23.0);
      let f3 = lod(42.0, px);
      let q = fract(uv * 42.0) - 0.5;
      let pebble = (1.0 - smoothstep(0.20, 0.48, length(q + (vec2f(s3, hash21(c3 + 2.0)) - 0.5) * 0.3))) * f3;
      d.albedo *= 1.0 + (s3 - 0.5) * 0.55 * f3 + (s2 - 0.5) * 0.35 * f2 + (s1 - 0.5) * 0.20 * f1 - 0.28 * (1.0 - pebble) * f3 + (m - 0.5) * 0.12;
      d.bump = vec3f(q.x, q.y, 0.0) * pebble * 2.2 + vec3f(s2 - 0.5, hash21(c2 + 5.0) - 0.5, 0.0) * 0.6 * f2;
      d.ao = 1.0 - 0.25 * (1.0 - pebble) * f3;
    }
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
  // weathering of walls, as seen on the photographs: rain streaks running down, and a dirty splash band above the ground
  let wall = 1.0 - abs(n.z);
  if (wall > 0.6 && ((kind >= 2u && kind <= 6u) || kind == 27u)) {
    let along = dot(p.xy, vec2f(-n.y, n.x));
    let s1 = vnoise(vec3f(along * 3.2, p.z * 0.22, 9.0));
    let s2 = vnoise(vec3f(along * 14.0, p.z * 0.7, 4.0));
    let streak = smoothstep(0.50, 0.78, s1 * 0.65 + s2 * 0.35) * lod(14.0, px);
    d.albedo *= mix(vec3f(1.0), vec3f(0.70, 0.69, 0.66), streak);
    let splash = (1.0 - smoothstep(0.02, 0.60, p.z)) * (0.45 + 0.55 * vnoise(vec3f(along * 2.5, 1.0, 6.0)));
    d.albedo *= mix(vec3f(1.0), vec3f(0.60, 0.58, 0.54), splash * 0.7);
    d.rough += streak * 0.06;
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

// Interior mapping: a room behind every upper-floor window, found by intersecting the view ray with the walls, floor
// and ceiling of a grid of rooms. No geometry, no textures - but it has real parallax, so windows stop being flat.
fn interiorRoom(p: vec3f, V: vec3f, N: vec3f, night: f32) -> vec3f {
  let d = -V;
  let a = abs(N);
  // axes: u along the facade, z up, n into the building
  var u = vec3f(1.0, 0.0, 0.0); var nrm = vec3f(0.0, sign(N.y + 1e-5), 0.0);
  if (a.x > a.y) { u = vec3f(0.0, 1.0, 0.0); nrm = vec3f(sign(N.x + 1e-5), 0.0, 0.0); }
  let S = vec3f(3.6, 2.85, 4.2);                         // room width, storey height, depth
  let pu = dot(p, u) / S.x; let pz = (p.z - 0.25) / S.y;
  let du = dot(d, u) / S.x; let dz = d.z / S.y; let dn = max(-dot(d, nrm), 1e-3) / S.z;
  let cu = floor(pu); let cz = floor(pz);
  let tu = (cu + step(0.0, du) - pu) / (du + sign(du + 1e-6) * 1e-5);
  let tz = (cz + step(0.0, dz) - pz) / (dz + sign(dz + 1e-6) * 1e-5);
  let tn = 1.0 / dn;
  let t = min(tn, min(tu, tz));
  let room = vec2f(cu, cz);
  let h = hash21(room + 3.7); let h2 = hash21(room * 1.7 + 9.1);
  let lit = step(0.50, h) * night;                        // about half the rooms have their lights on at night
  let fu = fract(pu + du * t); let fz = fract(pz + dz * t); let fn_ = t * dn;      // where the ray lands, 0..1
  var c: vec3f;
  let wallTint = mix(vec3f(0.78, 0.76, 0.70), vec3f(0.62, 0.66, 0.72), h2);
  if (t == tn) {
    // back wall: a door or shelving block, a picture, skirting
    c = wallTint * 0.85;
    let door = step(abs(fu - (0.25 + 0.5 * h2)), 0.11) * step(fz, 0.72);
    c = mix(c, vec3f(0.30, 0.22, 0.15), door);
    let shelf = step(abs(fu - (0.78 - 0.5 * h2)), 0.14) * step(fz, 0.45) * (1.0 - door);
    c = mix(c, vec3f(0.42, 0.38, 0.33) * (0.7 + 0.5 * step(0.5, fract(fz * 9.0))), shelf);
  } else if (t == tz) {
    if (dz > 0.0) { c = vec3f(0.86, 0.85, 0.82); let lamp = 1.0 - smoothstep(0.02, 0.10, length(vec2f(fu - 0.5, fn_ - 0.45))); c += vec3f(4.0, 3.6, 2.9) * lamp * lit; }
    else { c = mix(vec3f(0.36, 0.27, 0.19), vec3f(0.42, 0.42, 0.44), step(0.6, h2)); }
  } else {
    c = wallTint * 0.72;
  }
  // curtains / blinds drawn across part of some windows, just behind the glass
  let cur = step(0.62, h2) * step(fract(pu), 0.28 + 0.4 * h);
  // light: daylight falling in from the window by day, the ceiling lamp at night
  let depth = clamp(t * dn, 0.0, 1.0);
  let dayIn = mix(0.55, 0.10, depth) * F.day * (0.6 + 0.6 * max(F.sunDir.z, 0.0));
  let lampIn = lit * mix(0.55, 0.95, 1.0 - abs(fz - 0.6)) * mix(vec3f(1.0, 0.78, 0.50), vec3f(0.85, 0.92, 1.0), step(0.75, h2));
  var outc = c * (vec3f(dayIn) * ambientSky(vec3f(0.0, 0.0, 1.0)) * 2.2 + lampIn * 1.6 + 0.004);
  let curtain = mix(vec3f(0.80, 0.78, 0.72), vec3f(0.55, 0.60, 0.50), h) * (0.9 + 0.1 * sin(pu * S.x * 40.0));
  outc = mix(outc, curtain * (ambientSky(N) * 0.9 * F.day + lampIn * 0.5 + 0.003), cur);
  return outc;
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
  let metal = select(f32(i.mat.y) / 255.0, 0.0, kind == 27u);
  let emis = f32(i.mat.z) / 255.0 * 8.0;
  let alpha = f32(i.mat.w) / 255.0;

  let px = max(length(dpdx(i.wpos)), length(dpdy(i.wpos)));
  let d = detail(kind, i.wpos, N, dist, px);
  albedo *= d.albedo;
  rough = clamp(rough + d.rough, 0.045, 1.0);
  // backdrop buildings: window grid drawn on the walls (mat.y carries a per-building seed)
  var cityLit = 0.0;
  if (kind == 27u && abs(N.z) < 0.5) {
    let bid = f32(i.mat.y);
    let along = dot(i.wpos.xy, vec2f(-N.y, N.x));
    let pitch = 2.2 + fract(bid * 0.37) * 1.6;
    let fl = 3.2;
    let cu = along / pitch; let cv = (i.wpos.z - 0.9) / fl;
    let fu = fract(cu); let fv = fract(cv);
    let ww = 0.50 + 0.34 * fract(bid * 0.19);
    let eu = px / pitch * 1.2; let ev = px / fl * 1.2;
    var win = smoothstep(ww * 0.5 + eu, ww * 0.5 - eu, abs(fu - 0.5)) * smoothstep(0.24 - ev, 0.24 + ev, fv) * smoothstep(0.80 + ev, 0.80 - ev, fv);
    let f = lod(0.30, px);
    win = mix(ww * 0.56, win, f) * step(0.0, cv);
    // aluminium frame and a centre mullion around dark, smooth glass; some rooms have their curtains drawn
    let du = (ww * 0.5 - abs(fu - 0.5)) * pitch; let dv2 = min(fv - 0.24, 0.80 - fv) * fl;
    let inner = smoothstep(0.05, 0.05 + px, min(du, dv2)) * smoothstep(0.02, 0.02 + px, abs(fu - 0.5) * pitch);
    let glassK = win * mix(1.0, inner, f);
    let h3 = hash21(vec2f(floor(cu) + 3.0, floor(cv) + bid));
    let curt = step(0.68, h3) * f;
    albedo = mix(albedo, vec3f(0.42, 0.43, 0.44), (win - glassK));
    albedo = mix(albedo, mix(vec3f(0.035, 0.045, 0.055), vec3f(0.46, 0.44, 0.39), curt * 0.8), glassK);
    rough = mix(rough, mix(0.07, 0.35, curt), glassK);
    win = glassK;
    let hc = hash21(vec2f(floor(cu), floor(cv)) + bid * 7.3);
    cityLit = win * mix(0.26, step(0.74, hc), f) * (0.6 + 0.4 * hash21(vec2f(floor(cv), floor(cu)) + bid));
  }
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
  // baked occlusion where the world data has it (F.quality = 1), otherwise the old height heuristic
  let bakedAO = select(1.0, mix(1.0, clamp(i.ao, 0.0, 1.0), F.quality), kind != 11u && i.fade > 0.5);
  let hemiAO = mix(0.55, 1.0, smoothstep(-0.2, 0.9, N.z)) * d.ao * mix(0.38, 1.0, bakedAO);
  let lowAO = mix(mix(0.72, 1.0, smoothstep(0.0, 2.5, i.wpos.z + N.z * 2.0)), 1.0, F.quality);
  let bounce = vec3f(0.30, 0.27, 0.23) * F.day * max(F.sunDir.z, 0.0) * (1.0 - bakedAO) * 0.55;
  let amb = (ambientSky(N) * hemiAO * lowAO + bounce) * (1.0 - 0.55 * carOcc);
  col += diff * amb;
  let R = reflect(-V, N);
  let env = skyBase(normalize(vec3f(R.xy, abs(R.z) * 0.9 + 0.05)));
  let fr = f0 + (max(vec3f(1.0 - rough), f0) - f0) * pow(1.0 - nv, 5.0);
  col += env * fr * mix(1.0, 0.25, rough) * hemiAO * mix(0.35, 1.0, sh * 0.5 + 0.5);

  // street lights and other lamps after dark (no shadows; the baked occlusion keeps them out of deep corners)
  let nl = i32(LP.count.x);
  if (nl > 0) {
    var lampSum = vec3f(0.0);
    for (var k = 0; k < nl; k++) {
      let lv = LP.pos[k].xyz - i.wpos;
      let d2 = dot(lv, lv);
      let range = LP.pos[k].w;
      if (d2 < range * range) {
        let ld = lv * inverseSqrt(d2 + 1e-4);
        let win = 1.0 - smoothstep(0.55, 1.0, sqrt(d2) / range);
        let nd = max(dot(N, ld), 0.0) * 0.85 + 0.15;                  // a little wrap: lamps are area sources
        let hv = normalize(ld + V);
        let sp2 = pow(max(dot(N, hv), 0.0), mix(60.0, 6.0, rough)) * (1.0 - rough) * 0.6;
        lampSum += LP.col[k].rgb * (win / (1.0 + d2 * 0.35)) * (diff * nd / PI + f0 * sp2 + sp2 * 0.04);
      }
    }
    col += lampSum * LP.count.y * mix(0.45, 1.0, bakedAO);
  }

  if (i.fade < 0.5 && kind != 11u) {
    let cc = 0.04 + 0.96 * pow(1.0 - nv, 5.0);
    col += envColor(R, rough, false) * cc * (1.0 - rough) * 0.85 * mix(0.55, 1.0, sh);
  }
  // emission: lamps and lit interiors come up at dusk
  let night = 1.0 - F.day;
  col += albedo * emis * mix(0.35, 1.5, night);
  col += vec3f(1.0, 0.80, 0.52) * cityLit * smoothstep(0.35, 0.85, night) * 0.75;

  // traffic signals (lenses tagged at export): 24 red, 25 yellow, 26 green. Heads facing north / south serve one
  // direction of traffic, heads facing east / west the other; 44 s cycle with all-red gaps. Pedestrian heads face the
  // same way as the traffic they run parallel to, so the same rule lights their red / green figures.
  if (kind >= 24u && kind <= 26u) {
    let Nl = normalize(i.nrm);
    let ew = abs(Nl.x) > abs(Nl.y);
    let t = (F.time + select(0.0, 22.0, ew)) % 44.0;
    let green = t < 16.0; let yellow = t >= 16.0 && t < 19.0;
    let on = (kind == 26u && green) || (kind == 25u && yellow) || (kind == 24u && !green && !yellow);
    var lc = vec3f(1.0, 0.045, 0.02);
    if (kind == 25u) { lc = vec3f(1.0, 0.60, 0.0); } else if (kind == 26u) { lc = vec3f(0.0, 1.0, 0.60); }
    let led = 0.55 + 0.45 * smoothstep(0.30, 0.10, length(fract(i.wpos.xz * 55.0 + i.wpos.yy * 55.0) - 0.5));   // LED dot matrix
    col = select(lc * 0.012 + col * 0.05, lc * (7.5 + 3.0 * night) * led, on);
  }

  // vehicle lamps (tagged at export): 20 warning lamp, 21 tail / stop, 22 turn signal, 23 headlamp.
  // A lamp is a smooth clear shell over a faceted chrome reflector: light enters, bounces off a facet and leaves through
  // the tinted lens, so the lamp shows a broken-up, coloured mirror image of its surroundings under a sharp reflection.
  if (kind >= 20u && kind <= 23u) {
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
    if (i.fade > 0.5 && i.wpos.z > 3.3 && abs(N.z) < 0.5) {
      // upper floors: a room behind the glass (ground-floor glass stays see-through: shops have real interiors)
      let Ng = normalize(i.nrm) * select(-1.0, 1.0, front);
      let room = interiorRoom(i.wpos - Ng * 0.03, V, Ng, night);
      col = room * (1.0 - fres) * 0.92 + envG * fres + spec * F.lightColor * ndl * sh;
      outA = 1.0;
    }
  }
  col = applyFog(col, i.wpos);
  if (i.fade < 0.5 && kind != 11u) { outA = 0.5; }       // marks moving objects for the temporal pass
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
struct P { res: vec2f, exposure: f32, time: f32, proj: vec4f, fx: vec4f };   // proj: near, far, tan(fov/2), aspect; fx: ssao strength
@group(0) @binding(2) var<uniform> U: P;
@group(0) @binding(3) var depthTex: texture_depth_2d;

fn viewPos(px: vec2i) -> vec3f {
  let dims = vec2i(U.res);
  let q = clamp(px, vec2i(0), dims - 1);
  let d = textureLoad(depthTex, q, 0);
  let z = U.proj.x * U.proj.y / (U.proj.y - d * (U.proj.y - U.proj.x));
  let ndc = (vec2f(q) + 0.5) / U.res * 2.0 - 1.0;
  return vec3f(ndc.x * U.proj.z * U.proj.w * z, -ndc.y * U.proj.z * z, z);
}
// Small-scale contact shadows: how much of the hemisphere above the surface is blocked by nearby depth samples.
fn ssao(frag: vec2f) -> f32 {
  let px = vec2i(frag);
  let P0 = viewPos(px);
  if (P0.z > U.proj.y * 0.6) { return 1.0; }
  // normal from the nearer of the two neighbours on each axis (avoids bleeding across depth edges)
  let l = viewPos(px - vec2i(1, 0)); let r = viewPos(px + vec2i(1, 0));
  let u = viewPos(px - vec2i(0, 1)); let dn = viewPos(px + vec2i(0, 1));
  let dx = select(r - P0, P0 - l, abs(l.z - P0.z) < abs(r.z - P0.z));
  let dy = select(dn - P0, P0 - u, abs(u.z - P0.z) < abs(dn.z - P0.z));
  let n = normalize(cross(dy, dx));
  let radius = 0.55;                                     // metres
  let rpx = clamp(radius / (P0.z * U.proj.z) * U.res.y * 0.5, 3.0, 48.0);
  let rot = fract(52.9829189 * fract(dot(frag + U.fx.z * vec2f(47.0, 17.0), vec2f(0.06711056, 0.00583715)))) * 6.2831853;
  var occ = 0.0;
  for (var k = 0; k < 6; k++) {
    let a = rot + f32(k) * 2.39996;
    let rr = rpx * sqrt((f32(k) + 0.5) / 6.0);
    let Ps = viewPos(px + vec2i(vec2f(cos(a), sin(a)) * rr));
    let v = Ps - P0;
    let d2 = dot(v, v);
    occ += max(dot(n, v) - 0.03 * P0.z - 0.01, 0.0) / (d2 + 0.004) * step(d2, radius * radius * 2.5);
  }
  return clamp(1.0 - occ * 0.36, 0.0, 1.0);
}
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
  if (U.fx.y < 0.5 && range > max(0.04, lmax * 0.12)) {     // FXAA only when temporal AA is off
    let gx = abs(le - lw); let gy = abs(ln - ls);
    let blend = clamp(range / (lmax + 1e-4), 0.0, 1.0) * 0.5;
    let avg = select((n + s) * 0.5, (e + w) * 0.5, gx > gy);
    col = mix(c, avg, blend);
  }
  if (U.fx.y > 0.5) {                                          // temporal AA softens a little: restore crispness
    let lo = min(c, min(min(n, s), min(e, w))); let hi = max(c, max(max(n, s), max(e, w)));
    col = clamp(c + (c - (n + s + e + w) * 0.25) * 1.1, lo, hi);
    col *= textureSampleLevel(hdr, samp, i.uv, 0.0).a;
  }
  // soft bloom from a wide low-res tap
  var bloom = vec3f(0.0);
  for (var k = 0; k < 6; k++) {
    let a = f32(k) * 1.0472;
    bloom += max(textureSampleLevel(hdr, samp, i.uv + vec2f(cos(a), sin(a)) * px * 7.0, 0.0).rgb - 1.6, vec3f(0.0));
  }
  col += bloom * 0.05;
  if (U.fx.x > 0.0 && U.fx.y < 0.5) { col *= mix(1.0, ssao(i.uv * U.res), U.fx.x); }   // with temporal AA the AO is applied there
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

// Temporal anti-aliasing: every frame is rendered with a different sub-pixel offset and blended into a history image.
// The history is re-projected through the depth buffer, and clamped to the colours around the current pixel so that
// moving things (vehicles, the character, swaying leaves) do not leave trails.
export const TAA = /* wgsl */`
@group(0) @binding(0) var cur: texture_2d<f32>;
@group(0) @binding(1) var hist: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var depthTex: texture_depth_2d;
struct T { invViewProj: mat4x4f, prevViewProj: mat4x4f, res: vec2f, jitter: vec2f, blend: f32, ssao: f32, frame: f32, p2: f32, proj: vec4f };
@group(0) @binding(4) var<uniform> U: T;
fn viewPos(px: vec2i) -> vec3f {
  let dims = vec2i(U.res);
  let q = clamp(px, vec2i(0), dims - 1);
  let d = textureLoad(depthTex, q, 0);
  let z = U.proj.x * U.proj.y / (U.proj.y - d * (U.proj.y - U.proj.x));
  let ndc = (vec2f(q) + 0.5) / U.res * 2.0 - 1.0;
  return vec3f(ndc.x * U.proj.z * U.proj.w * z, -ndc.y * U.proj.z * z, z);
}
fn ssao(px: vec2i) -> f32 {
  let P0 = viewPos(px);
  if (P0.z > U.proj.y * 0.6) { return 1.0; }
  let l = viewPos(px - vec2i(1, 0)); let r = viewPos(px + vec2i(1, 0));
  let u = viewPos(px - vec2i(0, 1)); let dn = viewPos(px + vec2i(0, 1));
  let dx = select(r - P0, P0 - l, abs(l.z - P0.z) < abs(r.z - P0.z));
  let dy = select(dn - P0, P0 - u, abs(u.z - P0.z) < abs(dn.z - P0.z));
  let n = normalize(cross(dy, dx));
  let radius = 0.55;
  let rpx = clamp(radius / (P0.z * U.proj.z) * U.res.y * 0.5, 3.0, 48.0);
  let rot = fract(52.9829189 * fract(dot(vec2f(px) + U.frame * vec2f(5.588238, 3.1415), vec2f(0.06711056, 0.00583715)))) * 6.2831853;
  var occ = 0.0;
  for (var k = 0; k < 6; k++) {
    let a = rot + f32(k) * 2.39996;
    let rr = rpx * sqrt((f32(k) + 0.5) / 6.0);
    let Ps = viewPos(px + vec2i(vec2f(cos(a), sin(a)) * rr));
    let v = Ps - P0;
    let d2 = dot(v, v);
    occ += max(dot(n, v) - 0.03 * P0.z - 0.01, 0.0) / (d2 + 0.004) * step(d2, radius * radius * 2.5);
  }
  return clamp(1.0 - occ * 0.36, 0.0, 1.0);
}
struct SV { @builtin(position) clip: vec4f };
@vertex fn vs(@builtin(vertex_index) vi: u32) -> SV {
  var o: SV;
  let p = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u));
  o.clip = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
  return o;
}
fn tm(c: vec3f) -> vec3f { return c / (1.0 + max(c.r, max(c.g, c.b))); }       // reversible tone map: stable blending of HDR
fn itm(c: vec3f) -> vec3f { return c / max(1.0 - max(c.r, max(c.g, c.b)), 1e-4); }
@fragment fn fs(i: SV) -> @location(0) vec4f {
  let px = vec2i(i.clip.xy);
  let dims = vec2i(U.res);
  var ao = 1.0;
  if (U.ssao > 0.0) { ao = mix(1.0, ssao(px), U.ssao); }
  let c4 = textureLoad(cur, px, 0);
  let moving = c4.a > 0.25 && c4.a < 0.75;
  let c = tm(c4.rgb);
  var mn = c; var mx = c;
  var dmin = textureLoad(depthTex, px, 0);
  var dpx = px;
  for (var k = 0; k < 4; k++) {
    let o = vec2i(select(-1, 1, (k & 1) == 1), select(-1, 1, (k & 2) == 2));
    let q = clamp(px + o, vec2i(0), dims - 1);
    let n = tm(textureLoad(cur, q, 0).rgb);
    mn = min(mn, n); mx = max(mx, n);
    let d = textureLoad(depthTex, q, 0);
    if (d < dmin) { dmin = d; dpx = q; }                 // follow the nearest surface: keeps thin edges (wires) stable
  }
  for (var k = 0; k < 4; k++) {
    let o = vec2i(select(0, select(-1, 1, k == 1), k < 2), select(0, select(-1, 1, k == 3), k >= 2));
    let n = tm(textureLoad(cur, clamp(px + o, vec2i(0), dims - 1), 0).rgb);
    mn = min(mn, n); mx = max(mx, n);
  }
  let uv = (vec2f(px) + 0.5) / U.res;
  let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0) - U.jitter;
  let w = U.invViewProj * vec4f(ndc, dmin, 1.0);
  let pc = U.prevViewProj * vec4f(w.xyz / w.w, 1.0);
  let pn = pc.xy / pc.w;
  let puv = vec2f(pn.x * 0.5 + 0.5, 0.5 - pn.y * 0.5);
  var blend = U.blend;
  var huv = puv;
  if (pc.w <= 0.0 || puv.x < 0.0 || puv.x > 1.0 || puv.y < 0.0 || puv.y > 1.0) { blend = 1.0; }
  if (moving) { huv = uv; blend = max(blend, 0.45); }
  let hs = textureSampleLevel(hist, samp, huv, 0.0);
  let h = clamp(tm(hs.rgb), mn, mx);
  let aoAcc = select(mix(hs.a, ao, 0.07), ao, blend >= 1.0);
  return vec4f(itm(mix(h, c, blend)), aoAcc);
}
`;
