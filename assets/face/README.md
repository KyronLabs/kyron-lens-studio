# The canonical face

`canonical_face_model.obj` is MediaPipe's canonical face model: 468 vertices,
468 texture coordinates, 898 triangles.

    https://github.com/google-ai-edge/mediapipe
    mediapipe/modules/face_geometry/data/canonical_face_model.obj

Copyright 2020 The MediaPipe Authors, licensed under the Apache License,
Version 2.0 — <http://www.apache.org/licenses/LICENSE-2.0>. Vendored
unmodified.

## Why this mesh and not a nicer one

It is the mesh the Kyron app tracks with. `mediapipe_face_mesh` returns
landmarks indexed into exactly this topology, and `kyron-lenses/tools/face.py`
names the indices the format's anchors are derived from — 33 and 133 for the
left eye's corners, 263 and 362 for the right, 1 for the nose tip, 10 for the
forehead, 152 for the chin, 13 and 14 for the lips.

So a preview built on this model lines up with what a camera will actually do.
A better-looking head would not, and "better-looking" is worth nothing here
against "lands on the eyes".

Two things it does not have:

- **No iris.** Landmarks 468 and 473 are refined landmarks MediaPipe adds on
  top of the base mesh, so the pupils are taken as the midpoint of each eye's
  inner and outer corner. On a forward-facing canonical head that is within a
  pixel of the iris centre, and it is only used to scale a static preview —
  the app measures the real thing on a real face.
- **No skin.** It is geometry. The studio shades it; nothing about a lens
  depends on what it looks like.
