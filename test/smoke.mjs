// Headless smoke test: mock DOM bits, drive the real rasterizer, check pixels.
// Run: node test/smoke.mjs

globalThis.ImageData = class {
  constructor(w, h) { this.width = w; this.height = h; this.data = new Uint8ClampedArray(w*h*4); }
};
globalThis.document = { createElement: () => ({ getContext: () => ({}) }) };

const { createDevice, loadShader, math } = await import('../public/webcpugl/index.js');

// We don't need real shader loading (fetch). Build a fake .sd module by hand.
const fakeVs = (input, uniforms) => {
  const pos = math.transformVec4(uniforms.uMVP, input.POSITION);
  return { position: pos, vColor: input.COLOR };
};
const fakeFs = (input) => input.vColor;

const fakeCanvas = {
  width: 256, height: 256,
  getContext: () => ({ putImageData: () => {} }),
};

const { device, context } = createDevice(fakeCanvas);

const verts = new Float32Array([
   0.0,  0.7, 0,  1, 0, 0, 1,
   0.7, -0.6, 0,  0, 0, 1, 1,
  -0.7, -0.6, 0,  0, 1, 0, 1,
]);
const vb = device.createBuffer({ usage: 'VERTEX', data: verts });
const vs = device.createVertexShader(fakeVs);
const ps = device.createPixelShader(fakeFs);

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

context.VSSetConstantBuffer(0, { uMVP: math.identity() });
context.ClearRenderTarget([0.04, 0.04, 0.08, 1]);
context.ClearDepthStencil(1.0);
context.Draw(3, 0);

// ---- Count colored pixels (i.e. not background) ----
const bg = [Math.round(0.04*255), Math.round(0.04*255), Math.round(0.08*255)];
let painted = 0;
let sampleR = 0, sampleG = 0, sampleB = 0;
for (let i = 0; i < 256*256; i++) {
  const o = i*4;
  if (context.fb.color[o]   !== bg[0] ||
      context.fb.color[o+1] !== bg[1] ||
      context.fb.color[o+2] !== bg[2]) {
    painted++;
    if (painted === 1000) {
      sampleR = context.fb.color[o];
      sampleG = context.fb.color[o+1];
      sampleB = context.fb.color[o+2];
    }
  }
}
console.log('painted pixels:', painted, '/', 256*256);
console.log('sample color at a painted pixel:', sampleR, sampleG, sampleB);

if (painted < 500) {
  console.error('FAIL: triangle did not cover enough pixels.');
  process.exit(1);
}
console.log('OK');
