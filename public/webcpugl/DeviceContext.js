// DX11-style immediate-mode device context. Holds all pipeline state and
// runs the software rasterizer on the JS main thread.
//
// Varyings are carried as flat Float64Array slices (one row per vertex, `stride`
// doubles wide) instead of per-vertex objects. Per-pixel interpolation therefore
// reads through numeric offsets and writes into preallocated slot arrays, with no
// string-keyed lookups and no per-pixel allocation. Fragment shaders still receive
// an object (`input.vUV`, `input.vNormal`, ...), so .sd files are unchanged.

import { Framebuffer } from './Framebuffer.js';
import { Buffer, Shader, Texture } from './resources.js';

const FORMAT_SIZE = { FLOAT1: 4, FLOAT2: 8, FLOAT3: 12, FLOAT4: 16 };
const NEAR_W = 0.001;

export class DeviceContext {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {number} [width=256]
   * @param {number} [height=256]
   */
  constructor(canvas, width = 256, height = 256) {
    this.canvas = canvas;
    this.canvas.width = width;
    this.canvas.height = height;
    this.ctx2d = canvas.getContext('2d', { alpha: false });

    this.fb = new Framebuffer(width, height);

    // ---- IA stage ----
    this.inputLayout = [];
    this.vertexBuffers = []; // [{buffer, stride, offset}]
    this.indexBuffer = null; // Buffer (Uint16Array / Uint32Array)
    this.indexFormat = 'UINT16';

    // ---- Shader stage ----
    this.vs = null;
    this.ps = null;

    // ---- RS stage ----
    this.rsState = { cullMode: 'BACK' }; // NONE | BACK | FRONT

    // ---- OM stage ----
    this.depthState = { depthEnable: true, depthWriteEnable: true, depthFunc: 'LESS_EQUAL' };
    this.blendState = { enabled: false }; // srcAlpha / oneMinusSrcAlpha when on

    // ---- per-frame stats (reset on present) ----
    this.stats = {
      drawCalls: 0,
      triangles: 0,       // submitted to rasterizer (after cull)
      culled: 0,         // rejected by backface cull
      pixels: 0,         // fragments shaded & written
    };
    this._frameStart = 0;
  }

  // ============================================================
  // IA: Input Assembler
  // ============================================================

  /**
   * @param {Array<{semantic:string, offset:number, format:'FLOAT1'|'FLOAT2'|'FLOAT3'|'FLOAT4'}>} layout
   */
  IASetInputLayout(layout) { this.inputLayout = layout; }

  /**
   * @param {number} _slot  (reserved, only slot 0 used)
   * @param {Array<{buffer:Buffer, stride:number, offset?:number}>} views
   */
  IASetVertexBuffers(_slot, views) { this.vertexBuffers = views; }

  IASetIndexBuffer(buffer, format = 'UINT16') {
    this.indexBuffer = buffer;
    this.indexFormat = format;
  }

  // ============================================================
  // Shader stage
  // ============================================================
  VSSetShader(shader) { this.vs = shader; if (this._uniforms) shader.cbuffer = this._uniforms; }
  PSSetShader(shader) { this.ps = shader; if (this._uniforms) shader.cbuffer = this._uniforms; }

  /**
   * Bind a uniform object to both VS and PS.
   */
  VSSetConstantBuffer(_slot, uniformObject) {
    const u = uniformObject || {};
    this._uniforms = u;
    if (this.vs) this.vs.cbuffer = u;
    if (this.ps) this.ps.cbuffer = u;
  }
  PSSetConstantBuffer(_slot, uniformObject) {
    const u = uniformObject || {};
    this._uniforms = u;
    if (this.ps) this.ps.cbuffer = u;
    if (this.vs) this.vs.cbuffer = u;
  }

  /** @param {number} slot  @param {Texture|null} tex */
  PSSetShaderResource(slot, tex) {
    if (!this.ps) return;
    this.ps.samplers = this.ps.samplers || {};
    this.ps.samplers['t' + slot] = tex;
  }

  // ============================================================
  // RS / OM state
  // ============================================================
  RSSetState({ cullMode = 'BACK' } = {}) { this.rsState.cullMode = cullMode; }

  OMSetDepthStencilState({
    depthEnable = true,
    depthWriteEnable = true,
    depthFunc = 'LESS_EQUAL',
  } = {}) {
    this.depthState = { depthEnable, depthWriteEnable, depthFunc };
  }

