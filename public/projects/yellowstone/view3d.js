// The 3D view of Yellowstone (WebGPU, drawn with the same graphics-card device the simulation uses).
//
// The ground is one grid of 400 x 400 cells drawn as a surface whose height at each cell is the cell's height (or its lake's surface), stretched upward by a factor you can change because the real land is
// very flat next to its width. Its colours are the ones the flat map shows (the sim's own `landRgb` and layers, uploaded as a small texture whenever they are repainted), so every layer works here too.
// Hills hide what is behind them, as they do to the animals, because the picture is made by a depth buffer from where the camera is. Animals are small arrowheads pointing along their heading.
// Nothing here runs on the processor except putting the animals' positions in a buffer: the surface is a single draw with no vertex data, its heights read from a texture in the shader.
const FOV = (50 * Math.PI) / 180;
const SAMPLES = 4;   // multisampling, so edges are smooth
const WEDGE = { rings: 6, segs: 24 };   // the selected animal's field of view, drawn on the ground as a fan

const WGSL = /* wgsl */ `
struct U {
  vp: mat4x4<f32>,
  cam: vec4<f32>,    // camera position, and how many pixels a unit of length is one unit away
  a: vec4<f32>,      // cells across, height scale (cells per height unit), 0, 0
  w: vec4<f32>,      // the field of view fan: centre x, centre z, middle angle, half angle
  w2: vec4<f32>,     // its radius, 0, 0, 0
}
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var heightTex: texture_2d<f32>;
@group(0) @binding(2) var colTex: texture_2d<f32>;

fn hAt(x: f32, z: f32) -> f32 {   // the ground's height (in cells) at a place, between the cell centres
  let m = u.a.x - 1.001;
  let fx = clamp(x - 0.5, 0.0, m);
  let fz = clamp(z - 0.5, 0.0, m);
  let ix = i32(floor(fx));
  let iz = i32(floor(fz));
  let tx = fx - floor(fx);
  let tz = fz - floor(fz);
  let h00 = textureLoad(heightTex, vec2<i32>(ix, iz), 0).x;
  let h10 = textureLoad(heightTex, vec2<i32>(ix + 1, iz), 0).x;
  let h01 = textureLoad(heightTex, vec2<i32>(ix, iz + 1), 0).x;
  let h11 = textureLoad(heightTex, vec2<i32>(ix + 1, iz + 1), 0).x;
  return mix(mix(h00, h10, tx), mix(h01, h11, tx), tz) * u.a.y;
}

struct TOut { @builtin(position) pos: vec4<f32>, @location(0) cell: vec2<f32> }

@vertex fn tvs(@builtin(vertex_index) vi: u32) -> TOut {
  var qx = array<u32, 6>(0u, 1u, 0u, 1u, 1u, 0u);
  var qz = array<u32, 6>(0u, 0u, 1u, 0u, 1u, 1u);
  let m = u32(u.a.x) - 1u;
  let q = vi / 6u;
  let k = vi % 6u;
  let ix = q % m + qx[k];
  let iz = q / m + qz[k];
  let h = textureLoad(heightTex, vec2<i32>(i32(ix), i32(iz)), 0).x * u.a.y;
  let p = vec3<f32>(f32(ix) + 0.5, h, f32(iz) + 0.5);
  var o: TOut;
  o.pos = u.vp * vec4<f32>(p, 1.0);
  o.cell = p.xz;
  return o;
}

@fragment fn tfs(i: TOut) -> @location(0) vec4<f32> {
  let n = i32(u.a.x);
  let c = clamp(vec2<i32>(floor(i.cell)), vec2<i32>(0), vec2<i32>(n - 1));
  return vec4<f32>(textureLoad(colTex, c, 0).rgb, 1.0);
}

struct AIn { @location(0) p: vec3<f32>, @location(1) col: u32 }
struct AOut { @builtin(position) pos: vec4<f32>, @location(0) col: vec3<f32> }

// an animal: x, z, heading (0 to 7, and 8 more for the one being watched), colour. A little four-sided arrowhead pointing the way it faces.
@vertex fn avs(@builtin(vertex_index) vi: u32, a: AIn) -> AOut {
  var idx = array<u32, 12>(0u, 2u, 1u, 0u, 3u, 2u, 2u, 3u, 1u, 1u, 3u, 0u);
  var shade = array<f32, 4>(0.55, 1.0, 0.8, 0.9);
  let sel = a.p.z >= 8.0;
  let ang = (a.p.z - select(0.0, 8.0, sel)) * 0.7853982;
  let f = vec2<f32>(sin(ang), -cos(ang));
  let r = vec2<f32>(-f.y, f.x);
  let ground = hAt(a.p.x, a.p.y);
  let c3 = vec3<f32>(a.p.x, ground, a.p.y);
  // big enough to see from far away: at least a couple of pixels across
  var s = max(0.9, 2.4 * length(u.cam.xyz - c3) / u.cam.w);
  if (sel) { s = s * 1.9; }
  var pts = array<vec3<f32>, 4>(
    vec3<f32>(f.x * 0.9 * s, 0.0, f.y * 0.9 * s),
    vec3<f32>(-f.x * 0.6 * s - r.x * 0.5 * s, 0.0, -f.y * 0.6 * s - r.y * 0.5 * s),
    vec3<f32>(-f.x * 0.6 * s + r.x * 0.5 * s, 0.0, -f.y * 0.6 * s + r.y * 0.5 * s),
    vec3<f32>(0.0, 0.75 * s, 0.0));
  let k = idx[vi];
  var o: AOut;
  o.pos = u.vp * vec4<f32>(c3 + pts[k] + vec3<f32>(0.0, 0.1 * s, 0.0), 1.0);
  var col = vec3<f32>(f32(a.col & 255u), f32((a.col >> 8u) & 255u), f32((a.col >> 16u) & 255u)) / 255.0;
  if (sel) { col = mix(col, vec3<f32>(1.0), 0.5); }
  o.col = col * shade[vi / 3u];
  return o;
}

@fragment fn afs(i: AOut) -> @location(0) vec4<f32> { return vec4<f32>(i.col, 1.0); }

// the field of view: a fan on the ground, in rings so that it follows the hills
@vertex fn wvs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4<f32> {
  var qx = array<u32, 6>(0u, 1u, 0u, 1u, 1u, 0u);
  var qz = array<u32, 6>(0u, 0u, 1u, 0u, 1u, 1u);
  let q = vi / 6u;
  let k = vi % 6u;
  let ring = q / ${WEDGE.segs}u + qz[k];
  let seg = q % ${WEDGE.segs}u + qx[k];
  let rad = f32(ring) / ${WEDGE.rings}.0 * u.w2.x;
  let ang = u.w.z - u.w.w + f32(seg) / ${WEDGE.segs}.0 * 2.0 * u.w.w;
  let x = u.w.x + sin(ang) * rad;
  let z = u.w.y - cos(ang) * rad;
  return u.vp * vec4<f32>(x, hAt(x, z) + 0.3, z, 1.0);
}

@fragment fn wfs() -> @location(0) vec4<f32> { return vec4<f32>(0.22, 0.22, 0.22, 0.22); }   // (white, a fifth opaque, premultiplied)
`;

