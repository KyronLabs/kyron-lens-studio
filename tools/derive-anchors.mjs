// tools/derive-anchors.mjs
//
// Where each anchor sits on a face, measured off the canonical mesh rather
// than estimated.
//
// The first version of ANCHOR_OFFSETS was four numbers somebody sensible
// wrote down, and they were wrong -- the chin by 0.43 pupil-gaps, which is
// most of an eye-spacing and about two and a half centimetres on a real face.
// A lens anchored to the chin would have sat visibly low and nothing would
// have said why.
//
//     node tools/derive-anchors.mjs
//
// Prints the table. `npm test` re-derives it and fails if src/format/face.js
// has drifted, so the constants there are checked data rather than
// remembered data.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// One definition of where the landmarks are, shared with the studio's 3D
// viewport. Two would drift, and the drift would be invisible until a lens
// was on somebody's face.
export { LANDMARKS, pupilsFrom } from '../src/format/face.js';
import { CANONICAL_VERTICES, LANDMARKS, pupilsFrom } from '../src/format/face.js';

const MODEL = new URL('../assets/face/canonical_face_model.obj', import.meta.url);

/** Every `v` line of the canonical model, in order. */
export function readVertices(path = fileURLToPath(MODEL)) {
  const vertices = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.startsWith('v ')) continue;
    const [x, y, z] = line.split(/\s+/).slice(1, 4).map(Number);
    vertices.push({ x, y, z });
  }
  if (vertices.length !== CANONICAL_VERTICES) {
    throw new Error(
      `expected ${CANONICAL_VERTICES} vertices, read ${vertices.length}`,
    );
  }
  return vertices;
}

const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 });

/**
 * The anchor table: each anchor in pupil-gaps from the pupil midpoint, with
 * y positive downwards to match the screen and the format.
 */
export function deriveAnchors(vertices = readVertices()) {
  const v = (i) => vertices[i];
  const { left, right, gap } = pupilsFrom(vertices);
  const origin = mid(left, right);
  // The model is y-up; the format and the screen are y-down.
  const gaps = (p) => ({
    x: round((p.x - origin.x) / gap),
    y: round(-(p.y - origin.y) / gap),
  });

  return {
    eyes: gaps(origin),
    forehead: gaps(v(LANDMARKS.forehead)),
    nose: gaps(v(LANDMARKS.noseTip)),
    mouth: gaps(mid(v(LANDMARKS.lipTop), v(LANDMARKS.lipBottom))),
    chin: gaps(v(LANDMARKS.chin)),
  };
}

/** Four places: a thousandth of a pupil-gap is well under a pixel. */
const round = (n) => Math.round(n * 1e4) / 1e4 + 0;

if (import.meta.url === `file://${process.argv[1]}`) {
  const anchors = deriveAnchors();
  for (const [name, { x, y }] of Object.entries(anchors)) {
    console.log(`  ${name}: { x: ${x}, y: ${y} },`);
  }
}
