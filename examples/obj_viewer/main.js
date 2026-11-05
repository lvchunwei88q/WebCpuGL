// Example: multi-part OBJ model viewer, 3 separate shaders (body/face/hair).
// Run: node server.js  ->  http://localhost:8080/?example=obj_viewer

import { createDevice, loadShader, math } from '/webcpugl/index.js';
import { loadObj } from '/examples/_kit/ObjLoader.js';
import { Camera } from '/examples/_kit/Camera.js';
import { loadTexture } from '/examples/_kit/TextureLoader.js';
import { applyBloom } from '/examples/_kit/Bloom.js';

const OBJ_DIR = '/examples/obj_viewer/model/obj/';
const TEX_DIR = '/examples/obj_viewer/model/texture/';

// shader: 'body' | 'face' | 'hair'
const PARTS = [
  { obj: '脸.obj',    shader: 'face', d: 'T_NPC_036_face_d.png',    m: 'T_NPC_036_face_m.png',    r: 'T_NPC_036_face_r.png'   },
  { obj: '皮肤.obj',  shader: 'face', d: 'T_NPC_036_02_d.png',      m: 'T_NPC_036_02_m.png',      r: null                     },
  { obj: '眼睛.obj',  shader: 'body', d: 'T_NPC_036_eyes_d.png',    m: null,                      r: null                     },
  { obj: '头发.obj',  shader: 'hair', d: 'T_NPC_036_hair_01_d.png', m: 'T_NPC_036_hair_01_m.png', r: null                     },
  { obj: '头发2.obj', shader: 'hair', d: 'T_NPC_036_hair_02_d.png', m: 'T_NPC_036_hair_02_m.png', r: null                     },
  { obj: '装饰.obj',  shader: 'body', d: 'T_NPC_036_02_d.png',      m: 'T_NPC_036_02_m.png',      r: null                     },
  { obj: '裙子.obj',  shader: 'body', d: 'T_NPC_036_01_d.png',      m: 'T_NPC_036_01_m.png',      r: null                     },
];

const canvas = document.getElementById('view');
// Framebuffer size: defaults to 1920x1080. Change here if you want bigger.
const { device, context } = createDevice(canvas, 1920, 1080);
window.__gpu = context;

// ---- Camera ----
const camera = new Camera({
  position: [0, 0.8, 3],
  yaw: 0,
  pitch: -0.1,
  fovY: Math.PI / 3.5,
  speed: 2.0,
});
camera.aspect = context.fb.width / context.fb.height;
camera.attachFly(canvas);

// 1x1 white fallback texture
const whiteTex = device.createTexture(1, 1, new Uint8ClampedArray([255, 255, 255, 255]));

// ---- Shaders ----
const shaderModules = {
  body: await loadShader('/examples/obj_viewer/shaders/body.sd'),
  face: await loadShader('/examples/obj_viewer/shaders/face.sd'),
  hair: await loadShader('/examples/obj_viewer/shaders/hair.sd'),
};
const shaders = {};
for (const k in shaderModules) shaders[k] = device.createShaderPair(shaderModules[k]);

// ---- Load all parts ----
const parts = await Promise.all(PARTS.map(async (p) => {
  const obj = await loadObj(encodeURI(OBJ_DIR + p.obj));
  const d = await loadTexture(encodeURI(TEX_DIR + p.d), device);
  const m = p.m ? await loadTexture(encodeURI(TEX_DIR + p.m), device) : whiteTex;
  const r = p.r ? await loadTexture(encodeURI(TEX_DIR + p.r), device) : whiteTex;
  return {
    name: p.obj,
    kind: p.shader,
    vb: device.createBuffer({ usage: 'VERTEX', data: obj.vertexData }),
    ib: device.createBuffer({ usage: 'INDEX',  data: obj.indexData }),
    stride: obj.stride,
    indexCount: obj.indexData.length,
    d, m, r,
  };
}));

// ---- Pipeline state ----
context.IASetInputLayout([
  { semantic: 'POSITION', offset: 0,  format: 'FLOAT3' },
  { semantic: 'NORMAL',   offset: 12, format: 'FLOAT3' },
  { semantic: 'TEXCOORD', offset: 24, format: 'FLOAT2' },
]);
context.RSSetState({ cullMode: 'NONE' });
context.OMSetDepthStencilState({ depthEnable: true, depthWriteEnable: true });
context.OMSetBlendState({ enabled: false });

// ---- Light: orbits around the character ----
let lightAngle = 0;
const lightSpeed = 0.01;
const lightHeight = 0.6;

async function frame() {
  camera.update();
  lightAngle += lightSpeed;
  const lx = Math.sin(lightAngle), lz = Math.cos(lightAngle);
  const lLen = Math.hypot(lx, lz) || 1;
  const lightDir = [lx / lLen, lightHeight, lz / lLen];

  context.VSSetConstantBuffer(0, {
    uViewProj: camera.viewProj(),
    uModel:    math.identity(),
    uLightDir: lightDir,
  });
  context.ClearRenderTarget([0, 0, 0, 1]);
  context.ClearDepthStencil(1.0);

  for (const part of parts) {
    const s = shaders[part.kind];
    context.VSSetShader(s.vs);
    context.PSSetShader(s.ps);
    context.IASetVertexBuffers(0, [{ buffer: part.vb, stride: part.stride, offset: 0 }]);
    context.IASetIndexBuffer(part.ib, 'UINT16');
    context.PSSetShaderResource(0, part.d);
    context.PSSetShaderResource(1, part.m);
    context.PSSetShaderResource(2, part.r);
    context.DrawIndexed(part.indexCount, 0, 0);
  }

  // Awaiting present() is required to read fb.color/fb.depth after the frame:
  // with raster workers the pixels only land in the framebuffer when it resolves.
  await context.present();

  // applyBloom(context.fb.color, context.fb.width, context.fb.height, {
  //   threshold: 0.75, intensity: 0.6, levels: 3, blurSize: 2,
  // });

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
