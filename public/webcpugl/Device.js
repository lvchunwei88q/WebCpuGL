// Device: factory for GPU resources. Pairs with DeviceContext for immediate-mode draws.

import { DeviceContext } from './DeviceContext.js';
import { Buffer, Shader, Texture } from './resources.js';

export class Device {
  constructor(canvas, width = 256, height = 256) {
    this.context = new DeviceContext(canvas, width, height);
  }

  /**
   * @param {{usage:'VERTEX'|'INDEX'|'CONSTANT', data:ArrayBuffer|TypedArray}} desc
   */
  createBuffer(desc) { return new Buffer(desc); }

  /** Wrap a vs() function from a loaded .sd module. */
  createVertexShader(fn, url) {
    const s = new Shader('vs', fn);
    if (url) s.url = url;
    return s;
  }
  /** Wrap a fs() function from a loaded .sd module. */
  createPixelShader(fn, url) {
    const s = new Shader('ps', fn);
    if (url) s.url = url;
    return s;
  }

  /**
   * Convenience: pass the whole module returned by ShaderLoader.loadShader().
   * The shader source url is kept on both shaders, because raster workers import
   * the same .sd module themselves instead of receiving the function.
   * Returns { vs, ps }.
   */
  createShaderPair(mod) {
    const pair = {
      vs: this.createVertexShader(mod.vs, mod.url),
      ps: this.createPixelShader(mod.fs, mod.url),
    };
    return pair;
  }

  /**
   * @param {number} w
   * @param {number} h
   * @param {Uint8ClampedArray|Uint8Array} rgba RGBA8 data, length w*h*4
   */
  createTexture(w, h, rgba) { return new Texture(w, h, rgba); }

  /**
   * Create a texture from a HTMLImageElement / ImageBitmap / canvas.
   * Draws into a tiny offscreen 2D canvas to read back pixels.
   */
  createTextureFromImage(img) {
    const c = document.createElement('canvas');
    c.width = img.naturalWidth || img.width;
    c.height = img.naturalHeight || img.height;
    const cx = c.getContext('2d');
    cx.drawImage(img, 0, 0);
    const data = cx.getImageData(0, 0, c.width, c.height).data;
    return new Texture(c.width, c.height, data);
  }
}

/**
 * One-stop: create a device bound to a canvas.
 * @param {HTMLCanvasElement} canvas
 * @param {number} [width=256]  framebuffer width (defaults to 256)
 * @param {number} [height=256] framebuffer height (defaults to 256)
 */
export function createDevice(canvas, width = 256, height = 256) {
  const device = new Device(canvas, width, height);
  return { device, context: device.context };
}
