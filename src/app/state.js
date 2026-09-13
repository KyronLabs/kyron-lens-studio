// src/app/state.js
//
// The editor, as a thing that can be tested without a window.
//
// Everything the studio does to a project goes through here: selecting
// something, changing it, undoing it. The renderer is then only a way of
// looking at this and a set of buttons that call into it -- which is what
// makes the interesting parts checkable in a test runner rather than only by
// somebody clicking around on Windows.
//
// The rule it is built on: **the project is never mutated in place.** Every
// change produces a new project, which is what makes undo a stack of
// references rather than a log of reverse operations that has to be kept
// correct by hand.

import { blank, blockers, load, matrixFor, save, toLens } from '../format/project.js';
import { NEUTRAL } from '../format/matrix.js';

/** How far back undo goes. Deep enough to cover a session of nudging. */
export const HISTORY = 100;

/**
 * A selection: what the inspector is currently showing.
 *
 * `kind` is one of 'lens' (the lens itself), 'colour', 'attachment' or
 * 'effect'; `index` applies to the two that are lists.
 */
export const LENS = { kind: 'lens' };
export const COLOUR = { kind: 'colour' };

export class Editor {
  /**
   * @param {object} [project] an existing project, or a blank one
   * @param {(editor: Editor) => void} [onChange] called after every change
   */
  constructor(project = blank(), onChange = () => {}) {
    this._project = project;
    this._past = [];
    this._future = [];
    this._selection = LENS;
    this._saved = project;
    this.onChange = onChange;
  }

  static open(raw, onChange) {
    return new Editor(load(raw), onChange);
  }

  get project() {
    return this._project;
  }

  get selection() {
    return this._selection;
  }

  /** The lens exactly as it would be published right now. */
  get lens() {
    return toLens(this._project);
  }

  /** Everything standing between this and the catalogue. */
  get blockers() {
    return blockers(this._project);
  }

  /** Whether there are changes that have not been written to disk. */
  get dirty() {
    return this._project !== this._saved;
  }

  get canUndo() {
    return this._past.length > 0;
  }

  get canRedo() {
    return this._future.length > 0;
  }

  /** The file's text, and a note that the file now matches. */
  toFile() {
    this._saved = this._project;
    return save(this._project);
  }

  // -------------------------------------------------------------------------
  // Changing things
  // -------------------------------------------------------------------------

  /**
   * Applies `change` to the project and remembers the version before it.
   *
   * `change` is handed the current project and returns a new one. Returning
   * the same object, or an equal one, is treated as "nothing happened" and
   * does not land on the undo stack -- otherwise dragging a slider back to
   * where it started fills the history with a hundred steps that do nothing.
   */
  edit(change, { merge = null } = {}) {
    const next = change(this._project);
    if (!next || next === this._project) return this;
    if (JSON.stringify(next) === JSON.stringify(this._project)) return this;

    // A `merge` tag collapses a run of changes of the same kind into one undo
    // step: dragging a slider is one action to whoever dragged it, not the
    // forty frames it took. The snapshot already on the stack is the one from
    // before the drag started, so continuing a run means pushing nothing.
    const last = this._past[this._past.length - 1];
    const continuing = merge !== null && last !== undefined && last.merge === merge;
    if (!continuing) {
      this._past.push({ project: this._project, merge });
      if (this._past.length > HISTORY) this._past.shift();
    }

    this._future.length = 0;
    this._project = next;
    this.onChange(this);
    return this;
  }

  undo() {
    const previous = this._past.pop();
    if (!previous) return this;
    this._future.push({ project: this._project, merge: previous.merge });
    this._project = previous.project;
    this.onChange(this);
    return this;
  }

  redo() {
    const next = this._future.pop();
    if (!next) return this;
    this._past.push({ project: this._project, merge: next.merge });
    this._project = next.project;
    this.onChange(this);
    return this;
  }

  select(selection) {
    this._selection = selection;
    this.onChange(this);
    return this;
  }

  // -------------------------------------------------------------------------
  // The lens itself
  // -------------------------------------------------------------------------

  setField(name, value) {
    return this.edit((project) => ({ ...project, [name]: value }), {
      merge: `field:${name}`,
    });
  }

