// DX11-style immediate-mode device context. Holds all pipeline state and
// runs the software rasterizer on the JS main thread.

import { Framebuffer } from './Framebuffer.js';
import { Buffer, Shader, Texture } from './resources.js';

const FORMAT_SIZE = { FLOAT1: 4, FLOAT2: 8, FLOAT3: 12, FLOAT4: 16 };

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
    const positions = new Array(vertexCount);
    const varyings = new Array(vertexCount);
    for (let i = 0; i < vertexCount; i++) {
      const v = this._fetchVertex(startVertexLocation + i);
      const out = this.vs.fn(v, this.vs.cbuffer || {});
      positions[i] = out.position;
      const rest = {};
      for (const k in out) if (k !== 'position') rest[k] = out[k];
      varyings[i] = rest;
    }
    for (let i = 0; i + 2 < vertexCount; i += 3) {
      this._rasterTriangle(
        [positions[i], positions[i+1], positions[i+2]],
        [varyings[i],   varyings[i+1],   varyings[i+2]],
      );
    }
  }

  /** Indexed draw. */
  DrawIndexed(indexCount, startIndexLocation = 0, baseVertexLocation = 0) {
    this.stats.drawCalls++;
    if (!this.indexBuffer) throw new Error('DrawIndexed: no index buffer bound.');
    const idx = this.indexBuffer.data; // Uint16Array | Uint32Array
    const positions = new Array(indexCount);
    const varyings = new Array(indexCount);
    for (let i = 0; i < indexCount; i++) {
      const vIdx = baseVertexLocation + idx[startIndexLocation + i];
      const v = this._fetchVertex(vIdx);
      const out = this.vs.fn(v, this.vs.cbuffer || {});
      positions[i] = out.position;
      const rest = {};
      for (const k in out) if (k !== 'position') rest[k] = out[k];
      varyings[i] = rest;
    }
    for (let i = 0; i + 2 < indexCount; i += 3) {
      this._rasterTriangle(
        [positions[i], positions[i+1], positions[i+2]],
        [varyings[i],   varyings[i+1],   varyings[i+2]],
      );
    }
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

  _rasterTriangle(pClip, vIn) {
    // near-plane clip in clip space (w > NEAR)
    const NEAR = 0.001;
    const inside = [0, 1, 2].map(i => pClip[i][3] > NEAR);
    if (inside[0] && inside[1] && inside[2]) {
      this._rasterProjected(pClip, vIn);
      return;
    }
    if (!inside[0] && !inside[1] && !inside[2]) return;

    // Sutherland-Hodgman against w = NEAR
    const poly = [];
    const prev = { p: pClip[2], v: vIn[2], in: inside[2] };
    for (let i = 0; i < 3; i++) {
      const cur = { p: pClip[i], v: vIn[i], in: inside[i] };
      if (cur.in) {
        if (!prev.in) {
          const t = (NEAR - prev.p[3]) / (cur.p[3] - prev.p[3]);
          poly.push({ p: this._lerpVec4(prev.p, cur.p, t), v: this._lerpVary(prev.v, cur.v, t) });
        }
        poly.push({ p: cur.p, v: cur.v });
      } else if (prev.in) {
        const t = (NEAR - prev.p[3]) / (cur.p[3] - prev.p[3]);
        poly.push({ p: this._lerpVec4(prev.p, cur.p, t), v: this._lerpVary(prev.v, cur.v, t) });
      }
      // swap
      prev.p = cur.p; prev.v = cur.v; prev.in = cur.in;
    }
    for (let i = 1; i + 1 < poly.length; i++) {
      this._rasterProjected(
        [poly[0].p, poly[i].p, poly[i+1].p],
        [poly[0].v, poly[i].v, poly[i+1].v],
      );
    }
  }

  _lerpVec4(a, b, t) {
    return [
      a[0] + (b[0] - a[0]) * t,
      a[1] + (b[1] - a[1]) * t,
      a[2] + (b[2] - a[2]) * t,
      a[3] + (b[3] - a[3]) * t,
    ];
  }

  _lerpVary(a, b, t) {
    const out = {};
    for (const k in a) {
      const av = a[k], bv = b[k];
      if (typeof av === 'number') out[k] = av + (bv - av) * t;
      else out[k] = av.map((x, i) => x + (bv[i] - x) * t);
    }
    return out;
  }

  _rasterProjected(pClip, vIn) {
    const W = this.fb.width, H = this.fb.height;

    // w-divide + viewport transform. p[i] = {sx, sy, sz, invW}
    const p = new Array(3);
    for (let i = 0; i < 3; i++) {
      const x = pClip[i][0], y = pClip[i][1], z = pClip[i][2], w = pClip[i][3];
      const inv = 1 / (w || 1e-8);
      p[i] = {
        sx: ( x * inv + 1) * 0.5 * W,
        sy: (1 - y * inv) * 0.5 * H,
        sz: z * inv,
        invW: inv,
      };
    }

    // 2D signed area (y-down). DX11 default: CW = front.
    const area =
      (p[1].sx - p[0].sx) * (p[2].sy - p[0].sy) -
      (p[1].sy - p[0].sy) * (p[2].sx - p[0].sx);

    if (this.rsState.cullMode !== 'NONE') {
      const isBack = area < 0;
      if ((this.rsState.cullMode === 'BACK'  && isBack) ||
          (this.rsState.cullMode === 'FRONT' && !isBack)) {
        this.stats.culled++;
        return;
      }
    }
    if (Math.abs(area) < 1e-12) return;
    this.stats.triangles++;

    const minX = Math.max(0, Math.floor(Math.min(p[0].sx, p[1].sx, p[2].sx)));
    const maxX = Math.min(W - 1, Math.ceil(Math.max(p[0].sx, p[1].sx, p[2].sx)));
    const minY = Math.max(0, Math.floor(Math.min(p[0].sy, p[1].sy, p[2].sy)));
    const maxY = Math.min(H - 1, Math.ceil(Math.max(p[0].sy, p[1].sy, p[2].sy)));

    // ---- precompile varying layout once per triangle ----
    const layout = [];
    const varyOut = {};
    const v0 = vIn[0], v1 = vIn[1], v2 = vIn[2];
    for (const k in v0) {
      const a = v0[k];
      if (typeof a === 'number') {
        layout.push({ key: k, vec: false });
        varyOut[k] = 0;
      } else {
        layout.push({ key: k, vec: true, dim: a.length });
        varyOut[k] = new Array(a.length);
      }
    }

    // ---- hoist depth test branch out of pixel loop ----
    const depthOn = this.depthState.depthEnable;
    const depthWrite = this.depthState.depthWriteEnable;
    const depthFunc = this.depthState.depthFunc;
    const depth = this.fb.depth;
    const color = this.fb.color;
    const psFn = this.ps.fn;
    const psU = this.ps.cbuffer || {};
    const psS = this.ps.samplers || {};

    for (let y = minY; y <= maxY; y++) {
      const py = y + 0.5;
      for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5;

        const w0 = ((p[1].sx - px) * (p[2].sy - py) - (p[1].sy - py) * (p[2].sx - px)) / area;
        const w1 = ((p[2].sx - px) * (p[0].sy - py) - (p[2].sy - py) * (p[0].sx - px)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;

        const di = y * W + x;
        const z = w0 * p[0].sz + w1 * p[1].sz + w2 * p[2].sz;

        if (depthOn) {
          if (depthFunc === 'LESS_EQUAL' && z > depth[di]) continue;
          else if (depthFunc === 'LESS' && z >= depth[di]) continue;
          else if (depthFunc === 'GREATER' && z < depth[di]) continue;
        }

        const invW = w0 * p[0].invW + w1 * p[1].invW + w2 * p[2].invW;
        const inv = 1 / invW;
        for (let li = 0; li < layout.length; li++) {
          const L = layout[li];
          const a = v0[L.key], b = v1[L.key], c = v2[L.key];
          if (!L.vec) {
            varyOut[L.key] = (w0*a*p[0].invW + w1*b*p[1].invW + w2*c*p[2].invW) * inv;
          } else {
            const out = varyOut[L.key];
            for (let i = 0; i < L.dim; i++) {
              out[i] = (w0*a[i]*p[0].invW + w1*b[i]*p[1].invW + w2*c[i]*p[2].invW) * inv;
            }
          }
        }

        const out = psFn(varyOut, psU, psS);
        if (!out || out.length < 3) continue;

        if (depthOn && depthWrite) depth[di] = z;
        this.stats.pixels++;

        const o = di * 4;
        if (this.blendState.enabled) {
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