/* ---------------------------------------------------------------- small matrices (column-major, depth 0 to 1) */

function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2);
  return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, far / (near - far), -1, 0, 0, (near * far) / (near - far), 0]);
}
function lookAt(e, t) {
  let zx = e[0] - t[0], zy = e[1] - t[1], zz = e[2] - t[2];
  const zl = Math.hypot(zx, zy, zz) || 1; zx /= zl; zy /= zl; zz /= zl;
  let xx = zz, xy = 0, xz = -zx;   // (up x z, with up = (0, 1, 0))
  const xl = Math.hypot(xx, xz) || 1; xx /= xl; xz /= xl;
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  return new Float32Array([xx, yx, zx, 0, xy, yy, zy, 0, xz, yz, zz, 0, -(xx * e[0] + xy * e[1] + xz * e[2]), -(yx * e[0] + yy * e[1] + yz * e[2]), -(zx * e[0] + zy * e[1] + zz * e[2]), 1]);
}
function mul(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  return o;
}

/* ---------------------------------------------------------------- the view */

/** Make the 3D view on `canvas` with the graphics card's `device`. `onChange` is called when the camera moves, and `onPick(animal)` when an animal is clicked. */
export function createView3d(canvas, device, { onPick } = {}) {
  const ctx = canvas.getContext('webgpu');
  if (!ctx) return null;
  const format = navigator.gpu.getPreferredCanvasFormat();
  ctx.configure({ device, format, alphaMode: 'premultiplied' });

  const module = device.createShaderModule({ code: WGSL, label: 'view3d' });
  const bgl = device.createBindGroupLayout({ entries: [
    { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
    { binding: 1, visibility: GPUShaderStage.VERTEX, texture: { sampleType: 'unfilterable-float' } },
    { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
  ] });
  const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl] });
  const depth = { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' };
  const ms = { count: SAMPLES };
  const terrain = device.createRenderPipeline({ label: 'terrain', layout, vertex: { module, entryPoint: 'tvs' }, fragment: { module, entryPoint: 'tfs', targets: [{ format }] }, primitive: { cullMode: 'none' }, depthStencil: depth, multisample: ms });
  const animals = device.createRenderPipeline({
    label: 'animals', layout,
    vertex: { module, entryPoint: 'avs', buffers: [{ arrayStride: 16, stepMode: 'instance', attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'uint32' }] }] },
    fragment: { module, entryPoint: 'afs', targets: [{ format }] }, primitive: { cullMode: 'none' }, depthStencil: depth, multisample: ms,
  });
  const wedge = device.createRenderPipeline({
    label: 'wedge', layout, vertex: { module, entryPoint: 'wvs' },
    fragment: { module, entryPoint: 'wfs', targets: [{ format, blend: { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } } }] },
    primitive: { cullMode: 'none' }, depthStencil: { ...depth, depthWriteEnabled: false, depthBias: -2, depthBiasSlopeScale: -2 }, multisample: ms,
  });
  const ubuf = device.createBuffer({ size: 128, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: 'view3d uniforms' });
  const uf = new Float32Array(32);

  const V = { n: 0, vscale: 8, cellRun: 1, H: null, heightTex: null, colTex: null, bind: null, inst: null, instCap: 0, nAnimals: 0, list: [], wedge: false };
  // the camera: it looks at `target` (in cells) from `dist` cells away, turned `yaw` round and raised `pitch` above the ground
  const cam = { tx: 200, tz: 200, yaw: 0, pitch: 0.85, dist: 520 };
  let dirty = true, color = null, depthTex = null, size = [0, 0], active = true, frameId = 0, eye = [0, 0, 0], vp = new Float32Array(16);

  function heightAt(x, z) {   // (for keeping the camera above the ground, and for finding what a click is on)
    if (!V.H) return 0;
    const n = V.n, c = Math.min(n - 1, Math.max(0, Math.floor(x))), r = Math.min(n - 1, Math.max(0, Math.floor(z)));
    return V.H[r * n + c] * V.vscale;
  }

  function resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(16, Math.min(2048, Math.round(canvas.clientWidth * dpr))), h = Math.max(16, Math.min(2048, Math.round(canvas.clientHeight * dpr)));
    if (w === size[0] && h === size[1]) return;
    size = [w, h]; canvas.width = w; canvas.height = h;
    color?.destroy(); depthTex?.destroy();
    color = device.createTexture({ size: [w, h], format, sampleCount: SAMPLES, usage: GPUTextureUsage.RENDER_ATTACHMENT });
    depthTex = device.createTexture({ size: [w, h], format: 'depth24plus', sampleCount: SAMPLES, usage: GPUTextureUsage.RENDER_ATTACHMENT });
    dirty = true;
  }

  function camera() {
    const cp = Math.cos(cam.pitch);
    eye = [cam.tx + cam.dist * Math.sin(cam.yaw) * cp, cam.dist * Math.sin(cam.pitch), cam.tz + cam.dist * Math.cos(cam.yaw) * cp];
    const target = [cam.tx, heightAt(cam.tx, cam.tz), cam.tz];
    eye[1] = Math.max(eye[1] + target[1], heightAt(eye[0], eye[2]) + 3);   // (never under the ground)
    const aspect = size[0] / size[1];
    vp = mul(perspective(FOV, aspect, Math.max(0.5, cam.dist / 200), cam.dist * 6 + 800), lookAt(eye, target));
  }

  function draw() {
    frameId = 0;
    if (!active || !V.n || !V.bind) return;
    resize();
    camera();
    uf.set(vp, 0);
    uf[16] = eye[0]; uf[17] = eye[1]; uf[18] = eye[2]; uf[19] = size[1] / (2 * Math.tan(FOV / 2));
    uf[20] = V.n; uf[21] = V.vscale;
    if (V.wedge) uf.set(V.wedge, 24);
    device.queue.writeBuffer(ubuf, 0, uf);
    const enc = device.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: color.createView(), resolveTarget: ctx.getCurrentTexture().createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'discard' }],
      depthStencilAttachment: { view: depthTex.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'discard' },
    });
    pass.setBindGroup(0, V.bind);
    pass.setPipeline(terrain); pass.draw((V.n - 1) * (V.n - 1) * 6);
    if (V.nAnimals) { pass.setPipeline(animals); pass.setVertexBuffer(0, V.inst); pass.draw(12, V.nAnimals); }
    if (V.wedge) { pass.setPipeline(wedge); pass.draw(WEDGE.rings * WEDGE.segs * 6); }
    pass.end();
    device.queue.submit([enc.finish()]);
    dirty = false;
  }
  const want = () => { dirty = true; if (!frameId && active) frameId = requestAnimationFrame(draw); };

  /** A new world: its ground (the height of every cell, or of its lake's surface) goes up once. */
  function setWorld(world) {
    const L = world.land, n = world.n;
    V.n = n; V.cellRun = L.cellRun || 1; V.H = L.skyH ?? L.elev;
    V.heightTex?.destroy(); V.colTex?.destroy();
    V.heightTex = device.createTexture({ size: [n, n], format: 'r32float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    V.colTex = device.createTexture({ size: [n, n], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    device.queue.writeTexture({ texture: V.heightTex }, Float32Array.from(V.H), { bytesPerRow: n * 4 }, [n, n]);
    V.bind = device.createBindGroup({ layout: bgl, entries: [{ binding: 0, resource: { buffer: ubuf } }, { binding: 1, resource: V.heightTex.createView() }, { binding: 2, resource: V.colTex.createView() }] });
    setExaggeration(V.exaggeration ?? 8);
    cam.tx = cam.tz = n / 2;
    want();
  }
  /** How many times taller than true the land is drawn (the real land is very flat beside its width). */
  function setExaggeration(e) { V.exaggeration = e; V.vscale = e / V.cellRun; want(); }
  /** The ground's colours (RGBA bytes, one per cell), as the flat map paints them. */
  function setColours(rgba) { if (V.colTex) device.queue.writeTexture({ texture: V.colTex }, rgba, { bytesPerRow: V.n * 4 }, [V.n, V.n]); want(); }

  /** The animals, and the field of view of the one being watched (`fov`: { x, z, mid, half, radius } in cells and radians, or null). */
  function setAnimals(list, colourOf, selected, fov) {
    const k = list.length + 1;
    if (k > V.instCap) {
      V.inst?.destroy(); V.instCap = Math.max(1024, 2 ** Math.ceil(Math.log2(k)));
      V.inst = device.createBuffer({ size: V.instCap * 16, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST, label: 'animals' });
      V.f32 = new Float32Array(V.instCap * 4); V.u32 = new Uint32Array(V.f32.buffer);
    }
    const f = V.f32, u = V.u32;
    let p = 0;
    for (const o of list) {
      const c = colourOf(o);
      f[p] = o.c + 0.5; f[p + 1] = o.r + 0.5; f[p + 2] = o.h + (o === selected ? 8 : 0);
      u[p + 3] = (Math.round(c[0]) | (Math.round(c[1]) << 8) | (Math.round(c[2]) << 16)) >>> 0;
      p += 4;
    }
    V.nAnimals = list.length;
    V.list = list;
    device.queue.writeBuffer(V.inst, 0, f.buffer, 0, p * 4);
    V.wedge = fov ? [fov.x, fov.z, fov.mid, fov.half, fov.radius, 0, 0, 0] : false;
    want();
  }

  /** The animal drawn nearest to a point on the picture (in client pixels), if it is within a few pixels of one. */
  function pickAnimal(cx, cy) {
    const box = canvas.getBoundingClientRect();
    let best = null, bd = 10;
    for (const o of V.list) {
      const x = o.c + 0.5, z = o.r + 0.5, y = heightAt(x, z) + 0.3;
      const w = vp[3] * x + vp[7] * y + vp[11] * z + vp[15];
      if (w <= 0) continue;
      const px = ((vp[0] * x + vp[4] * y + vp[8] * z + vp[12]) / w * 0.5 + 0.5) * box.width + box.left;
      const py = (0.5 - (vp[1] * x + vp[5] * y + vp[9] * z + vp[13]) / w * 0.5) * box.height + box.top;
      const d = Math.hypot(px - cx, py - cy);
      if (d < bd) { bd = d; best = o; }
    }
    return best;
  }

  /* -------------------------------------------------------------- dragging */
  const ptrs = new Map();
  let moved = 0, gesture = null;
  const clampCam = () => {
    cam.pitch = Math.min(1.5, Math.max(0.12, cam.pitch)); cam.dist = Math.min(1400, Math.max(12, cam.dist));
    cam.tx = Math.min(V.n, Math.max(0, cam.tx)); cam.tz = Math.min(V.n, Math.max(0, cam.tz));
  };
  const pan = (dx, dy) => {   // slide the ground under the pointer
    const k = (cam.dist * 2 * Math.tan(FOV / 2)) / size[1] * (size[1] / canvas.clientHeight);
    const right = [Math.cos(cam.yaw), -Math.sin(cam.yaw)], fwd = [-Math.sin(cam.yaw), -Math.cos(cam.yaw)];
    cam.tx -= (dx * right[0] - dy * fwd[0] / Math.max(0.3, Math.sin(cam.pitch))) * k;
    cam.tz -= (dx * right[1] - dy * fwd[1] / Math.max(0.3, Math.sin(cam.pitch))) * k;
  };
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId); canvas.focus({ preventScroll: true });
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.size === 1) { moved = 0; gesture = e.button === 2 || e.button === 1 || e.shiftKey ? 'pan' : 'orbit'; }
    else gesture = 'pinch';
  });
  canvas.addEventListener('pointermove', (e) => {
    const p = ptrs.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    if (ptrs.size === 1) {
      moved += Math.abs(dx) + Math.abs(dy);
      if (gesture === 'orbit') { cam.yaw -= dx * 0.006; cam.pitch += dy * 0.005; } else pan(dx, dy);
    } else if (ptrs.size === 2) {
      const other = [...ptrs.entries()].find(([id]) => id !== e.pointerId)[1];
      const before = Math.hypot(p.x - other.x, p.y - other.y), after = Math.hypot(e.clientX - other.x, e.clientY - other.y);
      if (before > 0 && after > 0) cam.dist *= before / after;
      pan(dx / 2, dy / 2); moved += 10;
    }
    p.x = e.clientX; p.y = e.clientY;
    clampCam(); want();
  });
  const up = (e) => {
    if (!ptrs.has(e.pointerId)) return;
    ptrs.delete(e.pointerId);
    if (e.type === 'pointerup' && !ptrs.size && moved < 5) onPick?.(pickAnimal(e.clientX, e.clientY));
  };
  canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('wheel', (e) => { e.preventDefault(); cam.dist *= Math.exp(Math.max(-100, Math.min(100, e.deltaY)) * 0.0015); clampCam(); want(); }, { passive: false });
  canvas.addEventListener('dblclick', () => { reset(); });
  canvas.addEventListener('keydown', (e) => {
    const k = e.key;
    if (k === 'ArrowLeft') cam.yaw += 0.1; else if (k === 'ArrowRight') cam.yaw -= 0.1;
    else if (k === 'ArrowUp') cam.pitch += 0.06; else if (k === 'ArrowDown') cam.pitch -= 0.06;
    else if (k === '+' || k === '=') cam.dist *= 0.85; else if (k === '-') cam.dist /= 0.85;
    else return;
    e.preventDefault(); clampCam(); want();
  });
  function reset() { Object.assign(cam, { tx: V.n / 2, tz: V.n / 2, yaw: 0, pitch: 0.85, dist: 520 }); want(); }

  const ro = new ResizeObserver(() => want());
  ro.observe(canvas);

  return {
    setWorld, setColours, setAnimals, setExaggeration, reset, redraw: want,
    /** Draw only while the view is showing. */
    setActive(on) { active = on; if (on) want(); },
    dispose() { ro.disconnect(); cancelAnimationFrame(frameId); V.heightTex?.destroy(); V.colTex?.destroy(); V.inst?.destroy(); color?.destroy(); depthTex?.destroy(); ubuf.destroy(); ctx.unconfigure(); },
  };
}
