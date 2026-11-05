// Shared rasterizer core. One implementation serves both the single-thread path
// (DeviceContext drawing the whole frame) and the band-parallel path
// (RasterWorker drawing one horizontal strip). Keeping a single copy of the
// interpolation/clipping math is what guarantees the parallel output is bit-identical
// to the single-thread output.
//
// A "band" is just the inclusive row window [ctx.y0, ctx.y1] of the surface. When
// the full frame is drawn inline the window is [0, H-1], so both paths run the
// exact same code; a band slab is indexed relative to y0.
//
// ctx = {
//   W, H,                surface size in pixels
//   color, depth,        typed buffers (band slabs for a worker, full frame inline)
//   y0, y1,              inclusive row window
//   cullMode,            'NONE' | 'BACK' | 'FRONT'
//   depthOn, depthWrite, depthFunc, blended,
//   psFn, psU, psS,      fragment stage
//   stats,               { culled, triangles, pixels } — mutated in place
// }

export const NEAR_W = 0.001;

// scratch for projecting one triangle's three vertices; single-threaded per
// module instance, and rasterTriangle never nests two projections
const S = new Float64Array(12);

/**
 * Project three clip-space vertices to screen space.
 * S = [sx0,sy0,sz0,inv0, sx1,sy1,sz1,inv1, sx2,sy2,sz2,inv2]
 */
function project3(cp, a0, a1, a2, W, H) {
  const w0 = cp[a0 + 3];
  const i0 = 1 / (w0 || 1e-8);
  S[0] = (cp[a0] * i0 + 1) * 0.5 * W;
  S[1] = (1 - cp[a0 + 1] * i0) * 0.5 * H;
  S[2] = cp[a0 + 2] * i0;
  S[3] = i0;

  const w1 = cp[a1 + 3];
  const i1 = 1 / (w1 || 1e-8);
  S[4] = (cp[a1] * i1 + 1) * 0.5 * W;
  S[5] = (1 - cp[a1 + 1] * i1) * 0.5 * H;
  S[6] = cp[a1 + 2] * i1;
  S[7] = i1;

  const w2 = cp[a2 + 3];
  const i2 = 1 / (w2 || 1e-8);
  S[8] = (cp[a2] * i2 + 1) * 0.5 * W;
  S[9] = (1 - cp[a2 + 1] * i2) * 0.5 * H;
  S[10] = cp[a2 + 2] * i2;
  S[11] = i2;
}

/**
 * Screen-space bounds of one triangle, clipped to the surface.
 * Writes [area, minX, maxX, minY, maxY] into `out` and returns false for a
 * degenerate triangle. `out[0] < 0` means back-facing in this y-down space.
 * No allocation: this runs once per triangle when splitting work into bands.
 */
export function triBounds(cp, a0, a1, a2, W, H, out) {
  project3(cp, a0, a1, a2, W, H);
  const area = (S[4] - S[0]) * (S[9] - S[1]) - (S[5] - S[1]) * (S[8] - S[0]);
  out[0] = area;
  if (Math.abs(area) < 1e-12) return false;
  out[1] = Math.max(0, Math.floor(Math.min(S[0], S[4], S[8])));
  out[2] = Math.min(W - 1, Math.ceil(Math.max(S[0], S[4], S[8])));
  out[3] = Math.max(0, Math.floor(Math.min(S[1], S[5], S[9])));
  out[4] = Math.min(H - 1, Math.ceil(Math.max(S[1], S[5], S[9])));
  return true;
}

// ---------------------------------------------------------------- varying plan

/**
 * Describe the varying shape of a vs() output once per draw call: which keys are
 * vectors, how wide, and at which offset inside the flat row they live. The fs()
 * still receives an object, so shader code is unchanged.
 */
export function buildVaryingPlan(vsOut) {
  const vecKeys = [], vecDim = [], vecOff = [];
  const sclKeys = [], sclOff = [];
  const vecTargets = [];
  const varyOut = {};
  let off = 0;
  for (const k in vsOut) {
    if (k === 'position') continue;
    const a = vsOut[k];
    if (typeof a === 'number') {
      sclKeys.push(k); sclOff.push(off); off += 1;
      varyOut[k] = 0;
    } else {
      vecKeys.push(k); vecDim.push(a.length); vecOff.push(off); off += a.length;
      const target = new Array(a.length).fill(0); // packed, not holey
      vecTargets.push(target);
      varyOut[k] = target;
    }
  }
  return {
    stride: off > 0 ? off : 1,
    vecCount: vecKeys.length,
    vecKeys, vecDim, vecOff, vecTargets,
    sclCount: sclKeys.length,
    sclKeys, sclOff,
    varyOut,
  };
}

