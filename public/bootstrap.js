// Frontend bootstrap: read ?example=<name>, then dynamically import
// /examples/<name>/main.js. That module is the user-written entry point and
// owns the whole render loop.
//
// Query params:
//   ?example=<name>   which example to load (default: triangle)
//   ?workers=<n>      raster thread count, clamped to 1..64 (default: auto)

const params = new URLSearchParams(location.search);
const example = params.get('example') || 'triangle';

const errBox = document.getElementById('err');
window.addEventListener('error', (e) => {
  errBox.style.display = 'block';
  errBox.textContent = `Error: ${e.message}\n${e.error?.stack || ''}`;
});
window.addEventListener('unhandledrejection', (e) => {
  errBox.style.display = 'block';
  errBox.textContent = `Unhandled rejection: ${e.reason?.stack || e.reason}`;
});

try {
  await import(`/examples/${example}/main.js`);
} catch (e) {
  errBox.style.display = 'block';
  errBox.textContent = `Failed to load example "${example}":\n${e.stack || e}`;
}

// ---- raster thread count ----
// The example has already built its device (window.__gpu) but has not drawn a
// frame yet, so this runs before the first present().
const workersParam = params.get('workers');
if (window.__gpu && workersParam !== null) {
  const n = window.__gpu.setWorkerCount(parseInt(workersParam, 10));
  console.log(`[WebCpuGL] raster threads requested: ${workersParam} -> active ${n}`);
}

// ?policy=always forces every frame onto the pool; default 'auto' keeps
// low-coverage frames inline where packing would cost more than it saves.
const policyParam = params.get('policy');
if (window.__gpu && policyParam !== null && window.__gpu.setParallelPolicy) {
  const p = window.__gpu.setParallelPolicy(policyParam);
  console.log(`[WebCpuGL] parallel policy: ${p}`);
}

// ---- debug HUD ----
const hud = document.getElementById('hud');
setInterval(() => {
  const ctx = window.__gpu;
  if (!ctx || !ctx.lastFrame) return;
  const s = ctx.lastFrame;
  const w = s.workers || { requested: 1, active: 1, cores: 0 };
  const totalPx = (ctx.fb ? ctx.fb.width * ctx.fb.height : 0);
  const mode = w.mode || 'inline';
  hud.textContent =
    `WebCpuGL  ${s.fps ? s.fps.toFixed(0) + ' fps' : '--'}  ${(s.frameMs || 0).toFixed(2)} ms\n` +
    `${ctx.fb ? ctx.fb.width + 'x' + ctx.fb.height : ''}  threads ${w.active}/${w.requested} (${mode}, cores ${w.cores})\n` +
    `draws ${s.drawCalls}   tris ${s.triangles}   culled ${s.culled}\n` +
    `shaded px ${s.pixels} / ${totalPx}`;
}, 250);
