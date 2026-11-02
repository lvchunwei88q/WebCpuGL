// Frontend bootstrap: read ?example=<name>, then dynamically import
// /examples/<name>/main.js. That module is the user-written entry point and
// owns the whole render loop.

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

// ---- debug HUD ----
const hud = document.getElementById('hud');
setInterval(() => {
  const ctx = window.__gpu;
  if (!ctx || !ctx.lastFrame) return;
  const s = ctx.lastFrame;
  hud.textContent =
    `WebCpuGL  ${(s.fps || 0).toFixed(0)} fps  ${(s.frameMs || 0).toFixed(2)} ms\n` +
    `draws=${s.drawCalls}  tris=${s.triangles}  culled=${s.culled}  px=${s.pixels}`;
}, 250);

// ---- HUD: poll window.__gpu.lastFrame every 250ms ----
setInterval(() => {
  const ctx = window.__gpu;
  if (!ctx || !ctx.lastFrame) return;
  const s = ctx.lastFrame;
  hud.textContent =
    `WebCpuGL  ${s.fps ? s.fps.toFixed(0)+' fps' : '--'}\n` +
    `${(s.frameMs||0).toFixed(2)} ms/frame\n` +
    `draws ${s.drawCalls}   tris ${s.triangles}   culled ${s.culled}\n` +
    `shaded px ${s.pixels} / ${256*256}`;
}, 250);
