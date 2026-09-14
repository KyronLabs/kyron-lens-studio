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
  // The selection travelled one way only: clicking the face told the tree,
  // and picking the same attachment out of the tree told the face nothing. So
  // an attachment selected from the list was highlighted everywhere except on
  // the face it is on, and its handles -- which are the only way to resize or
  // turn it -- never appeared at all.
  viewport?.select(
    editor.selection.kind === 'attachment' ? editor.selection.index : -1,
  );
  drawPhoto(lens);
  drawFirstRun();

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

/** What the controls on screen were built for. See [drawInspector]. */
let inspectorShape = null;

/**
 * The inspector, rebuilt only when the set of controls actually changes.
 *
 * It used to call `replaceChildren` on every draw -- and every keystroke is a
 * draw, because typing fires the field's own `input` listener, which edits
 * the project, which redraws. So typing one character destroyed the field it
 * had just been typed into, and the caret went with it: the next character
 * needed another click. A name cost as many clicks as it had letters.
 *
 * The controls are now rebuilt only when the selection changes, or when
 * something changes which controls there should be. Otherwise the fresh build
 * is used as a source of values and thrown away, and the controls on screen
 * keep their identity.
 *
 * Whatever has focus is not written to at all. It already holds the newest
 * value -- it is what produced this draw -- and writing to it would move the
 * caret to the end, which is the same bug in a quieter form.
 */
function drawInspector() {
  const body = $('inspector');
  const fresh = document.createElement('div');
  const shape = buildInspector(fresh);
  // Null means the selection pointed at something that is gone, and building
  // it redirected; that redraw is already on its way.
  if (shape === null) return;

  if (shape === inspectorShape) {
    syncControls(body, fresh);
    return;
  }
  inspectorShape = shape;
  body.replaceChildren(...fresh.childNodes);
}

/** Copies values into the live controls, leaving the one in use alone. */
function syncControls(live, fresh) {
  const from = fresh.querySelectorAll('input, select');
  const into = live.querySelectorAll('input, select');

  // A shape key that missed something. Rebuilding is worse than syncing but
  // far better than writing each value into whichever control happens to sit
  // at that index.
  if (from.length !== into.length) {
    live.replaceChildren(...fresh.childNodes);
    return;
  }

  into.forEach((control, at) => {
    if (control === document.activeElement) return;
    if (control.value !== from[at].value) control.value = from[at].value;
  });

  // A segmented control carries its state in a class, and a picker carries
  // its in the trigger's text, so neither is an `input` the pass above
  // reaches. Without this an undo would move the numbers and leave the anchor
  // showing whatever it showed before.
  const pairs = [
    ['.segment', (node, from) => {
      const on = from.classList.contains('is-on');
      node.classList.toggle('is-on', on);
      node.setAttribute('aria-checked', String(on));
    }],
    ['.picker', (node, from) => {
      node.textContent = from.textContent;
    }],
  ];
  for (const [selector, apply] of pairs) {
    const from = fresh.querySelectorAll(selector);
    const into = live.querySelectorAll(selector);
    if (from.length !== into.length) continue;
    into.forEach((node, at) => apply(node, from[at]));
  }

  // The readout beside a slider and the unit next to it are text rather than
  // a control value, so they are copied separately.
  const labelsFrom = fresh.querySelectorAll('.value, .unit');
  const labelsInto = live.querySelectorAll('.value, .unit');
  if (labelsFrom.length === labelsInto.length) {
    labelsInto.forEach((node, at) => {
      node.textContent = labelsFrom[at].textContent;
    });
  }
}

/**
 * Fills [body] with the controls for the current selection.
 *
 * Returns a key describing which controls those are: two builds with the same
 * key have the same controls in the same order, so one can be synced into the
 * other. Null when the selection pointed at something that no longer exists.
 */
