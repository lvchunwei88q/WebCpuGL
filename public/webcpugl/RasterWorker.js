// One raster worker. Owns a set of horizontal bands of the framebuffer and
// rasterizes only those rows, using the very same RasterCore the main thread
// uses, so a band and a full frame agree bit for bit.
//
// Protocol (main -> worker):
//   { type:'init',    W, H, bands:[{index,y0,y1}] }
//   { type:'sync',    slabs:[{index,y0,y1,color,depth}] }     seed from the main framebuffer
//   { type:'frame',   frameId, textures:[{id,w,h,data}], draws:[...] }
//   { type:'dispose' }
// Worker -> main:
//   { type:'ready' }   { type:'framedone', frameId, bands:[{index,y0,color,depth}], stats }
//   { type:'fatal', error }

import { Texture } from './resources.js';
import * as core from './RasterCore.js';

const MAX_TEXTURES = 64;

const W = { w: 0, h: 0 };
let bands = [];                     // { index, y0, y1, rows, color, depth }
const textures = new Map();         // id -> Texture
const shaders = new Map();          // url -> fs

const port = (typeof self !== 'undefined') ? self : globalThis;
const queue = [];
let running = false;

port.onmessage = (e) => {
  queue.push(e.data);
  if (!running) pump();
};

async function pump() {
  running = true;
  try {
    while (queue.length > 0) {
      const msg = queue.shift();
      try {
        await handle(msg);
      } catch (err) {
        port.postMessage({ type: 'fatal', error: String((err && err.stack) || err) });
      }
    }
  } finally {
    running = false;
  }
}

async function handle(msg) {
  switch (msg.type) {
    case 'init': init(msg); port.postMessage({ type: 'ready' }); break;
    case 'sync': syncSlabs(msg); break;
    case 'frame': await renderFrame(msg); break;
    case 'dispose': if (typeof port.close === 'function') port.close(); break;
    default: break;
  }
}

function init(msg) {
  W.w = msg.W;
  W.h = msg.H;
  bands = msg.bands.map((b) => {
    const rows = b.y1 - b.y0 + 1;
    return {
      index: b.index,
      y0: b.y0,
      y1: b.y1,
      rows,
      color: new Uint8ClampedArray(rows * W.w * 4),
      depth: new Float32Array(rows * W.w),
    };
  });
  for (const b of bands) b.depth.fill(1);
}

function syncSlabs(msg) {
  for (const s of msg.slabs) {
    const b = findBand(s.index);
    if (!b) continue;
    b.color.set(s.color);
    b.depth.set(s.depth);
  }
}

function findBand(index) {
  for (let i = 0; i < bands.length; i++) if (bands[i].index === index) return bands[i];
  return null;
}

async function loadShaderFs(url) {
  let fs = shaders.get(url);
  if (fs) return fs;
  const mod = await import(url);
  if (typeof mod.fs !== 'function') {
    throw new Error('shader module has no fs(): ' + url);
  }
  fs = mod.fs;
  shaders.set(url, fs);
  return fs;
}

function ingestTextures(list) {
  if (!list) return;
  for (const t of list) {
    if (!t || textures.has(t.id)) continue;
    if (textures.size >= MAX_TEXTURES) continue;
    textures.set(t.id, new Texture(t.w, t.h, t.data));
  }
}

async function renderFrame(msg) {
  const stats = { culled: 0, triangles: 0, pixels: 0 };
  ingestTextures(msg.textures);

  for (const cmd of msg.draws) {
    if (cmd.type === 'clearColor') {
      for (const b of bands) core.clearColorBuffer(b.color, cmd.rgba, W.w, b.rows, 0);
      continue;
    }
    if (cmd.type === 'clearDepth') {
      for (const b of bands) b.depth.fill(cmd.depth);
      continue;
    }
    if (cmd.type !== 'draw') continue;

    const fs = await loadShaderFs(cmd.shaderUrl);
    const plan = core.planFromDescriptor(cmd.planDesc);

    const psU = cmd.uniforms || {};
    const psS = {};
    for (const tb of cmd.textures || []) {
      psS['t' + tb.slot] = textures.get(tb.id) || null;
    }

    const perVert = cmd.perVert;
    const perTri = cmd.perTri;

    for (const b of bands) {
      const packed = cmd.perBand[b.index];
      if (!packed) continue;
      const triCount = cmd.bandTriCount[b.index] | 0;

      const ctx = {
        W: W.w,
        H: W.h,
        color: b.color,
        depth: b.depth,
        y0: b.y0,
        y1: b.y1,
        cullMode: cmd.cull,
        depthOn: cmd.depth.depthEnable,
        depthWrite: cmd.depth.depthWriteEnable,
        depthFunc: cmd.depth.depthFunc,
        blended: cmd.blend,
        psFn: fs,
        psU,
        psS,
        stats,
      };

      for (let t = 0; t < triCount; t++) {
        const base = t * perTri;
        const a0 = base, a1 = base + perVert, a2 = base + 2 * perVert;
        // the packed triangle interleaves [x,y,z,w,varying...] per vertex, so the
        // clip-space and varying views are the same buffer at offset+4
        core.rasterTriangle(ctx, packed, a0, a1, a2, packed, a0 + 4, a1 + 4, a2 + 4, plan);
      }
    }
  }

  const out = bands.map((b) => ({ index: b.index, y0: b.y0, color: b.color, depth: b.depth }));
  port.postMessage({ type: 'framedone', frameId: msg.frameId, bands: out, stats });
}
