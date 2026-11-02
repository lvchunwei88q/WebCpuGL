// Fixed-size color + depth framebuffer. 256x256 by default.
// color: Uint8ClampedArray RGBA8, depth: Float32.

export class Framebuffer {
  constructor(width = 256, height = 256) {
    this.width = width;
    this.height = height;
    this.color = new Uint8ClampedArray(width * height * 4);
    this.depth = new Float32Array(width * height);
    this.imageData = new ImageData(width, height);
  }

  // color: [r,g,b,a] in 0..1
  clearColor([r, g, b, a = 1]) {
    const R = Math.round(r * 255), G = Math.round(g * 255),
          B = Math.round(b * 255), A = Math.round(a * 255);
    for (let i = 0; i < this.width * this.height; i++) {
      const o = i * 4;
      this.color[o] = R; this.color[o+1] = G;
      this.color[o+2] = B; this.color[o+3] = A;
    }
  }

  clearDepth(d = 1.0) {
    this.depth.fill(d);
  }
}
