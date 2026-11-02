// Loads a .sd shader file (which is plain ES Module JS source).
// The Node server already serves .sd with Content-Type: text/javascript,
// so we can dynamic-import it directly — the module base is the real
// http:// origin, and absolute imports like
//   import { transformVec4 } from '/webcpugl/math.js'
// resolve correctly.
//
// The module must export two functions:
//
//   export function vs(input, uniforms) -> { position: [x,y,z,w], ...varyings }
//   export function fs(input, uniforms, samplers) -> [r,g,b,a]   (0..1)

const cache = new Map();

export async function loadShader(url) {
  if (cache.has(url)) return cache.get(url);
  const mod = await import(url);
  if (typeof mod.vs !== 'function' || typeof mod.fs !== 'function') {
    throw new Error("ShaderLoader: " + url + " must export 'vs' and 'fs' functions.");
  }
  const out = { vs: mod.vs, fs: mod.fs, url };
  cache.set(url, out);
  return out;
}
