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
  VSSetShader(shader) { this.vs = shader; }
  PSSetShader(shader) { this.ps = shader; }

  /**
   * Bind a uniform object to the VS. In DX11 this is a real constant buffer,
   * but here we just hand the whole object straight to vs() and fs().
   * Both VS and PS share the same uniform object.
   */
  VSSetConstantBuffer(_slot, uniformObject) {
    const u = uniformObject || {};
    if (this.vs) this.vs.cbuffer = u;
    if (this.ps) this.ps.cbuffer = u;
  }
  PSSetConstantBuffer(_slot, uniformObject) {
    const u = uniformObject || {};
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
    const buf = slot.buffer.data; // TypedArray
    const base = vertexIndex * slot.stride + (slot.offset || 0) + buf.byteOffset;
    const dv = new DataView(buf.buffer, base);
    const out = {};
    for (const attr of this.inputLayout) {
      const o = attr.offset;
      switch (attr.format) {
        case 'FLOAT1': out[attr.semantic] = [dv.getFloat32(o, true)]; break;
        case 'FLOAT2': out[attr.semantic] = [dv.getFloat32(o, true), dv.getFloat32(o+4, true)]; break;
        case 'FLOAT3': out[attr.semantic] = [dv.getFloat32(o, true), dv.getFloat32(o+4, true), dv.getFloat32(o+8, true)]; break;
        case 'FLOAT4': out[attr.semantic] = [dv.getFloat32(o, true), dv.getFloat32(o+4, true), dv.getFloat32(o+8, true), dv.getFloat32(o+12, true)]; break;
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
      const [x, y, z, w] = pClip[i];
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
      // area > 0 => CW (front), area < 0 => CCW (back)
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

    const depth = this.fb.depth;
    const color = this.fb.color;

    for (let y = minY; y <= maxY; y++) {
      const py = y + 0.5;
      for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5;

        // barycentric
        const w0 = ((p[1].sx - px) * (p[2].sy - py) - (p[1].sy - py) * (p[2].sx - px)) / area;
        const w1 = ((p[2].sx - px) * (p[0].sy - py) - (p[2].sy - py) * (p[0].sx - px)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;

        const z = w0 * p[0].sz + w1 * p[1].sz + w2 * p[2].sz;

        if (this.depthState.depthEnable) {
          const di = y * W + x;
          if (this.depthState.depthFunc === 'LESS_EQUAL' && z > depth[di]) continue;
          if (this.depthState.depthFunc === 'LESS'       && z >= depth[di]) continue;
          if (this.depthState.depthFunc === 'GREATER'    && z < depth[di]) continue;
        }

        // perspective-correct interpolation: 1/w at this pixel
        const invW = w0 * p[0].invW + w1 * p[1].invW + w2 * p[2].invW;
        const vary = {};
        for (const k in vIn[0]) {
          const a = vIn[0][k], b = vIn[1][k], c = vIn[2][k];
          if (typeof a === 'number') {
            vary[k] = (w0*a*p[0].invW + w1*b*p[1].invW + w2*c*p[2].invW) / invW;
          } else {
            const n = a.length;
            const out = new Array(n);
            for (let i = 0; i < n; i++) {
              out[i] = (w0*a[i]*p[0].invW + w1*b[i]*p[1].invW + w2*c[i]*p[2].invW) / invW;
            }
            vary[k] = out;
          }
        }

        const out = this.ps.fn(vary, this.ps.cbuffer || {}, this.ps.samplers || {});
        if (!out || out.length < 3) continue;
        let r = out[0], g = out[1], bch = out[2], a = out.length > 3 ? out[3] : 1;

        const di = y * W + x;
        if (this.depthState.depthWriteEnable && this.depthState.depthEnable) {
          depth[di] = z;
        }
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
