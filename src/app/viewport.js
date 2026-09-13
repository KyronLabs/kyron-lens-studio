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
    this.render();
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
      if (hit !== null) {
        this._dragging = { index: hit, x: event.clientX, y: event.clientY };
        this.select(hit);
        this.onSelect?.(hit);
      } else {
        turning = { x: event.clientX, y: event.clientY };
      }
    });

    canvas.addEventListener('pointermove', (event) => {
      if (this._dragging) {
        // A drag is in screen pixels; a lens is in pupil-gaps. This is the
        // conversion the whole tool exists for, and it has to use the same
        // scale the placement did or the sticker will not follow the cursor.
        const scale = this._pixelsPerUnit();
        const dx = (event.clientX - this._dragging.x) / scale / this.gap;
        const dy = (event.clientY - this._dragging.y) / scale / this.gap;
        this._dragging.x = event.clientX;
        this._dragging.y = event.clientY;
        this.onMove(this._dragging.index, { dx, dy });
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

  _pick(event) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this._pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this._pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this._raycaster.setFromCamera(this._pointer, this.camera);
    const [hit] = this._raycaster.intersectObjects(this._sprites, false);
    return hit ? hit.object.userData.index : null;
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
    this.render();
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }

}
