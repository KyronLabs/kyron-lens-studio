// src/app/viewport.js
//
// The face, in three dimensions, with the lens on it.
//
// This is the part that makes the studio worth opening rather than editing
// JSON: a lens is written in pupil-gaps relative to an anchor, in a frame
// that rotates with the head, and nobody can hold that in their head. Here it
// is a picture you can turn.
//
// The mesh is MediaPipe's canonical face model -- the same 468 vertices the
// app's tracker fits to a real face -- so a preview built on it lines up with
// what a camera will actually do rather than with somebody's idea of where a
// nose is. See assets/face/README.md for where it came from and its licence.
//
// Every attachment is placed by `placementFor` from src/format/face.js, from
// the numbers in the lens rather than from the editor's own state, so what is
// on screen is drawn from the file that would be published.

import * as THREE from './vendor/three.module.js';

import { ANCHOR_OFFSETS, CANONICAL_VERTICES, pupilsFrom } from '../format/face.js';
import { handlePositions, rotationFromDrag, widthFromDrag } from './gesture.js';
import { frameOf, localIn } from './plane.js';

/** How big a handle looks, in screen pixels, at any zoom. */
const HANDLE_PX = 9;

/** How far above the top edge the rotate handle sits, in screen pixels. */
const ROTATE_REACH_PX = 34;

export class FaceViewport {
  /**
   * @param {HTMLElement} host where to put the canvas
   * @param {(index: number, change: object) => void} onMove told when an
   *   attachment is dragged, in the lens's own units
   */
  constructor(host, onMove = () => {}) {
    this.host = host;
    this.onMove = onMove;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x17181c);

