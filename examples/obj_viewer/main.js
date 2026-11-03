// Example: OBJ model viewer with procedural texture + orbit camera.
// Run: node server.js  ->  http://localhost:8080/?example=obj_viewer

import { createDevice, loadShader, math } from '/webcpugl/index.js';
import { loadObj } from '/examples/_kit/ObjLoader.js';
import { Camera } from '/examples/_kit/Camera.js';
import { loadTexture } from '/examples/_kit/TextureLoader.js';

const canvas = document.getElementById('view');
const { device, context } = createDevice(canvas);
window.__gpu = context;

// ---- Camera ----
const camera = new Camera({
  position: [0, 0.8, 3],
  yaw: 0,
  pitch: -0.1,
  fovY: Math.PI / 3.5,
  speed: 2.0,
});
camera.attachFly(canvas);

// ---- OBJ ----
const obj = await loadObj('/examples/obj_viewer/model/obj/脸.obj');
const vb = device.createBuffer({ usage: 'VERTEX', data: obj.vertexData });
const ib = device.createBuffer({ usage: 'INDEX',  data: obj.indexData });

// ---- Procedural checker texture (no external file needed) ----
const TW = 64, TH = 64;
const texData = new Uint8ClampedArray(TW * TH * 4);
for (let y = 0; y < TH; y++) {
  for (let x = 0; x < TW; x++) {
    const i = (y * TW + x) * 4;
    const on = (((x >> 3) + (y >> 3)) & 1) === 0;
    texData[i]     = on ? 220 :  40;
    texData[i + 1] = on ? 120 :  60;
    texData[i + 2] = on ?  80 : 140;
    texData[i + 3] = 255;
  }
}
const checker = device.createTexture(TW, TH, texData);
// You could also do: const checker = await loadTexture('/examples/obj_viewer/foo.png', device);

// ---- Shader ----
const shader = await loadShader('/examples/obj_viewer/shader.sd');
const { vs, ps } = device.createShaderPair(shader);

// ---- Pipeline state ----
context.IASetInputLayout([
  { semantic: 'POSITION', offset: 0,  format: 'FLOAT3' },
  { semantic: 'NORMAL',   offset: 12, format: 'FLOAT3' },
  { semantic: 'TEXCOORD', offset: 24, format: 'FLOAT2' },
]);
context.IASetVertexBuffers(0, [{ buffer: vb, stride: obj.stride, offset: 0 }]);
context.IASetIndexBuffer(ib, 'UINT16');
context.VSSetShader(vs);
context.PSSetShader(ps);
context.PSSetShaderResource(0, checker);
context.RSSetState({ cullMode: 'BACK' });
context.OMSetDepthStencilState({ depthEnable: true, depthWriteEnable: true });
context.OMSetBlendState({ enabled: false });

function frame() {
  camera.update();
  context.VSSetConstantBuffer(0, {
    uViewProj: camera.viewProj(),
    uModel:    math.identity(),
  });
  context.ClearRenderTarget([0, 0, 0, 1]);
  context.ClearDepthStencil(1.0);
  context.DrawIndexed(obj.indexData.length, 0, 0);
  context.present();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