/** Serializable form of a plan (what a worker needs to rebuild it). */
export function planDescriptor(plan) {
  return {
    stride: plan.stride,
    vecKeys: plan.vecKeys, vecDim: plan.vecDim, vecOff: plan.vecOff,
    sclKeys: plan.sclKeys, sclOff: plan.sclOff,
  };
}

/** Rebuild a working plan (with its own slot arrays) from a descriptor. */
export function planFromDescriptor(d) {
  const vecCount = d.vecKeys.length;
  const vecTargets = [];
  const varyOut = {};
  for (let s = 0; s < vecCount; s++) {
    const target = new Array(d.vecDim[s]).fill(0);
    vecTargets.push(target);
    varyOut[d.vecKeys[s]] = target;
  }
  for (let s = 0; s < d.sclKeys.length; s++) varyOut[d.sclKeys[s]] = 0;
  return {
    stride: d.stride,
    vecCount,
    vecKeys: d.vecKeys, vecDim: d.vecDim, vecOff: d.vecOff,
    vecTargets,
    sclCount: d.sclKeys.length,
    sclKeys: d.sclKeys, sclOff: d.sclOff,
    varyOut,
  };
}

/**
 * Write one vs() output into an interleaved vertex buffer.
 * Layout per vertex, `perVert = 4 + stride` doubles:
 *   [x, y, z, w, varying0 .. varying(stride-1)]
 * Keeping clip space and varyings in one row means a triangle is one contiguous
 * run of doubles, so handing it to another thread is a single copy.
 */
export function writeVertex(buf, perVert, i, out, plan) {
  const p = out.position;
  const pb = i * perVert;
  buf[pb] = p[0];
  buf[pb + 1] = p[1];
  buf[pb + 2] = p[2];
  buf[pb + 3] = p[3];

  const vb = pb + 4;
  for (let s = 0; s < plan.vecCount; s++) {
    const arr = out[plan.vecKeys[s]];
    const o = vb + plan.vecOff[s];
    const dim = plan.vecDim[s];
    if (arr === undefined) {
      for (let j = 0; j < dim; j++) buf[o + j] = NaN;
    } else {
      for (let j = 0; j < dim; j++) buf[o + j] = arr[j];
    }
  }
  for (let s = 0; s < plan.sclCount; s++) {
    const v = out[plan.sclKeys[s]];
    buf[vb + plan.sclOff[s]] = typeof v === 'number' ? v : NaN;
  }
}

// ---------------------------------------------------------------- rasterizing

/** Near-plane clip, then one or two projected triangles. */
export function rasterTriangle(ctx, cp, a0, a1, a2, cv, b0, b1, b2, plan) {
  const in0 = cp[a0 + 3] > NEAR_W;
  const in1 = cp[a1 + 3] > NEAR_W;
  const in2 = cp[a2 + 3] > NEAR_W;
  if (in0 && in1 && in2) {
    rasterProjected(ctx, cp, a0, a1, a2, cv, b0, b1, b2, plan);
    return;
  }
  if (!in0 && !in1 && !in2) return;

  // Sutherland-Hodgman against w = NEAR, walking edges (2->0), (0->1), (1->2)
  const stride = plan.stride;
  const pp = new Float64Array(16);
  const pv = new Float64Array(stride * 4);
  const O = [a2, a0, a1];
  const B = [b2, b0, b1];
  const IN = [in2, in0, in1];
  let n = 0;

  for (let e = 0; e < 3; e++) {
    const pi = (e + 2) % 3;
    const curIn = IN[e], prevIn = IN[pi];
    const curO = O[e], prevO = O[pi];
    const curB = B[e], prevB = B[pi];

    if (curIn) {
      if (!prevIn) {
        const t = (NEAR_W - cp[prevO + 3]) / (cp[curO + 3] - cp[prevO + 3]);
        emitClipped(pp, pv, n, cp, prevO, curO, cv, prevB, curB, t, stride);
        n++;
      }
      copyClipped(pp, pv, n, cp, curO, cv, curB, stride);
      n++;
    } else if (prevIn) {
      const t = (NEAR_W - cp[prevO + 3]) / (cp[curO + 3] - cp[prevO + 3]);
      emitClipped(pp, pv, n, cp, prevO, curO, cv, prevB, curB, t, stride);
      n++;
    }
  }

  for (let i = 1; i + 1 < n; i++) {
    rasterProjected(
      ctx, pp, 0, i * 4, (i + 1) * 4,
      pv, 0, i * stride, (i + 1) * stride,
      plan,
    );
  }
}