    // Orthographic, and that is not a stylistic choice.
    //
    // An attachment is a flat sprite placed in the pupil-gap plane -- offset
    // Y of -1.35 means "1.35 gaps above the pupil line" and nothing else. Under
    // a perspective camera a sprite drawn in front of the face is magnified
    // and pushed away from the centre of the frame, so a sticker set to sit
    // on the forehead appears above it, by an amount that depends on how far
    // forward it happens to be drawn. Every number in the inspector would be
    // slightly contradicted by the picture next to it.
    //
    // With no perspective there is no parallax: a sprite lands exactly where
    // its numbers say, and turning the head still shows it for the flat thing
    // it is, which is the honest thing to show.
    this.camera = new THREE.OrthographicCamera(-10, 10, 10, -10, -200, 200);
    this.camera.position.set(0, 0, 50);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(2, globalThis.devicePixelRatio ?? 1));
    host.append(this.renderer.domElement);

    this.head = new THREE.Group();
    this.scene.add(this.head);

    // Two lights and no shadows. This is a placement tool: a dramatically lit
    // face makes it harder to see where a sticker lands, not easier.
    this.scene.add(new THREE.AmbientLight(0xffffff, 1.5));
    const key = new THREE.DirectionalLight(0xffffff, 1.1);
    key.position.set(2, 3, 5);
    this.scene.add(key);

    this.attachments = new THREE.Group();
    this.head.add(this.attachments);

    /** The gap between the pupils, in scene units. Set once the mesh loads. */
    this.gap = 1;

    this._sprites = [];
    this._textures = new Map();
    this.zoom = 1;
    this.radius = 10;
    this._raycaster = new THREE.Raycaster();
    this._pointer = new THREE.Vector2();
    this._dragging = null;
    this._selected = -1;
    this._handles = this._buildHandles();

    this._wire();
    this.resize();
  }

  /**
   * Loads the canonical mesh from an OBJ.
   *
   * Parsed here rather than with three's OBJLoader: the file is positions and
   * faces and nothing else -- no normals, no materials, no groups -- and
   * pulling in a loader for `v` and `f` lines is more to go wrong than the
   * twenty lines it replaces.
   */
  async load(objText) {
    const positions = [];
    const indices = [];
    for (const line of objText.split('\n')) {
      if (line.startsWith('v ')) {
        const [, x, y, z] = line.trim().split(/\s+/);
        positions.push(Number(x), Number(y), Number(z));
      } else if (line.startsWith('f ')) {
        const corners = line
          .trim()
          .split(/\s+/)
          .slice(1)
          .map((part) => Number(part.split('/')[0]) - 1);
        // Fans, so a quad is two triangles rather than a hole.
        for (let i = 1; i + 1 < corners.length; i++) {
          indices.push(corners[0], corners[i], corners[i + 1]);
        }
      }
    }

    if (positions.length / 3 < CANONICAL_VERTICES) {
      throw new RangeError(
        `that mesh has ${positions.length / 3} vertices; the canonical face ` +
          `model has ${CANONICAL_VERTICES}`,
      );
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(positions, 3),
    );
    geometry.setIndex(indices);
    geometry.computeVertexNormals();

    this.vertices = positions;
    this.face = new THREE.Mesh(
      geometry,
      new THREE.MeshStandardMaterial({
        color: 0x8d6e63,
        roughness: 0.85,
        metalness: 0,
        flatShading: false,
      }),
    );
    this.head.add(this.face);

    // A wireframe over it, faintly. The mesh is the thing being placed
    // against, and a bare surface gives nothing to judge a position by.
    this.head.add(
      new THREE.LineSegments(
        new THREE.WireframeGeometry(geometry),
        new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.06 }),
      ),
    );

    // Through the same derivation `tools/derive-anchors.mjs` uses for the
    // anchor table, so the preview and the table cannot disagree.
    //
    // The first version read vertices 468 and 473 -- the irises, which exist
    // in the 478-point model the app's tracker runs and *not* in the 468-point
    // canonical mesh shipped here. That gave a gap of NaN, put every
    // attachment at NaN, and drew nothing at all, silently.
    const { gap, origin } = pupilsFrom(
      Array.from({ length: positions.length / 3 }, (_, i) => ({
        x: positions[i * 3],
        y: positions[i * 3 + 1],
        z: positions[i * 3 + 2],
      })),
    );
    this.gap = gap;
    this.origin = new THREE.Vector3(origin.x, origin.y, origin.z);

    // Frame the head rather than guessing a camera distance: the mesh's own
    // scale is whatever MediaPipe shipped, and hard-coding 22 would be right
    // only for this exact file.
    geometry.computeBoundingSphere();
    const { radius, center } = geometry.boundingSphere;
    this.head.position.set(-center.x, -center.y, -center.z);
    this.radius = radius;
    this.camera.lookAt(0, 0, 0);

    this._markAnchors();
    this.render();
  }

  /** A dot at each anchor, so the five words in the format have places. */
  _markAnchors() {
    const marks = new THREE.Group();
    for (const [name, offset] of Object.entries(ANCHOR_OFFSETS)) {
      const dot = new THREE.Mesh(
        new THREE.SphereGeometry(this.gap * 0.06, 12, 8),
        new THREE.MeshBasicMaterial({ color: 0x17d1b0 }),
      );
      // Positive y is down in the format and up in three, hence the sign.
      dot.position.set(
        this.origin.x + offset.x * this.gap,
        this.origin.y - offset.y * this.gap,
        // Just clear of the surface. With no perspective, how far forward
        // this is changes nothing about where it appears -- only whether the
        // nose is in front of it.
        this.origin.z + this.gap * 1.4,
      );
      dot.name = `anchor:${name}`;
      marks.add(dot);
    }
    this.anchorMarks = marks;
    this.head.add(marks);
  }

  showAnchors(visible) {
    if (this.anchorMarks) this.anchorMarks.visible = visible;
    this.render();
  }

  /**
   * Draws a lens's attachments on the face.
   *
   * `lens` is the published object, and `artwork` maps an asset URL to
   * something a texture can be made from. Anything without artwork is drawn
   * as an outline rather than left out: a lens whose picture has not been
   * imported still has a position, and hiding it makes the inspector's
   * numbers refer to nothing on screen.
   */
  setLens(lens, artwork = new Map()) {
    for (const sprite of this._sprites) {
      this.attachments.remove(sprite);
      sprite.geometry.dispose();
      sprite.material.dispose();
    }
    this._sprites = [];

    (lens.attachments ?? []).forEach((attachment, index) => {
      const widthUnits = attachment.width * this.gap;
      const image = artwork.get(attachment.asset);
      const aspect = image ? image.height / image.width : 1;

      const material = image
        ? new THREE.MeshBasicMaterial({
            map: this._texture(attachment.asset, image),
            transparent: true,
            depthTest: false,
          })
        : new THREE.MeshBasicMaterial({
            color: 0x17d1b0,
            transparent: true,
            opacity: 0.25,
            depthTest: false,
          });

      const plane = new THREE.Mesh(
        new THREE.PlaneGeometry(widthUnits, widthUnits * aspect),
        material,
      );
      plane.renderOrder = 10 + index;
      plane.userData.index = index;
      this._place(plane, attachment);
      this.attachments.add(plane);
      this._sprites.push(plane);
    });

    this.select(this._selected);
    this.render();
  }

  /** Where an attachment sits, from the numbers in the lens. */
  _place(plane, attachment) {
    const base = ANCHOR_OFFSETS[attachment.anchor] ?? ANCHOR_OFFSETS.eyes;
    const x = (base.x + (attachment.offsetX ?? 0)) * this.gap;
    const y = (base.y + (attachment.offsetY ?? 0)) * this.gap;
    plane.position.set(
      this.origin.x + x,
      this.origin.y - y,
      this.origin.z + this.gap * 1.5,
    );
    plane.rotation.z = (-(attachment.rotation ?? 0) * Math.PI) / 180;
  }

  _texture(key, image) {
    let texture = this._textures.get(key);
    if (!texture) {
      texture = new THREE.Texture(image);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.needsUpdate = true;
      this._textures.set(key, texture);
    }
    return texture;
  }

  select(index) {
    this._selected = index;
    this._sprites.forEach((sprite, at) => {
      sprite.material.opacity = sprite.material.map
        ? 1
        : at === index
          ? 0.45
          : 0.25;
    });
    this._layoutHandles();
    this.render();
  }

  // -------------------------------------------------------------------------
  // Handles
  // -------------------------------------------------------------------------

  /**
   * Four corners to resize by and one above the top edge to turn by.
   *
   * Built once and re-parented to whichever attachment is selected, so they
   * inherit its position and rotation -- and the head's -- for free. The
   * arithmetic they drive is in gesture.js, which can be tested; this is the
   * part that cannot.
   */
  _buildHandles() {
    const group = new THREE.Group();
    group.name = 'handles';

    // depthTest off, like the attachments: a handle behind the face is still
    // the handle for something in front of it.
    const skin = (colour, opacity = 1) =>
      new THREE.MeshBasicMaterial({
        color: colour,
        transparent: true,
        opacity,
        depthTest: false,
      });

    for (const corner of ['nw', 'ne', 'se', 'sw']) {
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), skin(0x17d1b0));
      mesh.userData.handle = { kind: 'resize', corner };
      mesh.renderOrder = 900;
      group.add(mesh);
    }

    const turn = new THREE.Mesh(new THREE.CircleGeometry(0.5, 20), skin(0xffb800));
    turn.userData.handle = { kind: 'rotate' };
    turn.renderOrder = 901;
    group.add(turn);

    // The stalk. No `userData.handle`, so it is drawn and never grabbed: it
    // is there so the rotate handle reads as belonging to the attachment
    // rather than floating somewhere above it.
    const stalk = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), skin(0xffb800, 0.5));
    stalk.name = 'stalk';
    stalk.renderOrder = 899;
    group.add(stalk);

    return group;
  }

  /**
   * Moves the handles onto the selected attachment, at a constant size on
   * screen.
   *
   * Their positions are in the plane's own units, so they have to be redone
   * whenever the geometry changes -- which during a resize drag is every
   * frame, because the app writes the new width and the sprite is rebuilt
   * from the lens.
   */
  _layoutHandles() {
    const group = this._handles;
    const plane = this._sprites[this._selected];
    if (!plane) {
      group.removeFromParent();
      return;
    }
    // `add` detaches from the previous parent, which setLens has already
    // disposed.
    if (group.parent !== plane) plane.add(group);

    const { width, height } = plane.geometry.parameters;
    const perUnit = this._pixelsPerUnit();
    const size = HANDLE_PX / perUnit;
    const reach = ROTATE_REACH_PX / perUnit;

    // Above the artwork unless that is off the top of the canvas. The first
    // version always went above, and the first attachment anybody adds is a
    // star over the forehead: its handle landed seven pixels above the top
    // edge of the canvas, so the picture showed a stalk running up to
    // nothing. Margin of the handle's own radius, so it is fully inside
    // rather than half cut off.
    const margin = (size * 1.3) / 2 / this.camera.top;
    const top = plane
      .localToWorld(new THREE.Vector3(0, height / 2 + reach + size, 0))
      .project(this.camera).y;
    const { resize, rotate } = handlePositions(width, height, reach, {
      below: top > 1 - margin,
    });

    for (const mesh of group.children) {
      const handle = mesh.userData.handle;
      if (handle?.kind === 'resize') {
        const spot = resize.find((it) => it.name === handle.corner);
        mesh.position.set(spot.x, spot.y, 0.01);
        mesh.scale.set(size, size, 1);
      } else if (handle?.kind === 'rotate') {
        mesh.position.set(rotate.x, rotate.y, 0.01);
        mesh.scale.set(size * 1.3, size * 1.3, 1);
      } else {
        // The stalk, from whichever edge the handle went to.
        const edge = Math.sign(rotate.y) * (height / 2);
        mesh.position.set(0, (rotate.y + edge) / 2, 0.005);
        mesh.scale.set(size / 4, Math.abs(rotate.y - edge), 1);
      }
    }
  }

  /** The attachment's rotation in the format's degrees, read off the plane. */
  _rotationOf(index) {
    const plane = this._sprites[index];
    return plane ? (-plane.rotation.z * 180) / Math.PI : 0;
  }

  /** See plane.js: taken once per drag, never recomputed mid-drag. */
  _frameOf(plane) {
    return frameOf(plane);
  }

  /** Where the cursor is in that frame, or null when the head is edge-on. */
  _localIn(frame) {
    return localIn(frame, this._raycaster.ray);
  }

  // -------------------------------------------------------------------------
  // Turning the head, and dragging what is on it
  // -------------------------------------------------------------------------

  _wire() {
    const canvas = this.renderer.domElement;
    let turning = null;

    canvas.addEventListener('pointerdown', (event) => {
      canvas.setPointerCapture(event.pointerId);
      const hit = this._pick(event);
      if (hit === null) {
        turning = { x: event.clientX, y: event.clientY };
        return;
      }

      if (hit.kind === 'move') {
        this._dragging = {
          kind: 'move',
          index: hit.index,
          x: event.clientX,
          y: event.clientY,
        };
        this.select(hit.index);
        this.onSelect?.(hit.index);
        return;
      }

      // A handle, so the attachment it belongs to is already selected.
      const plane = this._sprites[hit.index];
      if (!plane) return;
      const frame = this._frameOf(plane);
      const grab = this._localIn(frame);
      if (!grab) return;

      this._dragging = {
        kind: hit.kind,
        index: hit.index,
        frame,
        grab: { x: grab.x, y: grab.y },
        width: plane.geometry.parameters.width,
        rotation: this._rotationOf(hit.index),
      };
    });

    canvas.addEventListener('pointermove', (event) => {
      const drag = this._dragging;
      if (drag?.kind === 'move') {
        // A drag is in screen pixels; a lens is in pupil-gaps. This is the
        // conversion the whole tool exists for, and it has to use the same
        // scale the placement did or the sticker will not follow the cursor.
        const scale = this._pixelsPerUnit();
        const dx = (event.clientX - drag.x) / scale / this.gap;
        const dy = (event.clientY - drag.y) / scale / this.gap;
        drag.x = event.clientX;
        drag.y = event.clientY;
        this.onMove(drag.index, { dx, dy });
        return;
      }
      if (drag) {
        this._aim(event);
        const now = this._localIn(drag.frame);
        // Edge-on: nothing to measure, so the attachment keeps what it has
        // until the head is turned back.
        if (!now) return;

        if (drag.kind === 'resize') {
          const width = widthFromDrag({
            grab: drag.grab,
            at: now,
            width: drag.width,
          });
          // Scene units back into the lens's own: the plane was built as
          // `attachment.width * gap`, so this is that read backwards.
          this.onMove(drag.index, { width: width / this.gap });
        } else {
          this.onMove(drag.index, {
            rotation: rotationFromDrag({
              grab: drag.grab,
              at: now,
              rotation: drag.rotation,
            }),
          });
        }
        return;
      }
      if (!turning) return;
      this.head.rotation.y += (event.clientX - turning.x) * 0.008;
      this.head.rotation.x += (event.clientY - turning.y) * 0.008;
      this.head.rotation.x = Math.max(-0.9, Math.min(0.9, this.head.rotation.x));
      turning = { x: event.clientX, y: event.clientY };
      this.render();
    });

    const stop = (event) => {
      canvas.releasePointerCapture?.(event.pointerId);
      this._dragging = null;
      turning = null;
    };
    canvas.addEventListener('pointerup', stop);
    canvas.addEventListener('pointercancel', stop);

    canvas.addEventListener('wheel', (event) => {
      event.preventDefault();
      this.zoom = Math.max(0.4, Math.min(6, this.zoom * (1 - Math.sign(event.deltaY) * 0.1)));
      this.resize();
    }, { passive: false });
  }

  /**
   * How many screen pixels one scene unit covers.
   *
   * One number, and no depth in it, which is the other half of why the camera
   * is orthographic: a drag has to move a sprite by exactly the distance the
   * cursor moved, and under perspective that distance depends on how far
   * forward the sprite is.
   */
  _pixelsPerUnit() {
    const height = this.renderer.domElement.clientHeight || 1;
    return height / (this.camera.top - this.camera.bottom);
  }

  /** Points the raycaster at wherever the cursor is. */
  _aim(event) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this._pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this._pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this._raycaster.setFromCamera(this._pointer, this.camera);
  }

  /**
   * What is under the cursor: a handle, an attachment, or nothing.
   *
   * Handles first, and by some distance -- they sit on top of the artwork
   * they belong to, so testing the sprites first would mean the corners could
   * never be grabbed at all.
   */
  _pick(event) {
    this._aim(event);

    if (this._handles.parent) {
      const grabbable = this._handles.children.filter((it) => it.userData.handle);
      const [grabbed] = this._raycaster.intersectObjects(grabbable, false);
      if (grabbed) {
        return { ...grabbed.object.userData.handle, index: this._selected };
      }
    }

    const [hit] = this._raycaster.intersectObjects(this._sprites, false);
    return hit ? { kind: 'move', index: hit.object.userData.index } : null;
  }

  resize() {
    const width = this.host.clientWidth || 640;
    const height = this.host.clientHeight || 480;
    this.renderer.setSize(width, height, false);

    // The head, with room around it for something hung above or below it.
    const half = ((this.radius ?? 10) * 1.75) / this.zoom;
    const aspect = width / height;
    this.camera.top = half;
    this.camera.bottom = -half;
    this.camera.left = -half * aspect;
    this.camera.right = half * aspect;
    this.camera.updateProjectionMatrix();
    // A handle is a constant number of screen pixels, so a zoom changes what
    // that is in scene units.
    this._layoutHandles();
    this.render();
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }

}
