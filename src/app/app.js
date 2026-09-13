// src/app/app.js
//
// The window, wired up.
//
// Everything interesting happens in modules that can be tested without one:
// `state.js` is the editor, `project.js` turns it into the lens that gets
// published, `matrix.js` turns sliders into twenty numbers, `lens.js` says
// whether the app would draw the result. This file is the part that has to
// run in a browser -- panels, inputs, and a 3D preview -- and it is
// deliberately the thinnest layer over those that will do.
//
// The rule it follows: **nothing is previewed from the editor's own state.**
// Every preview is drawn from `editor.lens`, which is exactly the object that
// would be written into the catalogue. A studio whose preview comes from
// somewhere else is a studio that lies.

import { ANCHORS, REGIONS } from '../format/lens.js';
import { fromAdjustments } from '../format/matrix.js';
import { publishPlan } from '../format/project.js';
import { COLOUR, Editor, LENS } from './state.js';
import { Paint } from './paint.js';
import { ADJUSTMENTS, RANGE, describeWidth, show } from './units.js';
import { FaceViewport } from './viewport.js';

/** Everything the main process exposes. Absent in a browser. */
const studio = globalThis.studio ?? null;

const $ = (id) => document.getElementById(id);

const editor = new Editor(undefined, () => draw());
let viewport = null;
let paint = null;
const artwork = new Map();

// ---------------------------------------------------------------------------
// Drawing the window
// ---------------------------------------------------------------------------

function draw() {
  const project = editor.project;

  if ($('lens-name').value !== project.name) $('lens-name').value = project.name;
  if ($('lens-id').value !== project.id) $('lens-id').value = project.id;
  $('dirty').hidden = !editor.dirty;
  $('undo').disabled = !editor.canUndo;
  $('redo').disabled = !editor.canRedo;

  drawObjects();
  drawResources();
  drawInspector();
  drawLogger();

  const lens = editor.lens;
  $('json').textContent = JSON.stringify(lens, null, 2);
  viewport?.setLens(lens, artwork);
  drawPhoto(lens);

  // Decoding is asynchronous, so this cannot happen inline; what it can do is
  // notice on every draw that the lens now needs a picture nothing has
  // decoded yet. Doing it only on import was the first version, and it meant
  // an attachment pointed at artwork already in the project drew as an empty
  // outline until something else happened to trigger a decode.
  ensureArtwork(lens);
}

function drawObjects() {
  const list = $('objects');
  list.replaceChildren();

  list.append(
    row({
      glyph: 'L',
      label: editor.project.name || 'Untitled',
      note: `schema ${editor.lens.schema}`,
      on: editor.selection.kind === 'lens',
      onPick: () => editor.select(LENS),
    }),
    row({
      glyph: 'C',
      label: 'Colour',
      note: editor.matrix ? (editor.colourIsTyped ? 'typed' : 'adjusted') : 'none',
      on: editor.selection.kind === 'colour',
      onPick: () => editor.select(COLOUR),
    }),
  );

  editor.project.attachments.forEach((attachment, index) => {
    list.append(
      row({
        glyph: 'A',
        label: attachment.resource ?? 'no artwork',
        note: `${attachment.anchor} · ${show(attachment.width)}`,
        on: editor.selection.kind === 'attachment' && editor.selection.index === index,
        onPick: () => editor.select({ kind: 'attachment', index }),
      }),
    );
  });

  editor.project.effects.forEach((effect, index) => {
    list.append(
      row({
        glyph: 'E',
        label: effect.kind === 'fill' ? 'Fill' : 'Frost',
        note: effect.kind === 'fill' ? effect.region : `blur ${show(effect.blur)}`,
        on: editor.selection.kind === 'effect' && editor.selection.index === index,
        onPick: () => editor.select({ kind: 'effect', index }),
      }),
    );
  });
}

function row({ glyph, label, note, on, onPick }) {
  const item = document.createElement('li');
  if (on) item.className = 'is-on';
  item.append(
    element('span', { class: 'glyph', text: glyph }),
    element('span', { class: 'label', text: label }),
    element('span', { class: 'note', text: note ?? '' }),
  );
  item.addEventListener('click', onPick);
  return item;
}

