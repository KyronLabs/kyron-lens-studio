import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import * as THREE from '../../src/app/vendor/three.module.js';
import { frameOf, localIn } from '../../src/app/plane.js';
import { rotationFromDrag } from '../../src/app/gesture.js';

/** A camera ray straight down -z through a world point, as the studio's is. */
const rayAt = (x, y) =>
  new THREE.Ray(new THREE.Vector3(x, y, 50), new THREE.Vector3(0, 0, -1));

/** An attachment sitting where the studio would put one. */
function attachment({ x = 0, y = 0, z = 0, degrees = 0, headTurn = 0 } = {}) {
  const head = new THREE.Group();
  head.rotation.y = headTurn;

  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(4, 2),
    new THREE.MeshBasicMaterial(),
  );
  mesh.position.set(x, y, z);
  // The sign viewport.js uses: the format counts clockwise, three does not.
  mesh.rotation.z = (-degrees * Math.PI) / 180;
  head.add(mesh);
  head.updateMatrixWorld(true);
  return mesh;
}

describe('the plane a drag runs in', () => {
  it('reads the cursor in the attachment_s own coordinates', () => {
    const mesh = attachment({ x: 3, y: -1 });
    const local = localIn(frameOf(mesh), rayAt(5, -1));
    assert.ok(local);
    // Two units to the right of a centre that is itself at x = 3.
    assert.ok(Math.abs(local.x - 2) < 1e-9);
    assert.ok(Math.abs(local.y - 0) < 1e-9);
  });

  it('divides out the rotation, so a corner stays a corner', () => {
    // Turned a quarter clockwise, the corner that was at local (2, 1) is at
    // world (1, -2) from the centre. Read back, it is (2, 1) again.
    const mesh = attachment({ degrees: 90 });
    const local = localIn(frameOf(mesh), rayAt(1, -2));
    assert.ok(local);
    assert.ok(Math.abs(local.x - 2) < 1e-9, `x was ${local.x}`);
    assert.ok(Math.abs(local.y - 1) < 1e-9, `y was ${local.y}`);
  });

  it('gives up when the head is edge-on', () => {
    // A quarter turn puts the plane parallel to the camera ray.
    //
    // three's own check is not enough, which is the reason this test exists:
    // it refuses only an *exactly* parallel ray, and at 90 degrees the
    // denominator comes out around 2e-16 rather than 0. Left to it, a cursor
    // one unit off centre reads as 4.5e15 units into the plane, and a corner
    // drag writes that as the width.
    const mesh = attachment({ headTurn: Math.PI / 2 });
    assert.equal(localIn(frameOf(mesh), rayAt(1, 0)), null);

    // And it has to bite before then, not only at exactly 90: at 88 degrees
    // the same cursor reads as 29 units out.
    assert.equal(
      localIn(frameOf(attachment({ headTurn: (88 * Math.PI) / 180 })), rayAt(1, 0)),
      null,
    );
  });

  it('still reads a face turned as far as anybody turns one', () => {
    // The guard has to refuse edge-on without refusing a normal three-quarter
    // view. viewport.js clamps the head to +/-0.9 radians, about 52 degrees.
    const mesh = attachment({ headTurn: 0.9 });
    assert.ok(localIn(frameOf(mesh), rayAt(1, 0)));
    // A three-quarter view at 80 degrees is steep but still somebody's
    // deliberate drag, and is let through.
    assert.ok(
      localIn(frameOf(attachment({ headTurn: (80 * Math.PI) / 180 })), rayAt(1, 0)),
    );
  });
});

describe('a drag measured against the frame it started in', () => {
  it('keeps measuring the drag after the sprite is rebuilt', () => {
    // What happens in the app: the rotate handle moves, the app writes the
    // new rotation, and setLens rebuilds the sprite at that rotation. The
    // next pointermove arrives against a plane that has already turned.
    let rotation = 0;
    const captured = frameOf(attachment({ degrees: rotation }));

    const grabPoint = localIn(captured, rayAt(0, 1)); // handle straight up
    const grab = { x: grabPoint.x, y: grabPoint.y };

    // Four steps of a drag, each rebuilding the sprite as the app does.
    const path = [
      [0.38, 0.92],
      [0.71, 0.71],
      [0.92, 0.38],
      [1, 0],
    ];
    for (const [x, y] of path) {
      const at = localIn(captured, rayAt(x, y));
      rotation = rotationFromDrag({ grab, at, rotation: 0 });
    }

    // The handle was dragged from straight up round to the right: a quarter
    // turn clockwise, which the format counts as +90.
    assert.ok(Math.abs(rotation - 90) < 0.5, `rotation came out ${rotation}`);
  });

  it('agrees with re-reading the frame every move', () => {
    // Worth having on the record, because the obvious argument for capturing
    // the frame -- that re-reading it would compare the plane's angle to
    // itself and never move -- is wrong. The plane's rotation appears on both
    // sides and cancels, so the two land in the same place. The capture is
    // kept for being one fixed reference rather than for fixing this.
    const path = [[0.38, 0.92], [0.71, 0.71], [0.92, 0.38], [1, 0]];
    const grab = { x: 0, y: 1 };

    let captured = 0;
    const frame = frameOf(attachment({ degrees: 0 }));
    for (const [x, y] of path) {
      captured = rotationFromDrag({
        grab,
        at: localIn(frame, rayAt(x, y)),
        rotation: 0,
      });
    }

    let live = 0;
    for (const [x, y] of path) {
      live = rotationFromDrag({
        grab,
        at: localIn(frameOf(attachment({ degrees: live })), rayAt(x, y)),
        rotation: live,
      });
    }

    assert.ok(
      Math.abs(captured - live) < 1e-6,
      `captured ${captured} against live ${live}`,
    );
  });

  it('does not drift when the app rounds what it writes back', () => {
    // The app writes rotations to two places, as attachmentFor does. Each
    // move reads back a slightly different number than the viewport
    // computed, and a drag is a few hundred of them.
    const frame = frameOf(attachment({ degrees: 0 }));
    const grab = { x: 0, y: 1 };
    let rotation = 0;

    for (let step = 0; step <= 180; step++) {
      const turn = (Math.PI / 2) * (step / 180);
      const at = localIn(frame, rayAt(Math.sin(turn), Math.cos(turn)));
      rotation = rotationFromDrag({ grab, at, rotation: 0 });
      rotation = Math.round(rotation * 100) / 100;
    }

    assert.ok(Math.abs(rotation - 90) < 0.01, `ended at ${rotation}`);
  });
});