/** Copy a clipped-polygon vertex into slot `n`. */
function copyClipped(pp, pv, n, cp, o, cv, b, stride) {
  const po = n * 4;
  pp[po] = cp[o]; pp[po + 1] = cp[o + 1];
  pp[po + 2] = cp[o + 2]; pp[po + 3] = cp[o + 3];
  const vo = n * stride;
  for (let j = 0; j < stride; j++) pv[vo + j] = cv[b + j];
}

/** Interpolate an edge crossing into slot `n`. */
function emitClipped(pp, pv, n, cp, oa, ob, cv, ba, bb, t, stride) {
  const po = n * 4;
  pp[po] = cp[oa] + (cp[ob] - cp[oa]) * t;
  pp[po + 1] = cp[oa + 1] + (cp[ob + 1] - cp[oa + 1]) * t;
  pp[po + 2] = cp[oa + 2] + (cp[ob + 2] - cp[oa + 2]) * t;
  pp[po + 3] = cp[oa + 3] + (cp[ob + 3] - cp[oa + 3]) * t;
  const vo = n * stride;
  for (let j = 0; j < stride; j++) {
    pv[vo + j] = cv[ba + j] + (cv[bb + j] - cv[ba + j]) * t;
  }
}

/**
 * Rasterize one fully-inside triangle. `cp` holds clip-space xyzw, `cv` holds
 * varying rows; `a0..a2` / `b0..b2` are the row offsets of its three vertices
 * (they may point into the same interleaved buffer).
 */
