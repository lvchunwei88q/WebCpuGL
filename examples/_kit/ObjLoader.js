// Minimal OBJ loader. Supports: v, vt, vn, f (triangles + ngon fan-triangulated).
// Outputs interleaved vertex data: POSITION(3) + NORMAL(3) + TEXCOORD(2), stride 32 bytes.

export function parseObj(text) {
  const positions = [];
  const uvs = [];
  const normals = [];
  const verts = [];  // flat: [x,y,z, nx,ny,nz, u,v, ...]
  const indices = [];
  const keyMap = new Map();

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    const tag = parts[0];

    if (tag === 'v') {
      positions.push([+parts[1], +parts[2], +parts[3]]);
    } else if (tag === 'vt') {
      uvs.push([+parts[1], +parts[2]]);
    } else if (tag === 'vn') {
      normals.push([+parts[1], +parts[2], +parts[3]]);
    } else if (tag === 'f') {
      const face = [];
      for (let i = 1; i < parts.length; i++) {
        const slashes = parts[i].split('/');
        const v  = parseInt(slashes[0], 10);
        const vt = slashes[1] ? parseInt(slashes[1], 10) : 0;
        const vn = slashes[2] ? parseInt(slashes[2], 10) : 0;
        const key = v + '/' + vt + '/' + vn;
        let idx = keyMap.get(key);
        if (idx === undefined) {
          idx = verts.length / 8;
          keyMap.set(key, idx);
          const p  = positions[v - 1]  || [0, 0, 0];
          const uv = vt ? uvs[vt - 1]   : [0, 0];
          const n  = vn ? normals[vn - 1] : [0, 1, 0];
          verts.push(p[0], p[1], p[2], n[0], n[1], n[2], uv[0], uv[1]);
        }
        face.push(idx);
      }
      // fan triangulation
      for (let i = 1; i + 1 < face.length; i++) {
        indices.push(face[0], face[i], face[i + 1]);
      }
    }
  }

  return {
    vertexData: new Float32Array(verts),
    indexData:  new Uint16Array(indices),
    stride: 32,
  };
}

export async function loadObj(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('loadObj: failed to fetch ' + url + ' (' + res.status + ')');
  return parseObj(await res.text());
}
