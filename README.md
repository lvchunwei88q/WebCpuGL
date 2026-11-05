# WebCpuGL

A tiny **DX11-style software rasterizer** running entirely on CPU inside the browser,
fronted by a Node static file server. The framebuffer is a fixed **256×256 RGBA8 +
Float32 depth** grid; the browser scales the canvas up to fit the window with
`image-rendering: pixelated`.

```
Node (static server, port 8080)
        │
        ▼
Browser ──► public/index.html
            bootstrap.js ── dynamic import ──► examples/<name>/main.js
                                                       │
                                                       ▼
                                              /webcpugl/*  (DX11-style API)
                                                       │
                                                       ▼
                                          CPU rasterizer → canvas 2D putImageData
```

## Run

```bash
npm start
# then open
http://localhost:8080/?example=triangle
http://localhost:8080/?example=textured_quad
```

Node version ≥ 18 (uses ESM).

## Project layout

```
WebCpuGL/
├── server.js                     # static file server
├── public/
│   ├── index.html                # page with the 256x256 <canvas>
│   ├── bootstrap.js              # reads ?example=, imports examples/<name>/main.js
│   └── webcpugl/                 # the graphics API (browser ESM)
│       ├── index.js
│       ├── Device.js             # createDevice, createBuffer/Shader/Texture
│       ├── DeviceContext.js      # immediate-mode context + rasterizer
│       ├── resources.js          # Buffer / Shader / Texture
│       ├── Framebuffer.js         # 256x256 color + depth
│       ├── ShaderLoader.js       # fetch .sd → Blob → dynamic import
│       └── math.js               # mat4 / vec3 helpers
└── examples/
    ├── triangle/                 # minimal colored triangle
    │   ├── main.js
    │   └── shader.sd
    └── textured_quad/            # indexed quad + texture + depth + blend
        ├── main.js
        └── shader.sd
```

## API cheat-sheet (DX11 immediate mode)

```js
import { createDevice, loadShader, math } from '/webcpugl/index.js';

const canvas = document.getElementById('view');
const { device, context } = createDevice(canvas, 256, 256);   // 256 is the FB resolution

// 1. Resources
const vb = device.createBuffer({ usage: 'VERTEX', data: new Float32Array([...]) });
const ib = device.createBuffer({ usage: 'INDEX',  data: new Uint16Array([...]) });
const shader = await loadShader('./shader.sd');               // .sd == plain ES Module
const { vs, ps } = device.createShaderPair(shader);
const tex = device.createTexture(W, H, rgbaUint8Clamped);       // or createTextureFromImage(img)

// 2. Bind pipeline state
context.IASetInputLayout([
  { semantic: 'POSITION', offset: 0,  format: 'FLOAT3' },
  { semantic: 'COLOR',    offset: 12, format: 'FLOAT4' },
]);
context.IASetVertexBuffers(0, [{ buffer: vb, stride: 28, offset: 0 }]);
context.IASetIndexBuffer(ib, 'UINT16');

context.VSSetShader(vs);
context.PSSetShader(ps);
context.VSSetConstantBuffer(0, { uMVP: mat4 });     // arbitrary JS object, handed to vs()
context.PSSetShaderResource(0, tex);               // accessible as samplers.t0 in fs()

context.RSSetState({ cullMode: 'BACK' });          // NONE | BACK | FRONT
context.OMSetDepthStencilState({ depthEnable: true, depthWriteEnable: true });
context.OMSetBlendState({ enabled: true });        // srcAlpha / 1-srcAlpha

// 3. Draw
context.ClearRenderTarget([r, g, b, a]);           // 0..1
context.ClearDepthStencil(1.0);
context.Draw(vertexCount, startVertexLocation);
context.DrawIndexed(indexCount, startIndex, baseVertex);
context.present();                                 // blits FB to the visible canvas
```

## Threads

Rasterization can be spread over Web Workers, one horizontal band each. Both paths
run through the same `RasterCore.js`, so the pixels are identical — only the thread
count changes.

```js
await context.whenReady();          // optional: let the pool boot first
context.setWorkerCount(8);          // clamped to 1..64, 1 = inline on the main thread
context.setParallelPolicy('auto');  // 'auto' (default) | 'always'
await context.present();            // worker mode: await before reading fb.color
```

`auto` is the useful default: a frame is only sent to the pool when it shades enough
pixels per triangle to pay for splitting the work. Scenes with tiny triangles and low
screen coverage (a 35k-triangle model covering ~7% of a 1080p frame, say) stay inline,
which is measurably faster than handing them to workers. `always` forces the pool and
is mainly useful for measuring.

In the browser you can drive both without touching the code:

```
?example=obj_viewer&workers=8          # auto policy
?example=obj_viewer&workers=8&policy=always
```

The HUD prints `threads <active>/<requested> (<mode>, cores <n>)`, so you can see which
path a frame actually took.

## Writing a `.sd` shader

A `.sd` file is **plain ES Module JavaScript** with a `.sd` extension. It must
export two functions. Inside it, import helpers via absolute paths:

```js
// examples/foo/shader.sd
import { transformVec4 } from '/webcpugl/math.js';

// input:    attributes pulled out of the vertex buffer per your inputLayout
//           e.g. input.position = [x,y,z,1], input.COLOR = [r,g,b,a]
// uniforms: whatever you passed to VSSetConstantBuffer(0, ...)
export function vs(input, uniforms) {
  const pos = transformVec4(uniforms.uMVP, input.position);
  return {
    position: pos,              // REQUIRED: clip-space [x,y,z,w]
    vColor: input.COLOR,        // any other field becomes a per-pixel varying
  };
}

// input:    perspective-correct interpolated varyings
// samplers: { t0: Texture, t1: Texture, ... }
export function fs(input, uniforms, samplers) {
  const c = samplers.t0.sample(input.vUV[0], input.vUV[1]);   // nearest, clamp
  return [c[0], c[1], c[2], 1.0];                             // 0..1 RGBA
}
```

## Conventions

- Matrices are column-major `Float32Array(16)` (GL convention).
- VS output `position` must be clip-space `[x,y,z,w]`; the rasterizer does
  `w`-divide, NDC→viewport, and perspective-correct varying interpolation.
- Backface culling follows DX11 default: **CW on screen = front**, CCW = back.
  (Because screen Y points down, the winding you type in the VB looks like CCW
  in math coordinates; the converter handles the flip.)
- Depth test is `LESS_EQUAL`, depth cleared to `1.0`.
- Blend when enabled is `srcAlpha / oneMinusSrcAlpha`.

## Writing your own example

Drop a new folder under `examples/<your_name>/`:

```
examples/my_demo/
├── main.js       # entry: imports /webcpugl, sets up pipeline, starts rAF
└── my.sd         # as many shader modules as you like
```

Then open `http://localhost:8080/?example=my_demo`.