export function rasterProjected(ctx, cp, a0, a1, a2, cv, b0, b1, b2, plan) {
  const W = ctx.W, H = ctx.H;
  project3(cp, a0, a1, a2, W, H);

  const sx0 = S[0], sy0 = S[1], sz0 = S[2], inv0 = S[3];
  const sx1 = S[4], sy1 = S[5], sz1 = S[6], inv1 = S[7];
  const sx2 = S[8], sy2 = S[9], sz2 = S[10], inv2 = S[11];

  // 2D signed area (y-down). DX11 default: CW = front.
  const area = (sx1 - sx0) * (sy2 - sy0) - (sy1 - sy0) * (sx2 - sx0);

  if (ctx.cullMode !== 'NONE') {
    const isBack = area < 0;
    if ((ctx.cullMode === 'BACK' && isBack) ||
        (ctx.cullMode === 'FRONT' && !isBack)) {
      ctx.stats.culled++;
      return;
    }
  }
  if (Math.abs(area) < 1e-12) return;
  ctx.stats.triangles++;

  const minX = Math.max(0, Math.floor(Math.min(sx0, sx1, sx2)));
  const maxX = Math.min(W - 1, Math.ceil(Math.max(sx0, sx1, sx2)));
  const minY = Math.max(ctx.y0, Math.floor(Math.min(sy0, sy1, sy2)));
  const maxY = Math.min(ctx.y1, Math.ceil(Math.max(sy0, sy1, sy2)));
  if (minY > maxY || minX > maxX) return;

  // ---- hoist state and varying plan out of the pixel loop ----
  const depthOn = ctx.depthOn;
  const depthWrite = ctx.depthWrite;
  const depthFunc = ctx.depthFunc;
  const depth = ctx.depth;
  const color = ctx.color;
  const rowBase = ctx.y0;
  const psFn = ctx.psFn;
  const psU = ctx.psU;
  const psS = ctx.psS;
  const blended = ctx.blended;
  const stats = ctx.stats;

  const nVec = plan.vecCount;
  const vOff = plan.vecOff;
  const vDim = plan.vecDim;
  const vTgt = plan.vecTargets;
  const nScl = plan.sclCount;
  const sOff = plan.sclOff;
  const sKeys = plan.sclKeys;
  const varyOut = plan.varyOut;

  // ---- per-row scan bounds -------------------------------------------------
  // Each barycentric numerator is affine in screen space:
  //   l_k(px, py) = A_k*px + (py*Sx_k + C_k)
  // and the inside test sign(l_k) == sign(area) turns each of the three edges
  // into a half-plane in px. Intersecting them gives the x range a row can
  // possibly cover, so the bbox scan no longer walks the empty corners.
  // This only trims cells: the per-pixel test below stays authoritative and the
  // range is widened by one cell on each side, so output is bit-identical.
  const A0 = sy1 - sy2, A1 = sy2 - sy0, A2 = sy0 - sy1;
  const Sx0 = sx2 - sx1, Sx1 = sx0 - sx2, Sx2 = sx1 - sx0;
  const C0 = sx1 * sy2 - sy1 * sx2;
  const C1 = sx2 * sy0 - sy2 * sx0;
  const C2 = sx0 * sy1 - sy0 * sx1;
  const posArea = area > 0;

  for (let y = minY; y <= maxY; y++) {
    const py = y + 0.5;

    let lo = -Infinity, hi = Infinity;
    const l0c = py * Sx0 + C0;
    if (A0 === 0) {                       // edge is horizontal: whole row inside or not at all
      if ((l0c >= 0) !== posArea) continue;
    } else {
      const t = -l0c / A0;
      if ((A0 > 0) === posArea) { if (t > lo) lo = t; } else if (t < hi) hi = t;
    }
    const l1c = py * Sx1 + C1;
    if (A1 === 0) {
      if ((l1c >= 0) !== posArea) continue;
    } else {
      const t = -l1c / A1;
      if ((A1 > 0) === posArea) { if (t > lo) lo = t; } else if (t < hi) hi = t;
    }
    const l2c = py * Sx2 + C2;
    if (A2 === 0) {
      if ((l2c >= 0) !== posArea) continue;
    } else {
      const t = -l2c / A2;
      if ((A2 > 0) === posArea) { if (t > lo) lo = t; } else if (t < hi) hi = t;
    }

    // `!(x >= a)` also catches NaN and -Infinity, which clamp back to the bbox
    let xa = Math.ceil(lo - 0.5) - 1;     // one cell of slack on each side
    if (!(xa >= minX)) xa = minX;
    let xb = Math.floor(hi - 0.5) + 1;
    if (!(xb <= maxX)) xb = maxX;
    if (xa > xb) continue;

    for (let x = xa; x <= xb; x++) {
      const px = x + 0.5;

      const w0 = ((sx1 - px) * (sy2 - py) - (sy1 - py) * (sx2 - px)) / area;
      const w1 = ((sx2 - px) * (sy0 - py) - (sy2 - py) * (sx0 - px)) / area;
      const w2 = 1 - w0 - w1;
      if (w0 < 0 || w1 < 0 || w2 < 0) continue;

      const di = (y - rowBase) * W + x;
      const z = w0 * sz0 + w1 * sz1 + w2 * sz2;

      if (depthOn) {
        if (depthFunc === 'LESS_EQUAL' && z > depth[di]) continue;
        else if (depthFunc === 'LESS' && z >= depth[di]) continue;
        else if (depthFunc === 'GREATER' && z < depth[di]) continue;
      }

      const invW = w0 * inv0 + w1 * inv1 + w2 * inv2;
      const inv = 1 / invW;

      for (let s = 0; s < nVec; s++) {
        const off = vOff[s];
        const dim = vDim[s];
        const t = vTgt[s];
        const i0 = b0 + off, i1 = b1 + off, i2 = b2 + off;
        for (let j = 0; j < dim; j++) {
          t[j] = (w0 * cv[i0 + j] * inv0 +
                  w1 * cv[i1 + j] * inv1 +
                  w2 * cv[i2 + j] * inv2) * inv;
        }
      }
      for (let s = 0; s < nScl; s++) {
        const o = sOff[s];
        varyOut[sKeys[s]] = (w0 * cv[b0 + o] * inv0 +
                             w1 * cv[b1 + o] * inv1 +
                             w2 * cv[b2 + o] * inv2) * inv;
      }

      const out = psFn(varyOut, psU, psS);
      if (!out || out.length < 3) continue;
      const r = out[0], g = out[1], bch = out[2], a = out.length > 3 ? out[3] : 1;

      if (depthOn && depthWrite) depth[di] = z;
      stats.pixels++;

      const o = di * 4;
      if (blended) {
        color[o]   = r * 255 * a + color[o]   * (1 - a);
        color[o+1] = g * 255 * a + color[o+1] * (1 - a);
        color[o+2] = bch*255 * a + color[o+2] * (1 - a);
        color[o+3] = 255;
      } else {
        color[o]   = r * 255;
        color[o+1] = g * 255;
        color[o+2] = bch * 255;
        color[o+3] = 255;
      }
    }
  }
}

/** Fill a color slab (or full buffer) with a [r,g,b,a] 0..1 clear color. */
export function clearColorBuffer(color, rgba, W, rows, rowBase) {
  const [r, g, b, a = 1] = rgba;
  const R = Math.round(r * 255), G = Math.round(g * 255),
        B = Math.round(b * 255), A = Math.round(a * 255);
  const n = W * rows;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    color[o] = R; color[o + 1] = G; color[o + 2] = B; color[o + 3] = A;
  }
}