  OMSetBlendState({ enabled = false } = {}) {
    this.blendState.enabled = enabled;
  }

  // ============================================================
  // Clear
  // ============================================================
  ClearRenderTarget(color /* [r,g,b,a] 0..1 */) { this.fb.clearColor(color); }
  ClearDepthStencil(d = 1.0) { this.fb.clearDepth(d); }

  // ============================================================
  // Draw
  // ============================================================

  /** Non-indexed draw. */
  Draw(vertexCount, startVertexLocation = 0) {
    this.stats.drawCalls++;
    this._runDraw(vertexCount, null, startVertexLocation, 0);
  }

  /** Indexed draw. */
  DrawIndexed(indexCount, startIndexLocation = 0, baseVertexLocation = 0) {
    this.stats.drawCalls++;
    if (!this.indexBuffer) throw new Error('DrawIndexed: no index buffer bound.');
    this._runDraw(indexCount, this.indexBuffer.data, startIndexLocation, baseVertexLocation);
  }

  /** Push the internal framebuffer to the visible canvas. */
  present() {
    const now = performance.now();
    const dt = this._lastPresent ? (now - this._lastPresent) : 16.6;
    this._lastPresent = now;
    this.stats.frameMs = dt;
    this.stats.fps = 1000 / dt;

    this.fb.imageData.data.set(this.fb.color);
    this.ctx2d.putImageData(this.fb.imageData, 0, 0);

    // snapshot for HUD (read after present)
    this.lastFrame = { ...this.stats };

    // reset per-frame counters
    this.stats.drawCalls = 0;
    this.stats.triangles = 0;
    this.stats.culled = 0;
    this.stats.pixels = 0;
  }

  // ============================================================
  // internals
  // ============================================================

  _fetchVertex(vertexIndex) {
    const slot = this.vertexBuffers[0];
    if (!slot) throw new Error('Draw: no vertex buffer bound.');
    const buf = slot.buffer.data;             // assumed Float32Array
    const strideF = slot.stride / 4;          // bytes -> float index
    const base = vertexIndex * strideF + (slot.offset || 0) / 4;
    const out = {};
    for (const attr of this.inputLayout) {
      const fi = base + attr.offset / 4;
      switch (attr.format) {
        case 'FLOAT1': out[attr.semantic] = [buf[fi]]; break;
        case 'FLOAT2': out[attr.semantic] = [buf[fi], buf[fi+1]]; break;
        case 'FLOAT3': out[attr.semantic] = [buf[fi], buf[fi+1], buf[fi+2]]; break;
        case 'FLOAT4': out[attr.semantic] = [buf[fi], buf[fi+1], buf[fi+2], buf[fi+3]]; break;
      }
    }
    if (out.position && out.position.length === 3) out.position.push(1.0);
    return out;
  }