function drawResources() {
  const list = $('resources');
  list.replaceChildren();

  if (!editor.project.resources.length) {
    const empty = document.createElement('li');
    empty.className = 'drop';
    empty.textContent = 'Nothing imported yet. Paint something, or drop a PNG here.';
    list.append(empty);
    return;
  }

  for (const resource of editor.project.resources) {
    const item = document.createElement('li');
    const thumb = document.createElement('img');
    thumb.src = resource.bytes;
    thumb.alt = '';
    const remove = element('button', { class: 'ghost small', text: '×' });
    remove.title = `Remove ${resource.name}`;
    remove.addEventListener('click', () => editor.removeResource(resource.name));
    item.append(
      thumb,
      element('span', { class: 'label', text: resource.name }),
      element('span', {
        class: 'note',
        text: resource.width ? `${resource.width}×${resource.height}` : '',
      }),
      remove,
    );
    list.append(item);
  }
}

// ---------------------------------------------------------------------------
// The inspector
// ---------------------------------------------------------------------------

function drawInspector() {
  const body = $('inspector');
  body.replaceChildren();
  const selection = editor.selection;

  if (selection.kind === 'lens') {
    $('inspector-title').textContent = 'Lens';
    body.append(
      text('Name', editor.project.name, (value) => editor.setField('name', value)),
      text('Id', editor.project.id, (value) => editor.setField('id', value)),
      note('Lowercase letters, digits, - and _. This is the filename the catalogue keys on and it cannot change once published.'),
      text('Author', editor.project.author, (value) => editor.setField('author', value)),
    );
    return;
  }

  if (selection.kind === 'colour') {
    $('inspector-title').textContent = 'Colour';
    if (editor.colourIsTyped) {
      body.append(
        note('These twenty numbers were typed, not dialled. The sliders cannot describe every matrix and a matrix cannot be turned back into sliders, so they stay out of the way until one is touched — which will replace this.'),
      );
    }
    for (const control of ADJUSTMENTS) {
      body.append(
        slider({
          label: control.label,
          unit: control.unit,
          value: editor.adjustments[control.name],
          min: control.min,
          max: control.max,
          step: control.step,
          onInput: (value) => editor.setAdjustment(control.name, value),
        }),
      );
    }
    const reset = element('button', { class: 'ghost small', text: 'Reset colour' });
    reset.addEventListener('click', () => editor.resetColour());
    body.append(reset, element('p', { class: 'section', text: 'Matrix' }), matrixGrid());
    return;
  }

  if (selection.kind === 'attachment') {
    const attachment = editor.project.attachments[selection.index];
    if (!attachment) return editor.select(LENS);
    $('inspector-title').textContent = `Attachment ${selection.index + 1}`;

    const set = (changes) => editor.setAttachment(selection.index, changes);
    body.append(
      choose('Artwork', attachment.resource ?? '', [
        { value: '', label: '— none —' },
        ...editor.project.resources.map((it) => ({ value: it.name, label: it.name })),
      ], (value) => set({ resource: value || null })),
      choose('Anchor', attachment.anchor, ANCHORS.map((it) => ({ value: it, label: it })),
        (value) => set({ anchor: value })),
      slider({
        label: 'Width',
        unit: describeWidth(attachment.width),
        value: attachment.width,
        ...RANGE.width,
        onInput: (value) => set({ width: value }),
      }),
      slider({
        label: 'Offset X',
        unit: 'gaps',
        value: attachment.offsetX ?? 0,
        ...RANGE.offsetX,
        onInput: (value) => set({ offsetX: value }),
      }),
      slider({
        label: 'Offset Y',
        unit: 'gaps · positive is down',
        value: attachment.offsetY ?? 0,
        ...RANGE.offsetY,
        onInput: (value) => set({ offsetY: value }),
      }),
      slider({
        label: 'Rotation',
        unit: '°',
        value: attachment.rotation ?? 0,
        ...RANGE.rotation,
        onInput: (value) => set({ rotation: value }),
      }),
      remover('Remove attachment', () => editor.removeAttachment(selection.index)),
    );
    return;
  }

  if (selection.kind === 'effect') {
    const effect = editor.project.effects[selection.index];
    if (!effect) return editor.select(LENS);
    $('inspector-title').textContent = effect.kind === 'fill' ? 'Fill' : 'Frost';
    const set = (changes) => editor.setEffect(selection.index, changes);

    if (effect.kind === 'fill') {
      body.append(
        note('Covers a region of the face with skin sampled from that same face. No colour is written into the lens — a fixed skin tone belongs to one person.'),
        choose('Region', effect.region, REGIONS.map((it) => ({ value: it, label: it })),
          (value) => set({ region: value })),
        slider({ label: 'Feather', value: effect.feather, ...RANGE.feather, unit: 'gaps',
          onInput: (value) => set({ feather: value }) }),
        slider({ label: 'Keep shading', value: effect.keepShading, ...RANGE.keepShading,
          onInput: (value) => set({ keepShading: value }) }),
      );
    } else {
      body.append(
        note('Blurs and lifts the face, optionally leaving one region sharp.'),
        slider({ label: 'Blur', value: effect.blur, ...RANGE.blur, unit: 'gaps',
          onInput: (value) => set({ blur: value }) }),
        slider({ label: 'Desaturate', value: effect.desaturate, ...RANGE.desaturate,
          onInput: (value) => set({ desaturate: value }) }),
        slider({ label: 'Lift', value: effect.lift, ...RANGE.lift,
          onInput: (value) => set({ lift: value }) }),
        slider({ label: 'Feather', value: effect.feather, ...RANGE.feather, unit: 'gaps',
          onInput: (value) => set({ feather: value }) }),
        choose('Reveal', effect.reveal ?? '', [
          { value: '', label: '— nothing —' },
          ...REGIONS.map((it) => ({ value: it, label: it })),
        ], (value) => set({ reveal: value || undefined })),
      );
    }
    body.append(remover('Remove effect', () => editor.removeEffect(selection.index)));
  }
}

