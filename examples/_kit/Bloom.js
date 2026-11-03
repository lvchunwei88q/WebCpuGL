// Bloom.js — sample post-process, modeled after AKGWSB/CasualBloom.
// Usage: after all DrawIndexed() and before context.present(), call
//   applyBloom(context.fb.color, context.fb.width, context.fb.height, {
//     threshold: 0.8, intensity: 0.5, levels: 3, blurSize: 2,
//   });

const LUM = [0.2126, 0.7152, 0.0722];

function thresholdPass(src, w, h, threshold) {
  const out = new Float32Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    const lum = (src[o]*LUM[0] + src[o+1]*LUM[1] + src[o+2]*LUM[2]) / 255;
    if (lum > threshold) {
      out[o]   = src[o];
      out[o+1] = src[o+1];
      out[o+2] = src[o+2];
    }
    out[o+3] = 255;
  }
  return out;
}

function boxDown(src, sw, sh, dst, dw, dh) {
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      const sx = x * 2, sy = y * 2;
      let r = 0, g = 0, b = 0;
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const si = ((sy + dy) * sw + (sx + dx)) * 4;
          r += src[si]; g += src[si+1]; b += src[si+2];
        }
      }
      const o = (y * dw + x) * 4;
      dst[o] = r / 4; dst[o+1] = g / 4; dst[o+2] = b / 4; dst[o+3] = 255;
    }
  }
}

function blurH(src, w, h, radius, tmp) {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, wsum = 0;
      for (let t = -radius; t <= radius; t++) {
        const sx = Math.max(0, Math.min(w-1, x+t));
        const o = (y*w + sx) * 4;
        const wt = t === 0 ? 4 : (Math.abs(t) === 1 ? 2 : 1);
        r += src[o]*wt; g += src[o+1]*wt; b += src[o+2]*wt; wsum += wt;
      }
      const o = (y*w + x) * 4;
      tmp[o] = r/wsum; tmp[o+1] = g/wsum; tmp[o+2] = b/wsum;
    }
  }
}

function blurV(src, w, h, radius, dst) {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, wsum = 0;
      for (let t = -radius; t <= radius; t++) {
        const sy = Math.max(0, Math.min(h-1, y+t));
        const o = (sy*w + x) * 4;
        const wt = t === 0 ? 4 : (Math.abs(t) === 1 ? 2 : 1);
        r += src[o]*wt; g += src[o+1]*wt; b += src[o+2]*wt; wsum += wt;
      }
      const o = (y*w + x) * 4;
      dst[o] = r/wsum; dst[o+1] = g/wsum; dst[o+2] = b/wsum;
    }
  }
}

function blur(src, w, h, radius, tmp) {
  blurH(src, w, h, radius, tmp);
  blurV(tmp, w, h, radius, src);
}

function upsampleAdd(small, sw, sh, dst, dw, dh) {
  for (let y = 0; y < dh; y++) {
    const sy = (y / 2) | 0;
    for (let x = 0; x < dw; x++) {
      const sx = (x / 2) | 0;
      const si = (sy * sw + sx) * 4;
      const o = (y * dw + x) * 4;
      dst[o]   += small[si];
      dst[o+1] += small[si+1];
      dst[o+2] += small[si+2];
    }
  }
}

export function applyBloom(color, W, H, opts = {}) {
  const {
    threshold = 0.8,
    intensity = 0.5,
    levels = 3,
    blurSize = 2,
  } = opts;

  // mips[0] = full-res threshold; each subsequent level is half res
  const mips = [];
  let w = W, h = H;
  mips.push({ w, h, data: thresholdPass(color, W, H, threshold) });

  for (let i = 1; i < levels; i++) {
    const pw = w, ph = h;
    w = Math.max(1, w >> 1);
    h = Math.max(1, h >> 1);
    const buf = new Float32Array(w * h * 4);
    boxDown(mips[i-1].data, pw, ph, buf, w, h);
    const tmp = new Float32Array(w * h * 4);
    blur(buf, w, h, blurSize, tmp);
    mips.push({ w, h, data: buf });
  }

  // upsample: start from coarsest, accumulate into finer mips
  let acc = mips[levels - 1].data;
  for (let i = levels - 2; i >= 0; i--) {
    upsampleAdd(acc, mips[i+1].w, mips[i+1].h, mips[i].data, mips[i].w, mips[i].h);
    const tmp = new Float32Array(mips[i].w * mips[i].h * 4);
    blur(mips[i].data, mips[i].w, mips[i].h, blurSize, tmp);
    acc = mips[i].data;
  }

  // composite: additive into original color
  for (let i = 0; i < W * H; i++) {
    const o = i * 4;
    color[o]   = Math.min(255, color[o]   + acc[o]   * intensity);
    color[o+1] = Math.min(255, color[o+1] + acc[o+1] * intensity);
    color[o+2] = Math.min(255, color[o+2] + acc[o+2] * intensity);
  }
}
