// Minimal column-major mat4 / vec3 / vec4 helpers for shaders and demos.
// Matches the GLSL convention so users can translate GLSL math 1:1.

export function identity() {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

// Right-handed, looking down -Z. fovY in radians.
export function perspective(fovY, aspect, near, far) {
  const f = 1 / Math.tan(fovY / 2);
  const m = new Float32Array(16);
  m[0]  = f / aspect;
  m[5]  = f;
  m[10] = (far + near) / (near - far);
  m[11] = -1;
  m[14] = (2 * far * near) / (near - far);
  return m;
}

export function ortho(left, right, bottom, top, near, far) {
  const m = identity();
  m[0] = 2 / (right - left);
  m[5] = 2 / (top - bottom);
  m[10] = -2 / (far - near);
  m[12] = -(right + left) / (right - left);
  m[13] = -(top + bottom) / (top - bottom);
  m[14] = -(far + near) / (far - near);
  return m;
}

// out = a * b (column-major), where a is the left operand
export function multiply(a, b) {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c*4+r] =
        a[0*4+r] * b[c*4+0] +
        a[1*4+r] * b[c*4+1] +
        a[2*4+r] * b[c*4+2] +
        a[3*4+r] * b[c*4+3];
    }
  }
  return out;
}

export function translation(x, y, z) {
  const m = identity();
  m[12] = x; m[13] = y; m[14] = z;
  return m;
}

export function scaling(x, y, z) {
  const m = identity();
  m[0] = x; m[5] = y; m[10] = z;
  return m;
}

export function rotationX(rad) {
  const c = Math.cos(rad), s = Math.sin(rad);
  const m = identity();
  m[5] = c;  m[6] = s;
  m[9] = -s; m[10] = c;
  return m;
}

export function rotationY(rad) {
  const c = Math.cos(rad), s = Math.sin(rad);
  const m = identity();
  m[0] = c;   m[2] = -s;
  m[8] = s;   m[10] = c;
  return m;
}

export function rotationZ(rad) {
  const c = Math.cos(rad), s = Math.sin(rad);
  const m = identity();
  m[0] = c;  m[1] = s;
  m[4] = -s; m[5] = c;
  return m;
}

// m * v, v is [x,y,z,w]
export function transformVec4(m, v) {
  const x = v[0], y = v[1], z = v[2], w = v[3] ?? 1;
  return [
    m[0]*x + m[4]*y + m[8]*z  + m[12]*w,
    m[1]*x + m[5]*y + m[9]*z  + m[13]*w,
    m[2]*x + m[6]*y + m[10]*z + m[14]*w,
    m[3]*x + m[7]*y + m[11]*z + m[15]*w,
  ];
}

export function dot(a, b) {
  return a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
}

export function cross(a, b) {
  return [
    a[1]*b[2] - a[2]*b[1],
    a[2]*b[0] - a[0]*b[2],
    a[0]*b[1] - a[1]*b[0],
  ];
}

export function normalize(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0]/l, v[1]/l, v[2]/l];
}

// lookAt, right-handed, camera at eye looking at center
export function lookAt(eye, center, up) {
  const z = normalize([eye[0]-center[0], eye[1]-center[1], eye[2]-center[2]]);
  const x = normalize(cross(up, z));
  const y = cross(z, x);
  const m = identity();
  m[0]=x[0]; m[4]=x[1]; m[8]=x[2];  m[12]=-dot(x, eye);
  m[1]=y[0]; m[5]=y[1]; m[9]=y[2];  m[13]=-dot(y, eye);
  m[2]=z[0]; m[6]=z[1]; m[10]=z[2]; m[14]=-dot(z, eye);
  return m;
}

export default {
  identity, perspective, ortho, multiply,
  translation, scaling, rotationX, rotationY, rotationZ,
  transformVec4, dot, cross, normalize, lookAt,
};
