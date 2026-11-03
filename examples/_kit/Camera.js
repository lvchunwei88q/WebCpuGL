// First-person fly camera: WASD + QE for up/down, mouse look (pointer lock).
// Click the canvas to grab the mouse, Esc to release.

import * as math from '/webcpugl/math.js';

export class Camera {
  constructor({
    position = [0, 0, 3],
    yaw     = 0,          // radians, around Y
    pitch   = 0,          // radians, around X
    fovY    = Math.PI / 3,
    near    = 0.1,
    far     = 100,
    speed   = 2.0,        // m/s
  } = {}) {
    this.position = position;
    this.yaw = yaw;
    this.pitch = pitch;
    this.fovY = fovY;
    this.near = near;
    this.far  = far;
    this.aspect = 1;
    this.speed = speed;
    this._keys = Object.create(null);
    this._lastT = 0;
  }

  // forward direction (on XZ plane) for movement
  _forward() {
    return [Math.sin(this.yaw), 0, -Math.cos(this.yaw)];
  }
  _right() {
    return [Math.cos(this.yaw), 0, Math.sin(this.yaw)];
  }

  view() {
    // build eye position + target from yaw/pitch
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const cy = Math.cos(this.yaw),   sy = Math.sin(this.yaw);
    const dir = [sy * cp, sp, -cy * cp];
    const target = [
      this.position[0] + dir[0],
      this.position[1] + dir[1],
      this.position[2] + dir[2],
    ];
    return math.lookAt(this.position, target, [0, 1, 0]);
  }

  proj() {
    return math.perspective(this.fovY, this.aspect, this.near, this.far);
  }

  viewProj() {
    return math.multiply(this.proj(), this.view());
  }

  // Call once per frame; moves position based on held keys.
  update() {
    const now = performance.now();
    const dt = this._lastT ? (now - this._lastT) / 1000 : 0;
    this._lastT = now;

    const f = this._forward(), r = this._right();
    const s = this.speed * dt;
    const k = this._keys;
    const move = [0, 0, 0];

    if (k['KeyW']) { move[0] += f[0]; move[2] += f[2]; }
    if (k['KeyS']) { move[0] -= f[0]; move[2] -= f[2]; }
    if (k['KeyD']) { move[0] += r[0]; move[2] += r[2]; }
    if (k['KeyA']) { move[0] -= r[0]; move[2] -= r[2]; }
    if (k['KeyE'] || k['Space']) move[1] += 1;
    if (k['KeyQ'] || k['ShiftLeft']) move[1] -= 1;

    const len = Math.hypot(move[0], move[1], move[2]);
    if (len > 0) {
      this.position = [
        this.position[0] + (move[0] / len) * s,
        this.position[1] + (move[1] / len) * s,
        this.position[2] + (move[2] / len) * s,
      ];
    }
  }

  // Click canvas to lock pointer; mouse moves yaw/pitch.
  attachFly(canvas) {
    canvas.addEventListener('click', () => {
      canvas.requestPointerLock();
    });
    document.addEventListener('mousemove', (e) => {
      if (document.pointerLockElement !== canvas) return;
      const sens = 0.0025;
      this.yaw   += e.movementX * sens;
      this.pitch -= e.movementY * sens;
      this.pitch = Math.max(-1.55, Math.min(1.55, this.pitch));
    });
    window.addEventListener('keydown', (e) => { this._keys[e.code] = true; });
    window.addEventListener('keyup',   (e) => { this._keys[e.code] = false; });
  }
}
