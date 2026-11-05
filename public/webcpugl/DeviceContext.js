// DX11-style immediate-mode device context.
//
// Rasterization runs either inline on the main thread or spread over a pool of Web
// Workers, one horizontal band per worker. Both paths go through RasterCore, so the
// pixels are identical; only the thread count changes.
//
// Varyings are carried as flat Float64Array rows (one row per vertex, `stride`
// doubles wide) instead of per-vertex objects, so per-pixel interpolation uses
// numeric offsets and never touches a string-keyed lookup.
//
// Worker mode notes:
//   - Shaders must come from loadShader() / createShaderPair(), because a worker
//     cannot receive a function; it imports the same .sd module by URL.
//   - Textures are sent as {width, height, data} and rebuilt in the worker
//     (structured clone would drop the sample() method).
//   - present() returns a Promise. Await it when you need fb.color/fb.depth, or to
//     keep the frame rate tied to the raster throughput.

import { Framebuffer } from './Framebuffer.js';
import { Buffer, Shader, Texture } from './resources.js';
import * as core from './RasterCore.js';

const MIN_WORKERS = 1;
const MAX_WORKERS = 64;

/** Shaded pixels per triangle above which a frame is worth sending to workers. */
const AUTO_MIN_PX_PER_TRI = 12;

function hardwareCores() {
  if (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) {
    return navigator.hardwareConcurrency | 0;
  }
  return 4;
}

/** Default thread count: enough to matter, few enough to not thrash. */
function defaultWorkers() {
  return Math.max(1, Math.min(8, hardwareCores()));
}

