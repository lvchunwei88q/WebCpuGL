// Example: textured + indexed quad, with a second translucent quad in front
// to show off depth test and alpha blending.
// Run: http://localhost:8080/?example=textured_quad

import { createDevice, loadShader, math } from '/webcpugl/index.js';

const canvas = document.getElementById('view');
const { device, context } = createDevice(canvas);
window.__gpu = context;   // for HUD / debugging

// ---- Build a 64x64 checkerboard texture procedurally (no external file) ----
const TW = 64, TH = 64;
const texData = new Uint8ClampedArray(TW * TH * 4);
for (let y = 0; y < TH; y++) {
  for (let x = 0; x < TW; x++) {
    const i = (y * TW + x) * 4;
    const cx = Math.floor(x / 8), cy = Math.floor(y / 8);
    const on = ((cx + cy) & 1) === 0;
    texData[i]   = on ? 235 :  40;
    texData[i+1] = on ? 200 :  60;
    texData[i+2] = on ?  80 : 110;
    texData[i+3] = 255;
  }
}
const checker = device.createTexture(TW, TH, texData);

// ---- Vertex buffer: POSITION (float3) + UV (float2), stride = 20 bytes ----
// Two quads: back textured quad at z = -0.3, front translucent quad at z = 0.0.
const verts = new Float32Array([
  // --- back quad (textured) ---
  //  x     y     z      u    v
  -0.6, -0.6, -0.3,   0.0, 1.0,
   0.6, -0.6, -0.3,   1.0, 1.0,
   0.6,  0.6, -0.3,   1.0, 0.0,
  -0.6,  0.6, -0.3,   0.0, 0.0,
  // --- front quad (translucent solid) ---
  -0.3, -0.3,  0.0,   0.0, 1.0,
   0.3, -0.3,  0.0,   1.0, 1.0,
   0.3,  0.3,  0.0,   1.0, 0.0,
  -0.3,  0.3,  0.0,   0.0, 0.0,
]);
const vb = device.createBuffer({ usage: 'VERTEX', data: verts });

// Index buffer: two quads, each 2 triangles, CW front-facing.
const indices = new Uint16Array([
  0, 3, 2,  0, 2, 1,     // back quad (CW front)
  4, 7, 6,  4, 6, 5,     // front quad (CW front)
]);
const ib = device.createBuffer({ usage: 'INDEX', data: indices });

const shader = await loadShader('/examples/textured_quad/shader.sd');
const { vs, ps } = device.createShaderPair(shader);

context.IASetInputLayout([
  { semantic: 'POSITION', offset: 0, format: 'FLOAT3' },
  { semantic: 'TEXCOORD', offset: 12, format: 'FLOAT2' },
]);
context.IASetVertexBuffers(0, [{ buffer: vb, stride: 20, offset: 0 }]);
context.IASetIndexBuffer(ib, 'UINT16');
context.VSSetShader(vs);
context.PSSetShader(ps);
context.PSSetShaderResource(0, checker);   // samplers.t0

context.RSSetState({ cullMode: 'NONE' });
context.OMSetDepthStencilState({ depthEnable: true, depthWriteEnable: true });
context.OMSetBlendState({ enabled: true });

function frame(tMs) {
  const t = tMs / 1000;
  const mvp = math.multiply(math.rotationY(t * 0.6), math.rotationX(Math.sin(t * 0.7) * 0.3));

  context.VSSetConstantBuffer(0, { uMVP: mvp, uTime: t });
  context.ClearRenderTarget([0, 0, 0, 1]);
  context.ClearDepthStencil(1.0);
  context.DrawIndexed(12, 0, 0);
  context.present();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
