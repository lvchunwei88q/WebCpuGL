// Simple perspective camera with mouse-orbit control.

import * as math from '/webcpugl/math.js';

export class Camera {
  constructor({
    position = [0, 0, 3],
    target   = [0, 0, 0],
    up       = [0, 1, 0],
    fovY     = Math.PI / 3,
    near     = 0.1,
    far      = 100,
  } = {}) {
    this.position = position;
    this.target   = target;
    this.up       = up;
    this.fovY     = fovY;
    this.near     = near;
    this.far      = far;
    this.aspect   = 1;   // framebuffer is 256x256
  }

  view() {
    return math.lookAt(this.position, this.target, this.up);
  }

  proj() {
    return math.perspective(this.fovY, this.aspect, this.near, this.far);
  }

  viewProj() {
    return math.multiply(this.proj(), this.view());
  }

  // Orbit the camera around target by dragging the mouse.
  attachOrbit(canvas) {
    let dragging = false, lastX = 0, lastY = 0;
    let yaw = 0, pitch = 0.3;
    const radius = 3;

    const apply = () => {
      this.position = [
        radius * Math.sin(yaw) * Math.cos(pitch),
        radius * Math.sin(pitch),
        radius * Math.cos(yaw) * Math.cos(pitch),
      ];
    };
    apply();

    canvas.addEventListener('mousedown', (e) => {
      dragging = true; lastX = e.clientX; lastY = e.clientY;
    });
    window.addEventListener('mouseup',   () => { dragging = false; });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      yaw   += (e.clientX - lastX) * 0.01;
      pitch += (e.clientY - lastY) * 0.01;
      pitch = Math.max(-1.5, Math.min(1.5, pitch));
      lastX = e.clientX; lastY = e.clientY;
      apply();
    });
  }
}
