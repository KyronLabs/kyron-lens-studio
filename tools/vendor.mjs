#!/usr/bin/env node
// tools/vendor.mjs
//
// Copies the two files the renderer loads from outside its own directory.
//
// The window runs under a content security policy of `script-src 'self'`, so
// three has to be served from beside the page rather than from node_modules or
// a CDN -- and the face mesh has to be too, because `fetch` in the renderer is
// resolved against the page. Both copies are gitignored: they are build
// output, and the originals are the dependency and assets/face/.

import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const copies = [
  ['node_modules/three/build/three.module.js', 'src/app/vendor/three.module.js'],
  ['assets/face/canonical_face_model.obj', 'src/app/face/canonical_face_model.obj'],
  // Kyron's desktop tokens, consumed from the design system rather than
  // copied into this repository -- which is what that repository's README
  // says applications should do, and what the phone app already does through
  // the Flutter package.
  [
    'node_modules/kyron-design-system/desktop/tokens.css',
    'src/app/vendor/tokens.css',
  ],
];

for (const [from, to] of copies) {
  await mkdir(join(root, dirname(to)), { recursive: true });
  await copyFile(join(root, from), join(root, to));
  console.log(`${from} -> ${to}`);
}