  /**
   * Describe the varying shape of a vs() output once per draw call.
   * Every vector output is stored at a fixed offset inside the flat row,
   * so interpolation never has to look a key up again.
   */
  _buildVaryingPlan(vsOut) {
    const vecKeys = [], vecDim = [], vecOff = [];
    const sclKeys = [], sclOff = [];
    const vecTargets = [];
    const varyOut = {};              // what fs() receives, reused per triangle
    let off = 0;
    for (const k in vsOut) {
      if (k === 'position') continue;
      const a = vsOut[k];
      if (typeof a === 'number') {
        sclKeys.push(k); sclOff.push(off); off += 1;
        varyOut[k] = 0;
      } else {
        vecKeys.push(k); vecDim.push(a.length); vecOff.push(off); off += a.length;
        // packed (not holey) so writes stay fast inside the pixel loop
        const target = new Array(a.length).fill(0);
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

  /** Copy one vs() output into its position slot and varying row. */
  _writeVertex(pos, vf, i, out, plan) {
    const p = out.position;
    const pb = i * 4;
    pos[pb] = p[0];
    pos[pb + 1] = p[1];
    pos[pb + 2] = p[2];
    pos[pb + 3] = p[3];

    const vb = i * plan.stride;
    for (let s = 0; s < plan.vecCount; s++) {
      const arr = out[plan.vecKeys[s]];
      const o = vb + plan.vecOff[s];
      const dim = plan.vecDim[s];
      if (arr === undefined) {
        for (let j = 0; j < dim; j++) vf[o + j] = NaN;
      } else {
        for (let j = 0; j < dim; j++) vf[o + j] = arr[j];
      }
    }
    for (let s = 0; s < plan.sclCount; s++) {
      const v = out[plan.sclKeys[s]];
      vf[vb + plan.sclOff[s]] = typeof v === 'number' ? v : NaN;
    }
  }

  /** Runs the vertex shader over `count` vertices, then submits triangles. */
  _runDraw(count, idx, start, base) {
    if (count <= 0) return;
    const vs = this.vs;
    if (!vs) throw new Error('Draw: no vertex shader bound.');
    const cb = vs.cbuffer || {};

    // the first vertex also discovers the varying shape for this draw
    const i0 = idx ? base + idx[start] : start;
    const first = vs.fn(this._fetchVertex(i0), cb);
    const plan = this._buildVaryingPlan(first);

    const pos = new Float64Array(count * 4);
    const vf = new Float64Array(count * plan.stride);

    this._writeVertex(pos, vf, 0, first, plan);
    for (let i = 1; i < count; i++) {
      const vIdx = idx ? base + idx[start + i] : start + i;
      this._writeVertex(pos, vf, i, vs.fn(this._fetchVertex(vIdx), cb), plan);
    }

    for (let i = 0; i + 2 < count; i += 3) {
      const o0 = i * 4, o1 = (i + 1) * 4, o2 = (i + 2) * 4;
      const b0 = i * plan.stride, b1 = (i + 1) * plan.stride, b2 = (i + 2) * plan.stride;
      this._rasterTriangle(pos, o0, o1, o2, vf, b0, b1, b2, plan);
    }
  }

  _rasterTriangle(pos, o0, o1, o2, vf, b0, b1, b2, plan) {
    // near-plane clip in clip space (w > NEAR)
    const in0 = pos[o0 + 3] > NEAR_W;
    const in1 = pos[o1 + 3] > NEAR_W;
    const in2 = pos[o2 + 3] > NEAR_W;
    if (in0 && in1 && in2) {
      this._rasterProjected(pos, o0, o1, o2, vf, b0, b1, b2, plan);
      return;
    }
    if (!in0 && !in1 && !in2) return;

    // Sutherland-Hodgman against w = NEAR, walking edges (2->0), (0->1), (1->2)
    const stride = plan.stride;
    const pp = new Float64Array(16);
    const pv = new Float64Array(stride * 4);
    const O = [o2, o0, o1];
    const B = [b2, b0, b1];
    const IN = [in2, in0, in1];
    let n = 0;

    for (let e = 0; e < 3; e++) {
      const pvIdx = (e + 2) % 3;
      const curIn = IN[e], prevIn = IN[pvIdx];
      const curO = O[e], prevO = O[pvIdx];
      const curB = B[e], prevB = B[pvIdx];

      if (curIn) {
        if (!prevIn) {
          const t = (NEAR_W - pos[prevO + 3]) / (pos[curO + 3] - pos[prevO + 3]);
          this._emitClipped(pp, pv, n, pos, prevO, curO, vf, prevB, curB, t, stride);
          n++;
        }
        this._copyClipped(pp, pv, n, pos, curO, vf, curB, stride);
        n++;
      } else if (prevIn) {
        const t = (NEAR_W - pos[prevO + 3]) / (pos[curO + 3] - pos[prevO + 3]);
        this._emitClipped(pp, pv, n, pos, prevO, curO, vf, prevB, curB, t, stride);
        n++;
      }
    }

    for (let i = 1; i + 1 < n; i++) {
      this._rasterProjected(
        pp, 0, i * 4, (i + 1) * 4,
        pv, 0, i * stride, (i + 1) * stride,
        plan,
      );
    }
  }

  /** Copy a clipped-polygon vertex (clip space + varying row) at slot `n`. */
  _copyClipped(pp, pv, n, pos, o, vf, b, stride) {
    const po = n * 4;
    pp[po] = pos[o]; pp[po + 1] = pos[o + 1];
    pp[po + 2] = pos[o + 2]; pp[po + 3] = pos[o + 3];
    const vo = n * stride;
    for (let j = 0; j < stride; j++) pv[vo + j] = vf[b + j];
  }

  /** Interpolate an edge crossing into clip space + varying at slot `n`. */
  _emitClipped(pp, pv, n, pos, oa, ob, vf, ba, bb, t, stride) {
    const po = n * 4;
    pp[po] = pos[oa] + (pos[ob] - pos[oa]) * t;
    pp[po + 1] = pos[oa + 1] + (pos[ob + 1] - pos[oa + 1]) * t;
    pp[po + 2] = pos[oa + 2] + (pos[ob + 2] - pos[oa + 2]) * t;
    pp[po + 3] = pos[oa + 3] + (pos[ob + 3] - pos[oa + 3]) * t;
    const vo = n * stride;
    for (let j = 0; j < stride; j++) {
      pv[vo + j] = vf[ba + j] + (vf[bb + j] - vf[ba + j]) * t;
    }
  }

  /**
   * Rasterize one fully-inside triangle. `cp` holds clip-space xyzw, `cv` holds
   * varying rows; `a0..a2` / `b0..b2` are the row offsets of its three vertices.
   */
  _rasterProjected(cp, a0, a1, a2, cv, b0, b1, b2, plan) {
    const W = this.fb.width, H = this.fb.height;

    // w-divide + viewport transform
    const cw0 = cp[a0 + 3];
    const inv0 = 1 / (cw0 || 1e-8);
    const sx0 = (cp[a0] * inv0 + 1) * 0.5 * W;
    const sy0 = (1 - cp[a0 + 1] * inv0) * 0.5 * H;
    const sz0 = cp[a0 + 2] * inv0;

    const cw1 = cp[a1 + 3];
    const inv1 = 1 / (cw1 || 1e-8);
    const sx1 = (cp[a1] * inv1 + 1) * 0.5 * W;
    const sy1 = (1 - cp[a1 + 1] * inv1) * 0.5 * H;
    const sz1 = cp[a1 + 2] * inv1;

    const cw2 = cp[a2 + 3];
    const inv2 = 1 / (cw2 || 1e-8);
    const sx2 = (cp[a2] * inv2 + 1) * 0.5 * W;
    const sy2 = (1 - cp[a2 + 1] * inv2) * 0.5 * H;
    const sz2 = cp[a2 + 2] * inv2;

    // 2D signed area (y-down). DX11 default: CW = front.
    const area = (sx1 - sx0) * (sy2 - sy0) - (sy1 - sy0) * (sx2 - sx0);

    if (this.rsState.cullMode !== 'NONE') {
      const isBack = area < 0;
      if ((this.rsState.cullMode === 'BACK' && isBack) ||
          (this.rsState.cullMode === 'FRONT' && !isBack)) {
        this.stats.culled++;
        return;
      }
    }
    if (Math.abs(area) < 1e-12) return;
    this.stats.triangles++;

    const minX = Math.max(0, Math.floor(Math.min(sx0, sx1, sx2)));
    const maxX = Math.min(W - 1, Math.ceil(Math.max(sx0, sx1, sx2)));
    const minY = Math.max(0, Math.floor(Math.min(sy0, sy1, sy2)));
    const maxY = Math.min(H - 1, Math.ceil(Math.max(sy0, sy1, sy2)));

    // ---- hoist state and varying plan out of the pixel loop ----
    const depthOn = this.depthState.depthEnable;
    const depthWrite = this.depthState.depthWriteEnable;
    const depthFunc = this.depthState.depthFunc;
    const depth = this.fb.depth;
    const color = this.fb.color;
    const psFn = this.ps.fn;
    const psU = this.ps.cbuffer || {};
    const psS = this.ps.samplers || {};
    const blended = this.blendState.enabled;

    const nVec = plan.vecCount;
    const vOff = plan.vecOff;
    const vDim = plan.vecDim;
    const vTgt = plan.vecTargets;
    const nScl = plan.sclCount;
    const sOff = plan.sclOff;
    const sKeys = plan.sclKeys;
    const varyOut = plan.varyOut;

    for (let y = minY; y <= maxY; y++) {
      const py = y + 0.5;
      for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5;

        const w0 = ((sx1 - px) * (sy2 - py) - (sy1 - py) * (sx2 - px)) / area;
        const w1 = ((sx2 - px) * (sy0 - py) - (sy2 - py) * (sx0 - px)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;

        const di = y * W + x;
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
        this.stats.pixels++;

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
}

export { Buffer, Shader, Texture };
