// Resource objects created by Device.

export class Buffer {
  /**
   * @param {object} o
   * @param {'VERTEX'|'INDEX'|'CONSTANT'} o.usage
   * @param {ArrayBuffer|TypedArray} o.data
   */
  constructor({ usage, data }) {
    this.usage = usage;
    // Always keep a plain ArrayBuffer view for uniform indexing.
    this.data = (data instanceof ArrayBuffer) ? new Uint8Array(data) : data;
    this.size = this.data.byteLength;
  }
}

export class Texture {
  /**
   * @param {number} w
   * @param {number} h
   * @param {Uint8ClampedArray|Uint8Array} data RGBA8, length = w*h*4
   */
  constructor(w, h, data) {
    this.width = w;
    this.height = h;
    this.data = data;
  }

  // nearest, clamp-to-edge. Returns [r,g,b,a] in 0..1.
  sample(u, v) {
    u = u < 0 ? 0 : u > 1 ? 1 : u;
    v = v < 0 ? 0 : v > 1 ? 1 : v;
    const x = Math.min(this.width  - 1, Math.floor(u * this.width));
    const y = Math.min(this.height - 1, Math.floor(v * this.height));
    const i = (y * this.width + x) * 4;
    return [
      this.data[i]   / 255,
      this.data[i+1] / 255,
      this.data[i+2] / 255,
      this.data[i+3] / 255,
    ];
  }
}

export class Shader {
  /**
   * @param {'vs'|'ps'} kind
   * @param {Function} fn
   * @param {string} [url] source module url; raster workers re-import it
   */
  constructor(kind, fn, url) {
    this.kind = kind;    // 'vs' | 'ps'
    this.fn = fn;
    this.url = url || null; // set by Device.createShaderPair for worker mode
    this.cbuffer = {};   // bound constant-buffer content
    this.samplers = {};  // for PS: slot -> Texture
  }
}
