# Kyron Lens Studio

Draw a lens, place it on a face, publish it.

A Windows desktop tool for authoring lenses for
[KyronLabs/kyron-lenses](https://github.com/KyronLabs/kyron-lenses) — paint
something, position it on a 3D face, see it the way the camera will, and open
a pull request against the catalogue without touching JSON.

> **State: the foundation, not the app.** The format contract and the geometry
> are built and tested; the editor is not. [What is here and what is
> next](#what-is-here) is honest about the line.

---

## The problem it solves

A lens is a small JSON object, and the app is strict about it. Three kinds:

| | What it is |
|:--|:--|
| **Colour** | Twenty numbers — a 4×5 colour matrix applied per pixel. |
| **Face** (`schema: 2`) | Pictures hung on a tracked face: an asset, an anchor, a width. |
| **Effect** (`schema: 3`) | Changes to the face itself: a region filled with sampled skin, or everything frosted but the eyes. |

Two of those are hard to author by hand, for the same reason:

**Every measurement is in pupil-gaps.** Not pixels, not a fraction of the
frame — multiples of the distance between the two pupils. That is what makes a
lens correct at any distance from the camera, on any face, at any resolution,
with nothing to tune per device. It is also completely unlike how anybody
draws: an artist works in pixels on a picture, and the file wants gaps from an
anchor, in a frame that **rotates with the head**.

So hand-authored lenses are guesswork, and a wrong one is not obviously wrong
until it is on somebody's face. This tool does that conversion, both ways, and
renders the preview from the file it is about to publish rather than from what
the editor meant.

## Why a third implementation of the rules exists

There were already two: `Lens.tryParse` in the Kyron app (Dart) and
`problems()` in `kyron-lenses/tools/lens.py`. That repository's `FORMAT.md` is
blunt about the danger — *"a lens that passes the tool, gets published, and is
then dropped by the app leaves its explanation in a log line on a stranger's
phone."*

`src/format/lens.js` is a third anyway, because the studio has to tell somebody
their lens is wrong **while they are drawing it**, and shelling out to Python
on every keystroke would mean shipping a Python runtime inside a Windows app to
answer a question that is twenty comparisons.

What makes it safe is the same thing that makes the other two safe:
**`test/format-vectors.json` is copied from kyron-lenses and run against it on
every change.** All 106 cases, or the build fails.

That guard is not decorative. Three rules were deliberately loosened to check
it bites, and each was caught by name:

| Loosened | Caught by |
|:--|:--|
| allow `http://` assets | `refuses ar-asset-plain-http` |
| let a frost `blur` of 0 through | `refuses fx-frost-blur-zero` |
| drop "attachments need schema 2" | `refuses ar-attachments-claiming-schema-1` |

Refresh the vectors with `npm run vectors:refresh`.

## What is here

```
src/format/lens.js    the rules — what the app will and will not draw
src/format/face.js    pupil-gap geometry, both directions
test/vectors.test.js  the 106 shared cases from kyron-lenses
test/face.test.js     the geometry, including the property it all rests on
```

```bash
npm test        # 117 tests
npm run vectors # just the shared format contract
```

`face.js` carries the part that is hardest to retrofit and easiest to get
subtly wrong:

- **`FaceFrame`** — two pupils in pixels is everything. The gap between them
  is the unit, the midpoint is the origin, the angle is the head's roll. Two
  pupils in the same place throws rather than producing `Infinity` widths.
- **`attachmentFor`** — a drag on the canvas → the four numbers a lens is
  written in. It does **not** clamp: a width of 40 gaps means somebody dragged
  something absurd, and quietly making it 12 would publish a lens they did not
  draw. The format check says no instead.
- **`placementFor`** — the inverse, which draws the preview.

The property the whole format rests on is a test: *a lens authored on one face
lands on the same features on a face twice the size*, and *a lens authored
against a 25° head tilt comes out upright*.

## What is next

In the order it should be built:

1. **The canvas.** Paint or import artwork with transparency — the sticker.
   Exports the PNG the catalogue will serve.
2. **The 3D face.** The canonical MediaPipe face mesh, which is the same mesh
   `mediapipe_face_mesh` gives the app, so a preview lines up with what the
   camera will actually do rather than with somebody's idea of where a nose is.
   Drag the artwork onto it; `face.js` turns that into the numbers.
3. **The colour matrix editor.** Twenty numbers is unusable as twenty fields —
   it wants the controls people think in (warmth, contrast, saturation, tint)
   composing down to the matrix, with the raw numbers visible for anyone who
   wants them.
4. **The effects editor.** Region, feather, keepShading, frost. Previewed on a
   real photograph, because a fill only reads correctly over real skin.
5. **Publish.** Write `assets/<id>.png` and the `lenses.json` entry, and open a
   pull request on kyron-lenses.

### The stack, and why

**Electron + Three.js.** Three.js is the only part of this that is not a
choice: a 3D face mockup with artwork positioned on it in perspective is what
it is for. Canvas 2D handles the painting, Node handles git and the pull
request, and `electron-builder` produces the Windows installer.

Flutter was the obvious alternative — it is what the Kyron app is written in
and what the team already knows — and was rejected on one point: Flutter has
no mature 3D. Everything in that space is early, and the face mockup is the
centre of this tool rather than an ornament on it.

## Windows only

On purpose. This is an authoring tool for people making lenses, not something
readers install, and one platform means one set of build problems. Nothing in
`src/format/` is platform-specific — it is plain JavaScript with no
dependencies, and the tests run anywhere.

## Licence

MIT, like the catalogue it publishes to.
