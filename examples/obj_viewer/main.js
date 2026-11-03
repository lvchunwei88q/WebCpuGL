// Example: multi-part OBJ model viewer (face character).
// Run: node server.js  ->  http://localhost:8080/?example=obj_viewer

import { createDevice, loadShader, math } from '/webcpugl/index.js';
import { loadObj } from '/examples/_kit/ObjLoader.js';
import { Camera } from '/examples/_kit/Camera.js';
import { loadTexture } from '/examples/_kit/TextureLoader.js';

const OBJ_DIR  = '/examples/obj_viewer/model/obj/';
const TEX_DIR  = '/examples/obj_viewer/model/texture/';

// obj file -> texture file mapping
const PARTS = [
  { obj: '脸.obj',    tex: 'T_NPC_036_face_d.png'   },
  { obj: '皮肤.obj',  tex: 'T_NPC_036_02_d.png'   },
  { obj: '眼睛.obj',  tex: 'T_NPC_036_eyes_d.png'   },
  { obj: '头发.obj',  tex: 'T_NPC_036_hair_01_d.png' },
  { obj: '头发2.obj', tex: 'T_NPC_036_hair_02_d.png' },
  { obj: '装饰.obj',  tex: 'T_NPC_036_02_d.png'     },
  { obj: '裙子.obj',  tex: 'T_NPC_036_01_d.png'     },
];

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

// ---- Load all parts in parallel ----
const parts = await Promise.all(PARTS.map(async (p) => {
  const obj = await loadObj(encodeURI(OBJ_DIR + p.obj));
  const tex = await loadTexture(encodeURI(TEX_DIR + p.tex), device);
  return {
    name: p.obj,
    vb: device.createBuffer({ usage: 'VERTEX', data: obj.vertexData }),
    ib: device.createBuffer({ usage: 'INDEX',  data: obj.indexData }),
    stride: obj.stride,
    indexCount: obj.indexData.length,
    tex,
  };
}));

// ---- Shader ----
const shader = await loadShader('/examples/obj_viewer/shader.sd');
const { vs, ps } = device.createShaderPair(shader);

// ---- Pipeline state (shared across parts) ----
context.IASetInputLayout([
  { semantic: 'POSITION', offset: 0,  format: 'FLOAT3' },
  { semantic: 'NORMAL',   offset: 12, format: 'FLOAT3' },
  { semantic: 'TEXCOORD', offset: 24, format: 'FLOAT2' },
]);
context.VSSetShader(vs);
context.PSSetShader(ps);
context.RSSetState({ cullMode: 'NONE' });
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

  for (const part of parts) {
    context.IASetVertexBuffers(0, [{ buffer: part.vb, stride: part.stride, offset: 0 }]);
    context.IASetIndexBuffer(part.ib, 'UINT16');
    context.PSSetShaderResource(0, part.tex);
    context.DrawIndexed(part.indexCount, 0, 0);
  }

  context.present();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
