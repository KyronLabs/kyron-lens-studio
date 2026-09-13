// src/app/paint.js
//
// The canvas, which is where a sticker starts.
//
// Deliberately small. This is not a drawing application and will not become
// one -- somebody who wants layers and pressure curves has one already, and
// the Import button takes its output. What this is for is the twenty seconds
// between "a star on the forehead" and seeing a star on a forehead, which is
// the loop the whole tool is about.
//
// The one thing it does insist on: transparency. A sticker with an opaque
// background is a rectangle stuck to somebody's face, and it is the single
// most common way a first lens comes out wrong. The canvas starts empty and
// stays empty everywhere nothing has been painted.

export class Paint {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    this.context = canvas.getContext('2d', { willReadFrequently: true });
    this.context.lineCap = 'round';
    this.context.lineJoin = 'round';

    this.colour = '#17d1b0';
    this.size = 14;
    this.erasing = false;

    this._drawing = false;
    this._wire();
  }

  _wire() {
    const at = (event) => {
      const rect = this.canvas.getBoundingClientRect();
      return {
        x: ((event.clientX - rect.left) / rect.width) * this.canvas.width,
        y: ((event.clientY - rect.top) / rect.height) * this.canvas.height,
      };
    };

    this.canvas.addEventListener('pointerdown', (event) => {
      this.canvas.setPointerCapture(event.pointerId);
      this._drawing = true;
      const point = at(event);
      this.context.beginPath();
      this.context.moveTo(point.x, point.y);
      // A tap is a dot. Without this, clicking without moving paints nothing,
      // which reads as the tool being broken.
      this._stroke(point, point);
    });

    this.canvas.addEventListener('pointermove', (event) => {
      if (!this._drawing) return;
      const point = at(event);
      this._stroke(point, point);
    });

    const stop = (event) => {
      this.canvas.releasePointerCapture?.(event.pointerId);
      this._drawing = false;
    };
    this.canvas.addEventListener('pointerup', stop);
    this.canvas.addEventListener('pointercancel', stop);
  }

  _stroke(from, to) {
    const context = this.context;
    context.lineWidth = this.size;
    // `destination-out` rather than painting the background colour: this
    // canvas has no background, and erasing has to take alpha away rather
    // than add opaque pixels that look like a hole until it is published.
    context.globalCompositeOperation = this.erasing ? 'destination-out' : 'source-over';
    context.strokeStyle = this.colour;
    context.lineTo(to.x, to.y);
    context.stroke();
    context.beginPath();
    context.moveTo(to.x, to.y);
  }

  clear() {
    this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /** Whether anything has been painted at all. */
  get isEmpty() {
    const { data } = this.context.getImageData(
      0, 0, this.canvas.width, this.canvas.height,
    );
    for (let at = 3; at < data.length; at += 4) {
      if (data[at] !== 0) return false;
    }
    return true;
  }

  /**
   * The painting, cropped to what was actually drawn.
   *
   * Cropped because a width in the lens format is the width of the *picture*,
   * and a star drawn small in the middle of a 512-pixel canvas would be
   * published as a mostly-empty image -- so a width of two pupil-gaps would
   * put a star about a third of that across the face, and nothing would say
   * why.
   *
   * Returns null when nothing has been painted.
   */
  toResource(name) {
    const bounds = this._bounds();
    if (!bounds) return null;

    const cropped = document.createElement('canvas');
    cropped.width = bounds.width;
    cropped.height = bounds.height;
    cropped
      .getContext('2d')
      .drawImage(
        this.canvas,
        bounds.x, bounds.y, bounds.width, bounds.height,
        0, 0, bounds.width, bounds.height,
      );

    return {
      name,
      bytes: cropped.toDataURL('image/png'),
      width: bounds.width,
      height: bounds.height,
    };
  }

  /** The box around every pixel with any alpha in it. */
  _bounds() {
    const { width, height } = this.canvas;
    const { data } = this.context.getImageData(0, 0, width, height);

    let top = height;
    let left = width;
    let right = -1;
    let bottom = -1;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (data[(y * width + x) * 4 + 3] === 0) continue;
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
    }
    if (right < 0) return null;

    // A couple of pixels of air, so a stroke's own antialiasing is not cut
    // off at the edge of the file.
    const pad = 2;
    left = Math.max(0, left - pad);
    top = Math.max(0, top - pad);
    right = Math.min(width - 1, right + pad);
    bottom = Math.min(height - 1, bottom + pad);

    return {
      x: left,
      y: top,
      width: right - left + 1,
      height: bottom - top + 1,
    };
  }
}