function matrixGrid() {
  const grid = element('div', { class: 'matrix' });
  const matrix = editor.matrix ?? fromAdjustments({});
  matrix.forEach((value, index) => {
    const field = document.createElement('input');
    field.value = show(value, 4);
    if (index % 5 === 4) field.className = 'offset';
    field.addEventListener('change', () => {
      const next = [...matrix];
      next[index] = Number(field.value);
      if (Number.isFinite(next[index])) editor.setMatrix(next);
      else draw();
    });
    grid.append(field);
  });
  return grid;
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

function slider({ label, unit, value, min, max, step, onInput }) {
  const field = element('div', { class: 'field' });
  const head = element('div', { class: 'field-label' });
  const readout = element('span', { class: 'value', text: show(value, 2) });
  head.append(
    element('span', { text: label }),
    element('span', {}, [readout, element('span', { class: 'unit', text: unit ? ` ${unit}` : '' })]),
  );

  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  input.addEventListener('input', () => {
    readout.textContent = show(Number(input.value), 2);
    onInput(Number(input.value));
  });

  field.append(head, input);
  return field;
}

function text(label, value, onChange) {
  const field = element('div', { class: 'field' });
  const input = document.createElement('input');
  input.type = 'text';
  input.value = value ?? '';
  input.spellcheck = false;
  input.addEventListener('input', () => onChange(input.value));
  field.append(element('label', { text: label }), input);
  return field;
}

function choose(label, value, options, onChange) {
  const field = element('div', { class: 'field' });
  const select = document.createElement('select');
  for (const option of options) {
    const item = document.createElement('option');
    item.value = option.value;
    item.textContent = option.label;
    if (option.value === value) item.selected = true;
    select.append(item);
  }
  select.addEventListener('change', () => onChange(select.value));
  field.append(element('label', { text: label }), select);
  return field;
}

function note(words) {
  return element('p', { class: 'hint', text: words });
}

function remover(label, onClick) {
  const button = element('button', { class: 'ghost small danger', text: label });
  button.addEventListener('click', onClick);
  return button;
}

function element(tag, { class: className, text: content } = {}, children = []) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  node.append(...children);
  return node;
}

// ---------------------------------------------------------------------------
// The logger
// ---------------------------------------------------------------------------

function drawLogger() {
  const problems = editor.blockers;
  const status = $('logger-status');
  const list = $('logger-list');
  list.replaceChildren();

  $('publish').disabled = problems.length > 0;

  if (!problems.length) {
    status.textContent = 'Ready to publish';
    status.className = 'status ok';
    return;
  }

  status.textContent = `${problems.length} thing${problems.length === 1 ? '' : 's'} to fix`;
  status.className = 'status bad';

  for (const problem of problems) {
    const item = document.createElement('li');
    const studioOnly = problem.kind !== 'format';
    item.append(
      element('span', {
        class: studioOnly ? 'tag studio' : 'tag',
        text: studioOnly ? 'studio' : 'format',
      }),
      element('span', { text: problem.why }),
    );
    list.append(item);
  }
}