  // -------------------------------------------------------------------------
  // Colour
  // -------------------------------------------------------------------------

  setAdjustment(name, value) {
    return this.edit(
      (project) => ({
        ...project,
        colour: {
          ...project.colour,
          // A slider moved means the sliders are what describes this lens
          // now, so a matrix somebody typed earlier stops winning. Silently
          // keeping it would make every control on the panel inert.
          matrix: null,
          adjustments: { ...project.colour.adjustments, [name]: value },
        },
      }),
      { merge: `adjust:${name}` },
    );
  }

  resetColour() {
    return this.edit((project) => ({
      ...project,
      colour: { adjustments: {}, matrix: null },
    }));
  }

  /** Twenty numbers, typed rather than dialled. */
  setMatrix(matrix) {
    return this.edit((project) => ({
      ...project,
      colour: { ...project.colour, matrix },
    }));
  }

  /** Whether the sliders describe this lens, or a typed matrix does. */
  get colourIsTyped() {
    return Array.isArray(this._project.colour?.matrix);
  }

  get adjustments() {
    return { ...NEUTRAL, ...(this._project.colour?.adjustments ?? {}) };
  }

  get matrix() {
    return matrixFor(this._project);
  }

  // -------------------------------------------------------------------------
  // Attachments
  // -------------------------------------------------------------------------

  addAttachment(attachment = {}) {
    const added = {
      resource: null,
      anchor: 'eyes',
      width: 2,
      offsetX: 0,
      offsetY: 0,
      rotation: 0,
      ...attachment,
    };
    this.edit((project) => ({
      ...project,
      attachments: [...project.attachments, added],
    }));
    return this.select({
      kind: 'attachment',
      index: this._project.attachments.length - 1,
    });
  }

  setAttachment(index, changes) {
    return this.edit(
      (project) => ({
        ...project,
        attachments: project.attachments.map((item, at) =>
          at === index ? { ...item, ...changes } : item,
        ),
      }),
      { merge: `attachment:${index}:${Object.keys(changes).join(',')}` },
    );
  }

  removeAttachment(index) {
    this.edit((project) => ({
      ...project,
      attachments: project.attachments.filter((_, at) => at !== index),
    }));
    return this.select(LENS);
  }

  // -------------------------------------------------------------------------
  // Effects
  // -------------------------------------------------------------------------

  addEffect(kind) {
    const added =
      kind === 'frost'
        ? { kind: 'frost', blur: 0.16, desaturate: 0.3, lift: 0.16, feather: 0.05 }
        : { kind: 'fill', region: 'lowerFace', feather: 0.14, keepShading: 0.35 };
    this.edit((project) => ({ ...project, effects: [...project.effects, added] }));
    return this.select({ kind: 'effect', index: this._project.effects.length - 1 });
  }

  setEffect(index, changes) {
    return this.edit(
      (project) => ({
        ...project,
        effects: project.effects.map((item, at) =>
          at === index ? { ...item, ...changes } : item,
        ),
      }),
      { merge: `effect:${index}:${Object.keys(changes).join(',')}` },
    );
  }

  removeEffect(index) {
    this.edit((project) => ({
      ...project,
      effects: project.effects.filter((_, at) => at !== index),
    }));
    return this.select(LENS);
  }

  // -------------------------------------------------------------------------
  // Resources
  // -------------------------------------------------------------------------

  /**
   * Adds artwork, or replaces artwork of the same name.
   *
   * Replacing rather than adding a second copy is deliberate: importing the
   * same file twice is how somebody iterates on a drawing, and two resources
   * with one name would publish one of them at random.
   */
  addResource(resource) {
    return this.edit((project) => ({
      ...project,
      resources: [
        ...project.resources.filter((it) => it.name !== resource.name),
        resource,
      ],
    }));
  }

  removeResource(name) {
    return this.edit((project) => ({
      ...project,
      resources: project.resources.filter((it) => it.name !== name),
      // And unhook it from anything using it, so what is on screen matches
      // what would publish rather than pointing at a file that is gone.
      attachments: project.attachments.map((item) =>
        item.resource === name ? { ...item, resource: null } : item,
      ),
    }));
  }

  resource(name) {
    return (this._project.resources ?? []).find((it) => it.name === name) ?? null;
  }
}