/** Clamp any requested thread count into [1, 64]. */
function clampWorkers(n) {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v) || v < MIN_WORKERS) return MIN_WORKERS;
  return Math.min(MAX_WORKERS, v);
}

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
    this.rsState = { cullMode: 'BACK' };

    // ---- OM stage ----
    this.depthState = { depthEnable: true, depthWriteEnable: true, depthFunc: 'LESS_EQUAL' };
    this.blendState = { enabled: false };

    // ---- per-frame stats (reset on present) ----
    this.stats = {
      drawCalls: 0,
      triangles: 0,
      culled: 0,
      pixels: 0,
      workers: { requested: 1, active: 1, cores: hardwareCores() },
    };

    // ---- worker pool ----
    this._workerCount = 1;
    this._workers = [];
    this._bands = [];          // {index, y0, y1, owner}
    this._bandRows = height;
    this._poolReady = false;
    this._parallel = false;
    this._disabled = false;
    this._warned = false;
    this._commands = [];       // queued frame commands while running in worker mode
    this._pending = new Map(); // frameId -> {remaining, bands, pixels, resolve}
    this._frameSeq = 0;
    this._texIds = new WeakMap();
    this._texById = new Map();
    this._texSent = new Set();
    this._nextTexId = 1;
    this._spans = null;
    this._counts = null;
    this._policy = 'auto';     // 'auto' | 'always'
    this._lastPxPerTri = 0;    // previous frame, drives the auto policy
    this._frameUseParallel = null;  // this frame's decision, taken at first draw
    this._framePath = 'inline';
    this._slabsStale = false;  // inline writes since the last slab sync

    if (typeof Worker !== 'undefined') this.setWorkerCount(undefined);
  }

  // ============================================================
  // Thread control
  // ============================================================

  /** Threads requested by the caller (already clamped). */
  get workerCount() { return this._workerCount; }

  /** Threads actually rasterizing right now (1 means the inline path). */
  get activeWorkers() { return this._framePath === 'parallel' ? this._workers.length : 1; }

  /**
   * How the frame decides between the inline and worker path.
   * 'auto' (default) keeps low-coverage frames inline, where the worker path's
   * per-triangle packing and buffer cloning would cost more than it saves.
   * 'always' sends every frame to the pool.
   * @param {'auto'|'always'} p
   */
  setParallelPolicy(p) {
    this._policy = p === 'always' ? 'always' : 'auto';
    this._lastPxPerTri = 0;   // let the next frame re-measure before dispatching
    this._frameUseParallel = null;
    return this._policy;
  }

  /** @returns {'auto'|'always'} */
  get parallelPolicy() { return this._policy; }

  /**
   * Resolves once the raster pool has reported ready. Await this before drawing
   * if you want the very first frame to run in parallel; otherwise the first
   * frames fall back to the inline path while workers boot.
   * Resolves immediately when running inline.
   * @returns {Promise<void>}
   */
  whenReady() {
    if (this._workerCount <= 1 || this._disabled || this._poolReady) return Promise.resolve();
    if (this._readyPromise) return this._readyPromise;
    this._readyPromise = new Promise((resolve) => { this._readyResolve = resolve; });
    return this._readyPromise;
  }

  /**
   * Set the raster thread count. Always clamped to [1, 64].
   * 1 = run inline on the main thread (synchronous, no workers).
   * undefined / null = default = min(8, navigator.hardwareConcurrency).
   * @param {number} [n]
   * @returns {number} the clamped value that was applied
   */
  setWorkerCount(n) {
    const want = (n === undefined || n === null) ? clampWorkers(defaultWorkers()) : clampWorkers(n);

    if (want === this._workerCount && (this._poolReady || this._workers.length > 0)) {
      return this._workerCount;
    }

    this._shutdownWorkers();
    this._workerCount = want;
    this._disabled = false;
    this._warned = false;
    this._commands.length = 0;
    this._frameUseParallel = null;

    if (want > 1 && typeof Worker !== 'undefined') this._spawnWorkers(want);
    else this._disabled = want > 1; // no Worker support in this environment

    this.stats.workers = { requested: this._workerCount, active: this.activeWorkers, cores: hardwareCores() };
    return this._workerCount;
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
    if (tex) this._textureId(tex);
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

  OMSetBlendState({ enabled = false } = {}) { this.blendState.enabled = enabled; }

  // ============================================================
  // Clear
  // ============================================================
  ClearRenderTarget(color /* [r,g,b,a] 0..1 */) {
    const cmd = { type: 'clearColor', rgba: [color[0], color[1], color[2], color[3] === undefined ? 1 : color[3]] };
    if (this._willQueue()) { this._commands.push(cmd); return; }
    core.clearColorBuffer(this.fb.color, cmd.rgba, this.fb.width, this.fb.height, 0);
  }

  ClearDepthStencil(d = 1.0) {
    const cmd = { type: 'clearDepth', depth: d };
    if (this._willQueue()) { this._commands.push(cmd); return; }
    this.fb.depth.fill(d);
  }

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

  /**
   * Push the internal framebuffer to the visible canvas.
   * Resolves with `lastFrame`. In worker mode the pixels only land in fb.color /
   * fb.depth once this resolves; in inline mode it resolves immediately.
   * @returns {Promise<object>}
   */
  present() {
    // switch to the worker path only at a frame boundary, so a frame is never
    // half inline and half queued
    if (this._poolReady && !this._parallel && !this._disabled) this._activateParallel();

    if (this._willQueue()) {
      if (this._slabsStale) this._syncSlabs();   // previous frames were inline
      return this._presentParallel();
    }

    // inline frame: anything queued (e.g. a clear that landed before the
    // decision was made) is replayed first, then the frame is blitted
    if (this._commands.length > 0) {
      const queued = this._commands;
      this._commands = [];
      this._replayInline(queued);
    }
    this._presentInline();
    return Promise.resolve(this.lastFrame);
  }

  /**
   * Per-frame routing decision, taken once at the first clear/draw of the frame
   * and reused by present(). Deciding this early matters: a low-coverage frame
   * then never builds a queued command at all, it rasterizes straight inline.
   */
  _willQueue() {
    if (!this._parallel) return false;
    if (this._frameUseParallel === null) {
      this._frameUseParallel = this._policy === 'always' ? true : this._shouldDispatch();
    }
    return this._frameUseParallel;
  }

  /**
   * Auto policy: dispatch to workers only when the frame shades enough pixels per
   * triangle to pay for the packing.
   *
   * A triangle costs the worker path once in band packing and once again in the
   * clone back, no matter how few pixels it covers; the parallel saving is per
   * shaded pixel. Measured on this project, packing is ~250 ns/tri and the pixel
   * saving at 8 workers is ~0.12 us/px, so the break-even sits near 10 px/tri.
   * Frames that shade fewer pixels than that stay inline.
   *
   * Uses the previous frame as the predictor; the first frame stays inline
   * because there is nothing to predict from yet.
   */
  _shouldDispatch() {
    const ratio = this._lastPxPerTri;
    if (!(ratio >= AUTO_MIN_PX_PER_TRI)) return false;
    return true;
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
   * Vertex stage (always on the main thread) followed by either immediate inline
   * rasterization or a queued draw command for the worker pool.
   */
  _runDraw(count, idx, start, base) {
    if (count <= 0) return;
    const vs = this.vs;
    if (!vs) throw new Error('Draw: no vertex shader bound.');
    const cb = vs.cbuffer || {};

    // the first vertex also discovers the varying shape for this draw
    const i0 = idx ? base + idx[start] : start;
    const first = vs.fn(this._fetchVertex(i0), cb);
    const plan = core.buildVaryingPlan(first);
    const perVert = 4 + plan.stride;

    // clip position and varyings live in one interleaved row, so a triangle is a
    // single contiguous run of doubles
    const vt = new Float64Array(count * perVert);

    core.writeVertex(vt, perVert, 0, first, plan);
    for (let i = 1; i < count; i++) {
      const vIdx = idx ? base + idx[start + i] : start + i;
      core.writeVertex(vt, perVert, i, vs.fn(this._fetchVertex(vIdx), cb), plan);
    }

    if (this._willQueue()) {
      this._queueDraw(vt, count, plan, perVert);
      return;
    }

    const ctx = this._inlineCtx();
    for (let i = 0; i + 2 < count; i += 3) {
      const a0 = i * perVert;
      core.rasterTriangle(
        ctx, vt, a0, a0 + perVert, a0 + 2 * perVert,
        vt, a0 + 4, a0 + perVert + 4, a0 + 2 * perVert + 4,
        plan,
      );
    }
  }

  /** Snapshot the bound pipeline state into a frame command. */
  _queueDraw(vt, count, plan, perVert) {
    const ps = this.ps;
    if (!ps) throw new Error('Draw: no pixel shader bound.');
    if (!ps.url) {
      // a worker cannot receive a function; it has to import the shader module
      this._fallBackToInline('pixel shader has no source url (use loadShader/createShaderPair)');
      // replay what was already queued, then draw this one inline
      const queued = this._commands;
      this._commands = [];
      this._replayInline(queued);
      const ctx = this._inlineCtx();
      for (let i = 0; i + 2 < count; i += 3) {
        const a0 = i * perVert;
        core.rasterTriangle(
          ctx, vt, a0, a0 + perVert, a0 + 2 * perVert,
          vt, a0 + 4, a0 + perVert + 4, a0 + 2 * perVert + 4,
          plan,
        );
      }
      return;
    }

    const textures = [];
    const samplers = ps.samplers || {};
    for (const k in samplers) {
      const tex = samplers[k];
      if (!tex) continue;
      const id = this._textureId(tex);
      if (id) textures.push({ slot: +k.slice(1), id });
    }

    this._commands.push({
      type: 'draw',
      vt, count, plan,
      perVert,
      perTri: 3 * perVert,
      shaderUrl: ps.url,
      uniforms: { ...(ps.cbuffer || {}) },
      textures,
      // snapshots for the inline path: a queued draw may be replayed after the
      // app has already bound a different shader
      psFn: ps.fn,
      psS: { ...samplers },
      blend: this.blendState.enabled,
      depth: { ...this.depthState },
      cull: this.rsState.cullMode,
    });
  }

  _inlineCtx() {
    return {
      W: this.fb.width,
      H: this.fb.height,
      color: this.fb.color,
      depth: this.fb.depth,
      y0: 0,
      y1: this.fb.height - 1,
      cullMode: this.rsState.cullMode,
      depthOn: this.depthState.depthEnable,
      depthWrite: this.depthState.depthWriteEnable,
      depthFunc: this.depthState.depthFunc,
      blended: this.blendState.enabled,
      psFn: this.ps.fn,
      psU: this.ps.cbuffer || {},
      psS: this.ps.samplers || {},
      stats: this.stats,
    };
  }

  /** Build a ctx that draws into an arbitrary color/depth pair (used for replay). */
  _ctxFor(cmd, color, depth, y0, y1) {
    return {
      W: this.fb.width,
      H: this.fb.height,
      color, depth, y0, y1,
      cullMode: cmd.cull,
      depthOn: cmd.depth.depthEnable,
      depthWrite: cmd.depth.depthWriteEnable,
      depthFunc: cmd.depth.depthFunc,
      blended: cmd.blend,
      psFn: cmd.psFn,
      psU: cmd.uniforms,
      psS: cmd.psS,
      stats: this.stats,
    };
  }

  /** Rasterize queued commands straight to the framebuffer (fallback path). */
  _replayInline(commands) {
    const W = this.fb.width, H = this.fb.height;
    for (const cmd of commands) {
      if (cmd.type === 'clearColor') {
        core.clearColorBuffer(this.fb.color, cmd.rgba, W, H, 0);
      } else if (cmd.type === 'clearDepth') {
        this.fb.depth.fill(cmd.depth);
      } else if (cmd.type === 'draw') {
        const ctx = this._ctxFor(cmd, this.fb.color, this.fb.depth, 0, H - 1);
        const perVert = cmd.perVert;
        for (let i = 0; i + 2 < cmd.count; i += 3) {
          const a0 = i * perVert;
          core.rasterTriangle(
            ctx, cmd.vt, a0, a0 + perVert, a0 + 2 * perVert,
            cmd.vt, a0 + 4, a0 + perVert + 4, a0 + 2 * perVert + 4,
            cmd.plan,
          );
        }
      }
    }
  }

  _presentInline() {
    const now = performance.now();
    this._framePath = 'inline';
    this._slabsStale = true;         // fb changed since the last slab sync
    this.fb.imageData.data.set(this.fb.color);
    this.ctx2d.putImageData(this.fb.imageData, 0, 0);
    this._finishFrame(now);
  }

  _finishFrame(now) {
    const dt = this._lastPresent ? (now - this._lastPresent) : 16.6;
    this._lastPresent = now;
    this.stats.frameMs = dt;
    this.stats.fps = 1000 / dt;
    const tris = this.stats.triangles;
    this._lastPxPerTri = tris > 0 ? this.stats.pixels / tris : 0;
    this.stats.workers = {
      requested: this._workerCount,
      active: this.activeWorkers,
      cores: hardwareCores(),
      mode: this._framePath,
    };

    this.lastFrame = { ...this.stats };

    this.stats.drawCalls = 0;
    this.stats.triangles = 0;
    this.stats.culled = 0;
    this.stats.pixels = 0;
    this._frameUseParallel = null;   // next frame decides again from the new ratio
  }

  // ---- worker pool ------------------------------------------------------

  _spawnWorkers(n) {
    const W = this.fb.width, H = this.fb.height;
    const bandCount = Math.max(1, Math.min(H, n * 2));
    const bandRows = Math.ceil(H / bandCount);

    this._bands = [];
    this._bandRows = bandRows;
    this._readyPromise = null;
    this._readyResolve = null;
    for (let b = 0; b < bandCount; b++) {
      const y0 = b * bandRows;
      if (y0 >= H) break;
      const y1 = Math.min(H - 1, y0 + bandRows - 1);
      this._bands.push({ index: this._bands.length, y0, y1, owner: b % n });
    }

    this._readyCount = 0;
    this._workers = [];

    for (let i = 0; i < n; i++) {
      let worker;
      try {
        worker = new Worker(new URL('./RasterWorker.js', import.meta.url), { type: 'module' });
      } catch (err) {
        this._fallBackToInline('could not start a worker: ' + err);
        return;
      }
      worker.onmessage = (e) => this._onWorkerMessage(i, e.data);
      worker.onerror = (e) => this._fallBackToInline('worker error: ' + (e.message || 'unknown'));
      worker.onmessageerror = () => this._fallBackToInline('worker message could not be deserialized');

      const owned = this._bands.filter((b) => b.owner === i);
      worker.postMessage({
        type: 'init',
        W, H,
        bands: owned.map((b) => ({ index: b.index, y0: b.y0, y1: b.y1 })),
      });
      this._workers.push(worker);
    }
  }

  _onWorkerMessage(i, msg) {
    if (!msg || !msg.type) return;

    if (msg.type === 'ready') {
      this._readyCount = (this._readyCount || 0) + 1;
      if (this._readyCount === this._workers.length) {
        this._poolReady = true;
        if (this._readyResolve) { const r = this._readyResolve; this._readyResolve = null; r(); }
      }
      return;
    }

    if (msg.type === 'framedone') {
      const pf = this._pending.get(msg.frameId);
      if (!pf) return;
      for (const slab of msg.bands) pf.bands.push(slab);
      pf.pixels += msg.stats ? msg.stats.pixels : 0;
      pf.remaining--;
      if (pf.remaining <= 0) {
        this._pending.delete(msg.frameId);
        this._composite(pf);
      }
    }
  }

  _composite(pf) {
    const W = this.fb.width;
    for (const slab of pf.bands) {
      this.fb.color.set(slab.color, slab.y0 * W * 4);
      this.fb.depth.set(slab.depth, slab.y0 * W);
    }
    this.stats.pixels += pf.pixels;

    const now = performance.now();
    this._framePath = 'parallel';
    this._slabsStale = false;      // workers own the pixels again
    this.fb.imageData.data.set(this.fb.color);
    this.ctx2d.putImageData(this.fb.imageData, 0, 0);
    this._finishFrame(now);
    pf.resolve(this.lastFrame);
  }

  _activateParallel() {
    this._parallel = true;
    this._commands.length = 0;
    this._syncSlabs();
  }

  /**
   * Hand each worker its slice of the current framebuffer, so a frame that does
   * not clear behaves the same as it would inline — and so switching back from
   * an inline frame does not resurrect stale pixels.
   */
  _syncSlabs() {
    const W = this.fb.width;
    for (let i = 0; i < this._workers.length; i++) {
      const owned = this._bands.filter((b) => b.owner === i);
      this._workers[i].postMessage({
        type: 'sync',
        slabs: owned.map((b) => ({
          index: b.index,
          y0: b.y0,
          y1: b.y1,
          color: this.fb.color.subarray(b.y0 * W * 4, (b.y1 + 1) * W * 4),
          depth: this.fb.depth.subarray(b.y0 * W, (b.y1 + 1) * W),
        })),
      });
    }
    this._slabsStale = false;
  }

  _presentParallel() {
    const frameId = ++this._frameSeq;
    const draws = [];

    for (const cmd of this._commands) {
      if (cmd.type !== 'draw') { draws.push(cmd); continue; }
      const packed = this._compactBands(cmd);
      draws.push({
        type: 'draw',
        shaderUrl: cmd.shaderUrl,
        uniforms: cmd.uniforms,
        textures: cmd.textures,
        blend: cmd.blend,
        depth: cmd.depth,
        cull: cmd.cull,
        planDesc: core.planDescriptor(cmd.plan),
        perVert: cmd.perVert,
        perTri: cmd.perTri,
        perBand: packed.perBand,
        bandTriCount: packed.counts,
      });
    }

    if (draws.length === 0) {
      // nothing was drawn this frame: just re-present the composited frame
      this._commands = [];
      this.fb.imageData.data.set(this.fb.color);
      this.ctx2d.putImageData(this.fb.imageData, 0, 0);
      this._finishFrame(performance.now());
      return Promise.resolve(this.lastFrame);
    }

    // textures travel with the first frame that uses them
    const texturePayload = [];
    for (const [id, tex] of this._texById) {
      if (this._texSent.has(id)) continue;
      texturePayload.push({ id, w: tex.width, h: tex.height, data: tex.data });
    }

    const owned = this._bands;
    const messages = this._workers.map((_, wi) => ({
      type: 'frame',
      frameId,
      textures: texturePayload,
      draws: draws.map((d) => {
        if (d.type !== 'draw') return d;
        const perBand = {}, bandTriCount = {};
        for (const b of owned) {
          if (b.owner !== wi) continue;
          const arr = d.perBand[b.index];
          if (!arr) continue;
          perBand[b.index] = arr;
          bandTriCount[b.index] = d.bandTriCount[b.index];
        }
        return { ...d, perBand, bandTriCount };
      }),
    }));

    this._commands = [];
    for (const p of texturePayload) this._texSent.add(p.id);

    return new Promise((resolve) => {
      this._pending.set(frameId, { remaining: this._workers.length, bands: [], pixels: 0, resolve });
      for (let i = 0; i < this._workers.length; i++) this._workers[i].postMessage(messages[i]);
    });
  }

  /**
   * Split one queued draw into per-band triangle payloads.
   * Each triangle is copied into every band its screen-space bbox touches, and
   * back-face culling is decided here so the same triangle is counted once.
   * @returns {Object<number, Float64Array>} band index -> packed triangles
   */
  _compactBands(cmd) {
    const W = this.fb.width, H = this.fb.height;
    const nb = this._bands.length;
    const perVert = cmd.perVert;
    const perTri = cmd.perTri;
    const triCount = Math.max(0, Math.floor(cmd.count / 3));

    if (!this._spans || this._spans.length < triCount * 2) {
      this._spans = new Int32Array(Math.max(4096, triCount * 2));
    }
    if (!this._counts || this._counts.length < nb) this._counts = new Int32Array(nb);

    const spans = this._spans, counts = this._counts;
    if (!this._bounds) this._bounds = new Float64Array(5);
    const bd = this._bounds;
    counts.fill(0, 0, nb);

    // pass 1: bounds, cull, per-band counts
    let t = 0;
    for (let i = 0; i + 2 < cmd.count; i += 3, t++) {
      const a0 = i * perVert;
      if (!core.triBounds(cmd.vt, a0, a0 + perVert, a0 + 2 * perVert, W, H, bd)) {
        spans[2 * t] = 1;          // b0 > b1 marks "skipped"
        spans[2 * t + 1] = 0;
        continue;
      }

      if (cmd.cull !== 'NONE') {
        const isBack = bd[0] < 0;
        if ((cmd.cull === 'BACK' && isBack) || (cmd.cull === 'FRONT' && !isBack)) {
          this.stats.culled++;
          spans[2 * t] = 1;
          spans[2 * t + 1] = 0;
          continue;
        }
      }
      this.stats.triangles++;

      const b0 = this._bandIndex(bd[3], nb);
      const b1 = this._bandIndex(bd[4], nb);
      spans[2 * t] = b0;
      spans[2 * t + 1] = b1;
      for (let b = b0; b <= b1; b++) counts[b]++;
    }

    // pass 2: pack
    const perBand = {};
    for (let b = 0; b < nb; b++) if (counts[b] > 0) perBand[b] = new Float64Array(counts[b] * perTri);
    const cursor = new Int32Array(nb);

    t = 0;
    for (let i = 0; i + 2 < cmd.count; i += 3, t++) {
      const b0 = spans[2 * t], b1 = spans[2 * t + 1];
      if (b1 < b0) continue;
      const src = i * perVert;                     // 3 consecutive interleaved rows
      for (let b = b0; b <= b1; b++) {
        const dst = perBand[b];
        let d = cursor[b] * perTri;
        for (let j = 0; j < perTri; j++) dst[d++] = cmd.vt[src + j];
        cursor[b]++;
      }
    }

    this._lastBandCounts = counts;
    return { perBand, counts: counts.slice(0, nb) };
  }

  _bandIndex(y, nb) {
    const b = Math.floor(y / this._bandRows);
    return b < 0 ? 0 : (b >= nb ? nb - 1 : b);
  }

  _textureId(tex) {
    let id = this._texIds.get(tex);
    if (!id) {
      id = this._nextTexId++;
      this._texIds.set(tex, id);
      this._texById.set(id, tex);
    }
    return id;
  }

  _fallBackToInline(why) {
    this._disabled = true;
    this._parallel = false;
    this._poolReady = false;
    this._frameUseParallel = null;
    this._shutdownWorkers();
    if (!this._warned) {
      this._warned = true;
      console.warn('[WebCpuGL] parallel rasterization disabled: ' + why);
    }
  }

  _shutdownWorkers() {
    for (const w of this._workers) {
      try { w.postMessage({ type: 'dispose' }); } catch { /* already gone */ }
      try { w.terminate(); } catch { /* already gone */ }
    }
    this._workers = [];
    this._bands = [];
    this._poolReady = false;
    this._parallel = false;
    this._frameUseParallel = null;
    for (const [, pf] of this._pending) pf.resolve(this.lastFrame);
    this._pending.clear();
  }
}

export { Buffer, Shader, Texture };
