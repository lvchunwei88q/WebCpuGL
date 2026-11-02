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