// ---------------------------------------------------------------------------
// The photo preview
// ---------------------------------------------------------------------------

/**
 * The colour matrix over a reference chart.
 *
 * A chart rather than a photograph of somebody, for the same reason the app's
 * lens tiles use one: there is no stand-in face here, and a stock one would
 * be a picture of a person who is not making this lens. What this is for is
 * judging a matrix, and ramps through skin, sky, leaf and grey say more about
 * a matrix than any single face does.
 */
function drawPhoto(lens) {
  const canvas = $('photo');
  const context = canvas.getContext('2d');
  const { width, height } = canvas;

  const bands = [
    ['#f2d3b8', '#8d5524'],
    ['#4c8fff', '#17d1b0'],
    ['#ffffff', '#000000'],
    ['#ff6582', '#ffb74d'],
  ];
  const bandHeight = height / bands.length;
  bands.forEach(([from, to], index) => {
    const gradient = context.createLinearGradient(0, 0, width, 0);
    gradient.addColorStop(0, from);
    gradient.addColorStop(1, to);
    context.fillStyle = gradient;
    context.fillRect(0, index * bandHeight, width, bandHeight);
  });

  // Steps down the middle, so a contrast change is legible as steps closing
  // up rather than as a gradient looking slightly different.
  for (let step = 0; step < 8; step++) {
    const grey = Math.round((step / 7) * 255);
    context.fillStyle = `rgb(${grey},${grey},${grey})`;
    context.fillRect(width * 0.38 + step * (width * 0.03), height * 0.42, width * 0.03, height * 0.16);
  }

  if (!lens.matrix) return;
  const image = context.getImageData(0, 0, width, height);
  const data = image.data;
  const m = lens.matrix;
  for (let at = 0; at < data.length; at += 4) {
    const r = data[at], g = data[at + 1], b = data[at + 2], a = data[at + 3];
    data[at] = clamp(m[0] * r + m[1] * g + m[2] * b + m[3] * a + m[4]);
    data[at + 1] = clamp(m[5] * r + m[6] * g + m[7] * b + m[8] * a + m[9]);
    data[at + 2] = clamp(m[10] * r + m[11] * g + m[12] * b + m[13] * a + m[14]);
    data[at + 3] = clamp(m[15] * r + m[16] * g + m[17] * b + m[18] * a + m[19]);
  }
  context.putImageData(image, 0, 0);
}

const clamp = (value) => Math.max(0, Math.min(255, value));

// ---------------------------------------------------------------------------
// Artwork
// ---------------------------------------------------------------------------

/** Assets currently being decoded, so a redraw does not start them twice. */
const decoding = new Set();

/**
 * Decodes anything the lens needs and the viewport does not have yet.
 *
 * Called from every draw. It does nothing on the common pass -- the map
 * already has what the lens asks for -- and when it does find something
 * missing it redraws once the picture is ready.
 */
function ensureArtwork(lens) {
  for (const attachment of lens.attachments ?? []) {
    const asset = attachment.asset;
    if (artwork.has(asset) || decoding.has(asset)) continue;

    const resource = editor.resource(asset.split('/').pop());
    if (!resource) continue;

    decoding.add(asset);
    decode(resource.bytes)
      .then((image) => {
        artwork.set(asset, image);
        draw();
      })
      .catch(() => {
        // A resource that will not decode is a broken import, and it is
        // already said in the logger as artwork the lens cannot find.
      })
      .finally(() => decoding.delete(asset));
  }
}

/** Forgets every decoded picture, so replaced artwork is picked up again. */
function forgetArtwork() {
  artwork.clear();
  draw();
}

