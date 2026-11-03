// Load an image URL as a WebCpuGL Texture.
// Usage: const tex = await loadTexture('/examples/foo/bar.png', device);

export async function loadTexture(url, device) {
  const img = new Image();
  await new Promise((resolve, reject) => {
    img.onload  = resolve;
    img.onerror = () => reject(new Error('loadTexture: failed to load ' + url));
    img.src = url;
  });
  return device.createTextureFromImage(img);
}