function buildInspector(body) {
  const selection = editor.selection;

  if (selection.kind === 'lens') {
    $('inspector-title').textContent = 'Lens';
    body.append(
      text('Name', editor.project.name, (value) => editor.setField('name', value)),
      text('Id', editor.project.id, (value) => editor.setField('id', value)),
      note('Lowercase letters, digits, - and _. This is the filename the catalogue keys on and it cannot change once published.'),
      text('Author', editor.project.author, (value) => editor.setField('author', value)),
    );
    return 'lens';
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
    // The typed note appears and disappears, which changes the shape.
    return `colour:${editor.colourIsTyped}`;
  }

  if (selection.kind === 'attachment') {
    const attachment = editor.project.attachments[selection.index];
    if (!attachment) {
      editor.select(LENS);
      return null;
    }
    $('inspector-title').textContent = `Attachment ${selection.index + 1}`;

    const set = (changes) => editor.setAttachment(selection.index, changes);
    body.append(
      choose('Artwork', attachment.resource ?? '', [
        { value: '', label: '— none —' },
        ...editor.project.resources.map((it) => ({ value: it.name, label: it.name })),
      ], (value) => set({ resource: value || null })),
      choose('Anchor', attachment.anchor, ANCHORS.map((it) => ({ value: it, label: it })),
        (value) => set({ anchor: value })),
      note('The feature this is measured from. Everything below is in ' +
        'pupil-gaps out from it, so the lens lands in the same place on a ' +
        'face of any size.'),
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
    // The index, because the listeners close over it, and the resources,
    // because they are the Artwork select's options.
    const names = editor.project.resources.map((it) => it.name).join('|');
    return `attachment:${selection.index}:${names}`;
  }

  if (selection.kind === 'effect') {
    const effect = editor.project.effects[selection.index];
    if (!effect) {
      editor.select(LENS);
      return null;
    }
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
    return `effect:${selection.index}:${effect.kind}`;
  }

  return 'none';
}

function matrixGrid() {
  const grid = element('div', { class: 'matrix' });
  const matrix = editor.matrix ?? fromAdjustments({});
  matrix.forEach((value, index) => {
    const field = document.createElement('input');
    field.value = show(value, 4);
    if (index % 5 === 4) field.className = 'offset';
    field.addEventListener('change', () => {
      // Read at the moment of the edit rather than from the snapshot this
      // grid was built with. The controls now outlive the build that made
      // them -- the inspector syncs values into them instead of replacing
      // them -- so a closed-over copy would be one edit behind.
      const next = [...(editor.matrix ?? fromAdjustments({}))];
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

/** Past this many options a panel cannot show them all, so they get a list. */
const SHOW_ALL_UP_TO = 6;

/**
 * A choice between named options.
 *
 * Six or fewer are all drawn, because a reader should be able to see what
 * their options are without pressing anything -- desktop/philosophy.md §5.
 * Choosing an anchor from five is then one click and no hidden state, which
 * is the same rule the phone app follows by using a sheet rather than a
 * drop-down, arrived at for the platform rather than copied from it.
 *
 * Longer lists, which here means the artwork in a project, get a popover
 * anchored under the trigger.
 *
 * Neither is a native `<select>`. A select hands the list to the operating
 * system, which draws it in its own type and its own colours.
 */
function choose(label, value, options, onChange) {
  return options.length <= SHOW_ALL_UP_TO
    ? segmented(label, value, options, onChange)
    : picker(label, value, options, onChange);
}

function segmented(label, value, options, onChange) {
  const field = element('div', { class: 'field' });
  const group = element('div', { class: 'segmented' });
  group.setAttribute('role', 'radiogroup');
  group.setAttribute('aria-label', label);

  for (const option of options) {
    const on = option.value === value;
    const segment = element('button', {
      class: on ? 'segment is-on' : 'segment',
      text: option.label,
    });
    segment.type = 'button';
    segment.setAttribute('role', 'radio');
    segment.setAttribute('aria-checked', String(on));
    segment.addEventListener('click', () => onChange(option.value));
    group.append(segment);
  }

  field.append(element('label', { text: label }), group);
  return field;
}

function picker(label, value, options, onChange) {
  const field = element('div', { class: 'field' });
  const chosen = options.find((it) => it.value === value);
  const trigger = element('button', {
    class: 'picker',
    text: chosen ? chosen.label : '—',
  });
  trigger.type = 'button';
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.addEventListener('click', () =>
    openPicker(trigger, value, options, onChange));
  field.append(element('label', { text: label }), trigger);
  return field;
}

/**
 * The list a [picker] opens, under its trigger.
 *
 * Escape closes it, a click outside closes it, the arrows move and Enter
 * chooses -- all of which a native select would have given for free, and none
 * of which is worth handing the operating system the look of the window for.
 */
function openPicker(trigger, value, options, onChange) {
  document.querySelector('.popover')?.remove();

  const list = element('div', { class: 'popover' });
  list.setAttribute('role', 'listbox');

  const box = trigger.getBoundingClientRect();
  list.style.left = `${box.left}px`;
  list.style.top = `${box.bottom + 2}px`;
  list.style.minWidth = `${box.width}px`;

  const items = options.map((option) => {
    const on = option.value === value;
    const item = element('button', {
      class: on ? 'popover-item is-on' : 'popover-item',
      text: option.label,
    });
    item.type = 'button';
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(on));
    item.addEventListener('click', () => {
      close();
      onChange(option.value);
    });
    list.append(item);
    return item;
  });

  function close() {
    list.remove();
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('keydown', onKey, true);
    trigger.focus();
  }

  function onOutside(event) {
    if (!list.contains(event.target) && event.target !== trigger) close();
  }

  function onKey(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const at = items.indexOf(document.activeElement);
    const step = event.key === 'ArrowDown' ? 1 : -1;
    const next = at < 0 ? 0 : (at + step + items.length) % items.length;
    items[next].focus();
  }

  document.body.append(list);
  // Below the trigger unless that runs off the bottom, which on a short
  // window is where a list of artwork lands.
  const drawn = list.getBoundingClientRect();
  if (drawn.bottom > globalThis.innerHeight - 8) {
    list.style.top = `${Math.max(8, box.top - drawn.height - 2)}px`;
  }

  (items.find((it) => it.classList.contains('is-on')) ?? items[0])?.focus();
  document.addEventListener('pointerdown', onOutside, true);
  document.addEventListener('keydown', onKey, true);
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
    } else if (key === 'o') {
      // Was only ever on the menu, which has gone.
      event.preventDefault();
      openProject();
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

  $('open').addEventListener('click', openProject);

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

/** Opens a project file. The button and Ctrl+O both come here. */
async function openProject() {
  if (!studio) return;
  const opened = await studio.openProject();
  if (!opened) return;
  location.reload();
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

  // Building the viewport means creating a WebGL context, and that throws on
  // a machine that cannot give one -- a blocked driver, a remote desktop, a
  // virtual machine with no GPU. It used to be the first statement in this
  // function and outside any catch, so that throw took the whole of `start`
  // with it, including the `draw()` at the end: no face, and no panels
  // either, from a window that had just opened cleanly.
  try {
    viewport = buildViewport();
  } catch (error) {
    viewport = null;
    showTrouble(
      'This machine could not give the studio a 3D view: ' +
        `${error}. Everything else works, and the numbers in the inspector ` +
        'are the lens -- the face is a picture of them.',
    );
  }

  try {
    const mesh = await fetch('face/canonical_face_model.obj').then((it) => it.text());
    await viewport?.load(mesh);
  } catch (error) {
    // The face is the centre of this tool, so its absence is said out loud
    // rather than leaving an empty black rectangle that reads as a hang.
    if (viewport) showTrouble(`The face mesh would not load: ${error}`);
  }

  draw();
}

/**
 * What to do first, while there is nothing to look at.
 *
 * A window of eight panels and a bare face is a cockpit: it says what the
 * tool *has* and nothing about what it is for or where to start. This is one
 * sentence and one button, and it goes away the moment there is anything in
 * the lens.
 */
function drawFirstRun() {
  const empty =
    editor.project.attachments.length === 0 &&
    editor.project.effects.length === 0;

  const already = $('view-face').querySelector('.first-run');
  if (!empty) {
    already?.remove();
    return;
  }
  if (already) return;

  const panel = element('div', { class: 'first-run' });
  panel.append(
    element('p', {
      class: 'first-run-line',
      text: 'A lens is artwork pinned to a face. Import a PNG or paint one, ' +
        'add an attachment, then drag it where it should sit.',
    }),
  );

  const actions = element('div', { class: 'first-run-actions' });
  for (const [label, kind, target] of [
    ['Import artwork…', 'primary', 'import'],
    ['Paint one instead', 'ghost', 'paint'],
  ]) {
    const button = element('button', { class: kind, text: label });
    button.type = 'button';
    button.addEventListener('click', () => $(target).click());
    actions.append(button);
  }
  panel.append(actions);

  $('view-face').append(panel);
}

/** The workspace's message, shown over the face or instead of it. */
function showTrouble(words) {
  const host = $('viewport');
  host.querySelector('.viewport-trouble')?.remove();
  if (!words) return;
  host.append(element('p', { class: 'viewport-trouble', text: words }));
}

function buildViewport() {
  const made = new FaceViewport($('viewport'), (index, change) => {
    const attachment = editor.project.attachments[index];
    if (!attachment) return;

    // A corner handle sends the width it dragged out, and the rotate handle
    // the angle -- both absolute, because both are computed from where the
    // drag started rather than from the last frame. Moving is still a delta.
    if (change.width !== undefined) {
      editor.setAttachment(index, { width: round(change.width) });
      return;
    }
    if (change.rotation !== undefined) {
      // Two places, which is what `attachmentFor` writes rotations to.
      editor.setAttachment(index, {
        rotation: Math.round(change.rotation * 100) / 100,
      });
      return;
    }
    editor.setAttachment(index, {
      offsetX: round((attachment.offsetX ?? 0) + change.dx),
      offsetY: round((attachment.offsetY ?? 0) + change.dy),
    });
  });
  made.onSelect = (index) => editor.select({ kind: 'attachment', index });
  made.onTrouble = (words) =>
    showTrouble(
      words && `${words} ${JSON.stringify(made.diagnostics())}`,
    );
  return made;
}

const round = (value) => Math.round(value * 10000) / 10000;

start();