function decode(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = dataUrl;
  });
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function wire() {
  $('lens-name').addEventListener('input', (event) =>
    editor.setField('name', event.target.value));
  $('lens-id').addEventListener('input', (event) =>
    editor.setField('id', event.target.value));

  $('undo').addEventListener('click', () => editor.undo());
  $('redo').addEventListener('click', () => editor.redo());

  $('add-attachment').addEventListener('click', () => editor.addAttachment());
  $('add-fill').addEventListener('click', () => editor.addEffect('fill'));
  $('add-frost').addEventListener('click', () => editor.addEffect('frost'));

  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => {
      for (const other of document.querySelectorAll('.tab')) {
        const on = other === tab;
        other.classList.toggle('is-on', on);
        other.setAttribute('aria-selected', String(on));
      }
      for (const view of document.querySelectorAll('.view')) {
        view.classList.toggle('is-on', view.id === `view-${tab.dataset.view}`);
      }
      viewport?.resize();
    });
  }

  $('logger-toggle').addEventListener('click', () => {
    const shut = document.querySelector('.logger').classList.toggle('is-shut');
    $('logger-toggle').textContent = shut ? 'Show' : 'Hide';
  });

  document.addEventListener('keydown', (event) => {
    if (!(event.ctrlKey || event.metaKey)) return;
    const key = event.key.toLowerCase();
    if (key === 'z') {
      event.preventDefault();
      event.shiftKey ? editor.redo() : editor.undo();
    } else if (key === 'y') {
      event.preventDefault();
      editor.redo();
    } else if (key === 's') {
      event.preventDefault();
      saveProject();
    }
  });

  globalThis.addEventListener('resize', () => viewport?.resize());

  wirePaint();
  wireFiles();
}

function wirePaint() {
  const dialog = $('paint-dialog');
  paint = new Paint($('paint-canvas'));

  $('paint').addEventListener('click', () => {
    paint.clear();
    dialog.showModal();
  });
  $('paint-colour').addEventListener('input', (event) => {
    paint.colour = event.target.value;
    paint.erasing = false;
  });
  $('paint-size').addEventListener('input', (event) => {
    paint.size = Number(event.target.value);
  });
  $('paint-erase').addEventListener('click', () => {
    paint.erasing = !paint.erasing;
    $('paint-erase').textContent = paint.erasing ? 'Paint' : 'Erase';
  });
  $('paint-clear').addEventListener('click', () => paint.clear());
  $('paint-keep').addEventListener('click', async () => {
    const resource = paint.toResource($('paint-name').value.trim() || 'sticker.png');
    if (!resource) {
      // Said rather than swallowed: closing on nothing and finding no new
      // resource in the list is the tool appearing to have lost the drawing.
      $('paint-name').setCustomValidity?.('');
      alert('Nothing has been painted yet.');
      return;
    }
    editor.addResource(resource);
    dialog.close();
    forgetArtwork();
  });
}

function wireFiles() {
  $('import').addEventListener('click', async () => {
    if (!studio) return;
    const files = await studio.importArtwork();
    for (const file of files ?? []) editor.addResource(file);
    forgetArtwork();
  });

  $('open').addEventListener('click', async () => {
    if (!studio) return;
    const opened = await studio.openProject();
    if (!opened) return;
    location.reload();
  });

  $('save').addEventListener('click', saveProject);

  $('publish').addEventListener('click', async () => {
    const plan = publishPlan(editor.project);
    if (plan.blockers.length) return;
    if (!studio) return;
    const result = await studio.publish(plan);
    if (result?.error) alert(result.error);
  });

  // Dropping a PNG anywhere in the window imports it, which is how everybody
  // expects to get artwork into a tool like this.
  document.addEventListener('dragover', (event) => event.preventDefault());
  document.addEventListener('drop', async (event) => {
    event.preventDefault();
    for (const file of event.dataTransfer?.files ?? []) {
      if (!file.type.startsWith('image/')) continue;
      const bytes = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.readAsDataURL(file);
      });
      const image = await decode(bytes);
      editor.addResource({
        name: file.name,
        bytes,
        width: image.width,
        height: image.height,
      });
    }
    forgetArtwork();
  });
}

async function saveProject() {
  if (!studio) return;
  await studio.saveProject(editor.toFile());
  draw();
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function start() {
  wire();

  viewport = new FaceViewport($('viewport'), (index, { dx, dy }) => {
    const attachment = editor.project.attachments[index];
    if (!attachment) return;
    editor.setAttachment(index, {
      offsetX: round((attachment.offsetX ?? 0) + dx),
      offsetY: round((attachment.offsetY ?? 0) + dy),
    });
  });
  viewport.onSelect = (index) => editor.select({ kind: 'attachment', index });

  try {
    const mesh = await fetch('face/canonical_face_model.obj').then((it) => it.text());
    await viewport.load(mesh);
  } catch (error) {
    // The face is the centre of this tool, so its absence is said out loud
    // rather than leaving an empty black rectangle that reads as a hang.
    $('viewport').append(
      element('p', {
        class: 'empty',
        text: `The face mesh would not load: ${error}`,
      }),
    );
  }

  draw();
}

const round = (value) => Math.round(value * 10000) / 10000;

start();
