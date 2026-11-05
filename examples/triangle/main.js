// Example: colored triangle with a subtle breathing-color animation.
// Run: node server.js  ->  http://localhost:8080/?example=triangle

import { createDevice, loadShader } from '/webcpugl/index.js';

const canvas = document.getElementById('view');
const { device, context } = createDevice(canvas);
window.__gpu = context;   // for HUD / debugging

// Vertex layout: POSITION (float3) + COLOR (float4), interleaved.
// Stride = 3*4 + 4*4 = 28 bytes.
const verts = new Float32Array([
  //  x     y     z     r     g     b     a
    0.0,  0.7,  0.0,  1.0, 0.2, 0.2, 1.0,
    0.7, -0.6,  0.0,  0.3, 0.5, 1.0, 1.0,
   -0.7, -0.6,  0.0,  0.2, 1.0, 0.4, 1.0,
]);
const vb = device.createBuffer({ usage: 'VERTEX', data: verts });

const shader = await loadShader('/examples/triangle/shader.sd');
const { vs, ps } = device.createShaderPair(shader);

context.IASetInputLayout([
  { semantic: 'POSITION', offset: 0,  format: 'FLOAT3' },
  { semantic: 'COLOR',    offset: 12, format: 'FLOAT4' },
]);
context.IASetVertexBuffers(0, [{ buffer: vb, stride: 28, offset: 0 }]);
context.VSSetShader(vs);
context.PSSetShader(ps);
context.RSSetState({ cullMode: 'BACK' });
context.OMSetDepthStencilState({ depthEnable: true, depthWriteEnable: true });
context.OMSetBlendState({ enabled: false });

// present() resolves when the frame is on the canvas; awaiting it paces the loop
// to the raster throughput instead of queueing frames up.
async function frame(tMs) {
  const t = tMs / 1000;
  const pulse = 0.75 + 0.25 * Math.sin(t * 2.0);

  context.VSSetConstantBuffer(0, { uPulse: pulse, uTime: t });
  context.ClearRenderTarget([0, 0, 0, 1]);
  context.ClearDepthStencil(1.0);
  context.Draw(3, 0);
  await context.present();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
