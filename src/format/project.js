// src/format/project.js
//
// What the studio holds while somebody is working, and how that becomes the
// lens that gets published.
//
// The two are deliberately not the same thing. A lens is the twenty numbers
// and a list of attachments with HTTPS URLs on them -- the smallest thing the
// app can draw. A project is that plus everything needed to *edit* it again:
// which sliders produced the matrix, which local file an attachment came from
// before it had a URL, what the artwork actually is.
//
// Keeping the sliders is the part that matters. A matrix cannot be turned
// back into the adjustments that made it -- many settings reach the same
// twenty numbers -- so a studio that stored only the lens would open its own
// work with every control back at rest, and the first touch of any of them
// would throw the lens away. See the note at the top of matrix.js.
//
// `toLens` is the join: it produces exactly the object that will be written
// into the catalogue, and nothing in the studio previews anything else.

import { fromAdjustments, isIdentity } from './matrix.js';
import { problems } from './lens.js';

/** The shape written to disk. Bumped only for a change that needs migrating. */
export const PROJECT_VERSION = 1;

/**
 * Where a published attachment is served from.
 *
 * kyron-lenses is a GitHub Pages site, and this is the prefix its `assets/`
 * directory lands on. A lens whose asset URL does not start with this will
 * still publish -- the format only asks for HTTPS -- but it will be pointing
 * at somebody else's server, which is not what the publish flow is for.
 */
export const ASSET_BASE = 'https://kyronlabs.github.io/kyron-lenses/assets/';

/** A project with nothing in it. */
export function blank(id = 'untitled') {
  return {
    version: PROJECT_VERSION,
    id,
    name: 'Untitled',
    author: '',
    colour: { adjustments: {}, matrix: null },
    attachments: [],
    effects: [],
    resources: [],
  };
}

/**
 * Reads a project file, filling in anything a older or hand-edited one is
 * missing.
 *
 * Forgiving on the way in and strict on the way out: a project is the
 * studio's own scratch file, and refusing to open one because a field is
 * absent loses somebody's work. What must be strict is [toLens], because that
 * is what reaches a phone.
 */
export function load(raw) {
  const source = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!source || typeof source !== 'object') {
    throw new TypeError('that is not a project file');
  }
  const base = blank(typeof source.id === 'string' ? source.id : 'untitled');
  return {
    ...base,
    ...source,
    version: PROJECT_VERSION,
    colour: { ...base.colour, ...(source.colour ?? {}) },
    attachments: Array.isArray(source.attachments) ? [...source.attachments] : [],
    effects: Array.isArray(source.effects) ? [...source.effects] : [],
    resources: Array.isArray(source.resources) ? [...source.resources] : [],
  };
}

/** A project as the text that goes in the file. */
export function save(project) {
  return `${JSON.stringify({ ...project, version: PROJECT_VERSION }, null, 2)}\n`;
}

/**
 * The colour matrix this project publishes, or null for a lens that does not
 * change colour.
 *
 * A hand-written matrix wins over the sliders, because it is the thing
 * somebody typed and the sliders cannot describe it. The studio shows the raw
 * numbers in that case and greys the panel rather than pretending.
 */
export function matrixFor(project) {
  const colour = project.colour ?? {};
  if (Array.isArray(colour.matrix)) return colour.matrix;
  const built = fromAdjustments(colour.adjustments ?? {});
  return isIdentity(built) ? null : built;
}

/**
 * The smallest schema that can carry what this project contains.
 *
 * Stated rather than guessed at publish time: a lens claiming a schema it
 * does not need is refused by nothing, but a lens claiming *less* than it
 * needs is dropped by the app with its explanation in a log line on a
 * stranger's phone.
 */
export function schemaFor(project) {
  if ((project.effects ?? []).length) return 3;
  if ((project.attachments ?? []).length) return 2;
  return 1;
}

/**
 * The lens exactly as it will be published.
 *
 * Every preview in the studio is drawn from this rather than from the
 * project, so what somebody is looking at is the file and not the editor's
 * idea of it.
 */
export function toLens(project, { assetBase = ASSET_BASE } = {}) {
  const lens = {
    id: project.id,
    name: project.name,
    schema: schemaFor(project),
  };
  if (project.author) lens.author = project.author;

  const matrix = matrixFor(project);
  if (matrix) lens.matrix = matrix;

  const attachments = (project.attachments ?? []).map((item) => {
    const out = {
      asset: item.asset ?? assetUrlFor(item, assetBase),
      anchor: item.anchor,
      width: item.width,
    };
    // Written only when they are not the default, because the format's
    // defaults are zero and a file full of `"offsetX": 0` is noise in review.
    if (item.offsetX) out.offsetX = item.offsetX;
    if (item.offsetY) out.offsetY = item.offsetY;
    if (item.rotation) out.rotation = item.rotation;
    return out;
  });
  if (attachments.length) lens.attachments = attachments;

  const effects = (project.effects ?? []).map((item) => ({ ...item }));
  if (effects.length) lens.effects = effects;

  return lens;
}

/** Where a resource will be served from once the catalogue has it. */
export function assetUrlFor(attachment, assetBase = ASSET_BASE) {
  const name = attachment.resource ?? '';
  return `${assetBase}${name}`;
}

/**
 * Everything standing between this project and being published.
 *
 * The format's own objections first, in the app's words, and then the ones
 * only the studio can see: artwork that has not been imported yet, and a
 * lens that does nothing at all.
 */
export function blockers(project, options = {}) {
  const found = problems(toLens(project, options)).map((why) => ({
    kind: 'format',
    why,
  }));

  const known = new Set((project.resources ?? []).map((it) => it.name));
  (project.attachments ?? []).forEach((item, index) => {
    if (item.asset) return; // Already published somewhere.
    if (!item.resource) {
      found.push({
        kind: 'missing-artwork',
        why: `attachment ${index}: nothing has been drawn for it yet`,
      });
    } else if (!known.has(item.resource)) {
      found.push({
        kind: 'missing-artwork',
        why: `attachment ${index}: ${item.resource} is not in this project`,
      });
    }
  });

  if (
    !matrixFor(project) &&
    !(project.attachments ?? []).length &&
    !(project.effects ?? []).length
  ) {
    found.push({
      kind: 'empty',
      why: 'this lens does nothing: no colour, no attachments, no effects',
    });
  }

  return found;
}

/** Whether the catalogue would take this as it stands. */
export function publishable(project, options = {}) {
  return blockers(project, options).length === 0;
}

/**
 * The files a publish writes: the catalogue entry, and the artwork beside it.
 *
 * Returned rather than written, so the same answer can be shown in the studio
 * before anybody commits to anything and used by whatever does the writing.
 */
export function publishPlan(project, options = {}) {
  const lens = toLens(project, options);
  const byName = new Map((project.resources ?? []).map((it) => [it.name, it]));

  const files = [];
  for (const attachment of project.attachments ?? []) {
    if (attachment.asset || !attachment.resource) continue;
    const resource = byName.get(attachment.resource);
    if (!resource) continue;
    const path = `assets/${attachment.resource}`;
    if (files.some((file) => file.path === path)) continue;
    files.push({ path, bytes: resource.bytes, from: attachment.resource });
  }

  return { lens, files, blockers: blockers(project, options) };
}
