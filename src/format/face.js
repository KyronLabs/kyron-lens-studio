// src/format/face.js
//
// Turning a thing somebody dragged onto a face into the numbers a lens is
// written in, and back again.
//
// Every measurement in the lens format is in **pupil-gaps** -- multiples of
// the distance between the two pupils -- and not in pixels or in a fraction
// of the frame. kyron-lenses/docs/FORMAT.md explains why: that distance is
// the one measurement on a face that keeps meaning the same thing as the head
// turns. Across a 60-degree sweep of roll it moved 1.6%, while the box around
// the face changed shape entirely. So a width stated this way is right at any
// distance from the camera, on any face, at any resolution, with nothing to
// tune per device.
//
// Which is exactly why authoring by hand goes wrong: an artist works in
// pixels on a picture of a face, and the file wants pupil-gaps relative to an
// anchor, in a frame that rotates with the head. This module is that
// conversion, in both directions, and it is the reason the studio can be
// trusted to emit a lens that looks in the preview the way it looks on a
// phone.

/** The anchors a lens attachment may name. */
export const ANCHORS = ['eyes', 'nose', 'mouth', 'forehead', 'chin'];

/**
 * Where each anchor sits on a face, measured from the midpoint between the
 * pupils, in pupil-gaps, with the head upright.
 *
 * Positive y is down, matching screen coordinates and the app's own
 * convention. These come from the canonical MediaPipe face mesh the app
 * tracks with -- the same mesh `mediapipe_face_mesh` returns -- so a preview
 * built on them lines up with what the camera will do rather than with
 * somebody's idea of where a nose is.
 */
export const ANCHOR_OFFSETS = {
  eyes: { x: 0, y: 0 },
  forehead: { x: 0, y: -0.62 },
  nose: { x: 0, y: 0.52 },
  mouth: { x: 0, y: 0.95 },
  chin: { x: 0, y: 1.48 },
};

const DEG = 180 / Math.PI;

/**
 * What the studio knows about the face it is drawing on.
 *
 * Two pupils in pixels is everything: the gap between them is the unit, the
 * midpoint is the origin, and the angle between them is the head's roll.
 */
export class FaceFrame {
  /**
   * @param {{x: number, y: number}} leftPupil  the subject's left, screen-left
   * @param {{x: number, y: number}} rightPupil
   */
  constructor(leftPupil, rightPupil) {
    const dx = rightPupil.x - leftPupil.x;
    const dy = rightPupil.y - leftPupil.y;

    /** Pixels in one pupil-gap. The scale everything is divided by. */
    this.gap = Math.hypot(dx, dy);
    if (!(this.gap > 0)) {
      // Not an assert: this is reachable from a tracker that lost the face
      // mid-drag, and a zero here would silently produce Infinity widths.
      throw new RangeError('the pupils are in the same place, so there is no scale');
    }

    /** Degrees the head is rolled, clockwise on screen. */
    this.roll = Math.atan2(dy, dx) * DEG;

    /** The origin: halfway between the pupils. */
    this.origin = {
      x: (leftPupil.x + rightPupil.x) / 2,
      y: (leftPupil.y + rightPupil.y) / 2,
    };
  }

  /** Where an anchor is, in pixels on this face. */
  anchorAt(anchor) {
    const offset = ANCHOR_OFFSETS[anchor];
    if (!offset) throw new RangeError(`unknown anchor ${JSON.stringify(anchor)}`);
    return this.toPixels(offset.x, offset.y, { from: 'eyes' });
  }

  /** A point given in pupil-gaps from an anchor, as pixels on this face. */
  toPixels(x, y, { from = 'eyes' } = {}) {
    const base = ANCHOR_OFFSETS[from];
    if (!base) throw new RangeError(`unknown anchor ${JSON.stringify(from)}`);

    // Offsets rotate with the head, so a hat pushed "up" stays up when
    // somebody leans. That is the whole reason this is not a plain add.
    const radians = this.roll / DEG;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    const localX = (base.x + x) * this.gap;
    const localY = (base.y + y) * this.gap;

    return {
      x: this.origin.x + localX * cos - localY * sin,
      y: this.origin.y + localX * sin + localY * cos,
    };
  }

  /** A point in pixels, as pupil-gaps from an anchor. */
  toGaps(point, { from = 'eyes' } = {}) {
    const base = ANCHOR_OFFSETS[from];
    if (!base) throw new RangeError(`unknown anchor ${JSON.stringify(from)}`);

    const radians = -this.roll / DEG;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    const dx = point.x - this.origin.x;
    const dy = point.y - this.origin.y;

    return {
      x: (dx * cos - dy * sin) / this.gap - base.x,
      y: (dx * sin + dy * cos) / this.gap - base.y,
    };
  }
}

/**
 * The lens attachment for something placed on a face in the studio.
 *
 * `placement` is what the canvas knows: the centre of the artwork in pixels,
 * how wide it is in pixels, and how far it has been turned on screen.
 *
 * Returns the four numbers the format wants. Run the result through
 * `attachmentProblems` before publishing -- this does not clamp, deliberately:
 * a width of 40 pupil-gaps means somebody dragged something absurd, and
 * quietly making it 12 would publish a lens they did not draw.
 */
export function attachmentFor(face, anchor, placement, asset) {
  const centre = face.toGaps(placement.centre, { from: anchor });
  const rotation = round((placement.rotation ?? 0) - face.roll, 2);

  const attachment = {
    asset,
    anchor,
    width: round(placement.widthPx / face.gap, 4),
  };
  // Omitted when they are zero, because the format's defaults are zero and a
  // file full of `"offsetX": 0` is noise in a review.
  const offsetX = round(centre.x, 4);
  const offsetY = round(centre.y, 4);
  if (offsetX !== 0) attachment.offsetX = offsetX;
  if (offsetY !== 0) attachment.offsetY = offsetY;
  if (rotation !== 0) attachment.rotation = rotation;

  return attachment;
}

/**
 * Where an attachment lands on a given face: the inverse of [attachmentFor].
 *
 * This is what draws the preview, and it takes the numbers out of the lens
 * rather than out of the editor's own state -- so the preview is rendered
 * from the file that will be published, not from what the editor meant.
 */
export function placementFor(face, attachment) {
  const anchor = attachment.anchor;
  const centre = face.toPixels(attachment.offsetX ?? 0, attachment.offsetY ?? 0, {
    from: anchor,
  });
  return {
    centre,
    widthPx: attachment.width * face.gap,
    rotation: (attachment.rotation ?? 0) + face.roll,
  };
}

/** Half-even would be nicer; this is what JSON readers do anyway. */
function round(value, places) {
  const scale = 10 ** places;
  // `+ 0` turns -0 into 0, so an offset that rounds to nothing is omitted
  // rather than written as `-0`.
  return Math.round(value * scale) / scale + 0;
}
