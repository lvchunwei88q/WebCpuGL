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
  createVertexShader(fn) { return new Shader('vs', fn); }
  /** Wrap a fs() function from a loaded .sd module. */
  createPixelShader(fn) { return new Shader('ps', fn); }

  /**
   * Convenience: pass the whole module returned by ShaderLoader.loadShader().
   * Returns { vs, ps }.
   */
  createShaderPair(mod) {
    return { vs: this.createVertexShader(mod.vs), ps: this.createPixelShader(mod.fs) };
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
