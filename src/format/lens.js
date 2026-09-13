// src/format/lens.js
//
// The lens rules, in JavaScript.
//
// There were already two implementations of these rules: `Lens.tryParse` in
// the Kyron app (Dart) and `problems()` in kyron-lenses `tools/lens.py`. That
// repository's FORMAT.md is blunt about why a third is dangerous -- "a lens
// that passes the tool, gets published, and is then dropped by the app leaves
// its explanation in a log line on a stranger's phone."
//
// This one exists anyway, for one reason: the studio has to tell somebody
// their lens is wrong *while they are drawing it*, and shelling out to Python
// on every keystroke would mean shipping a Python runtime inside a Windows
// app to answer a question that is twenty comparisons.
//
// What makes it safe is the same thing that makes the other two safe:
// `test/format-vectors.json` is copied from kyron-lenses and run against this
// file on every change. All 106 cases, or the build fails. If a rule is
// tightened over there and not here, the vectors say so before anybody
// publishes anything.
//
// Read alongside tools/lens.py in kyron-lenses. The structure is deliberately
// the same -- same function names, same order, same messages -- so the two can
// be diffed by eye.

const MATRIX_LENGTH = 20;
const MAX_COEFFICIENT = 8.0;
const MAX_OFFSET = 255.0;
const ID = /^[a-z0-9][a-z0-9_-]*$/;

/** 1: a colour matrix. 2: attachments on a tracked face. 3: effects. */
export const SUPPORTED_SCHEMA = 3;

export const ANCHORS = ['eyes', 'nose', 'mouth', 'forehead', 'chin'];
export const REGIONS = ['lowerFace', 'eyes', 'face'];

const MAX_ATTACHMENTS = 8;
const MAX_ATTACHMENT_WIDTH = 12.0;
const MAX_ATTACHMENT_OFFSET = 8.0;
const MAX_EFFECTS = 4;

/** Every number an effect takes: [default, low, high]. */
const EFFECT_NUMBERS = {
  fill: { feather: [0.14, 0.0, 2.0], keepShading: [0.35, 0.0, 1.0] },
  frost: {
    blur: [0.16, 0.0, 2.0],
    desaturate: [0.3, 0.0, 1.0],
    lift: [0.16, 0.0, 1.0],
    feather: [0.05, 0.0, 2.0],
  },
};

/**
 * A real, finite number.
 *
 * `typeof` already excludes booleans, which is the trap the Python version has
 * to work around -- there, `isinstance(True, int)` is true.
 */
function isNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/** How a value is spelled back to somebody, close to Python's `repr`. */
function show(value) {
  if (typeof value === 'string') return `'${value}'`;
  if (value === undefined) return 'None';
  if (value === null) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  return JSON.stringify(value);
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Everything wrong with one effect. */
export function effectProblems(item, where) {
  const found = [];
  if (!isObject(item)) return [`${where}: not an object`];

  const kind = item.kind;
  if (!Object.prototype.hasOwnProperty.call(EFFECT_NUMBERS, kind)) {
    return [
      `${where}: kind ${show(kind)} must be one of ` +
        `${Object.keys(EFFECT_NUMBERS).sort().join(', ')}`,
    ];
  }

  for (const [field, [fallback, low, high]] of Object.entries(
    EFFECT_NUMBERS[kind],
  )) {
    // An explicit null is the default, not an error: the app reads
    // `json['feather'] ?? 0.14`, and this has to agree or a lens passes here
    // and disappears on the phone.
    let value = item[field];
    if (value === null || value === undefined) value = fallback;
    if (!isNumber(value)) {
      found.push(`${where}: ${field} ${show(value)} is not a number`);
    } else if (!(low <= value && value <= high)) {
      found.push(`${where}: ${field} ${value} is outside ${low} to ${high}`);
    }
  }

  if (kind === 'fill') {
    const region = item.region;
    if (!REGIONS.includes(region)) {
      found.push(
        `${where}: region ${show(region)} must be one of ${REGIONS.join(', ')}`,
      );
    }
  } else {
    // A blur of zero is not frost, it is nothing.
    let blur = item.blur;
    if (blur === null || blur === undefined) blur = EFFECT_NUMBERS.frost.blur[0];
    if (isNumber(blur) && blur <= 0) {
      found.push(`${where}: blur must be above 0, not ${blur}`);
    }

    const reveal = item.reveal;
    if (reveal !== null && reveal !== undefined && !REGIONS.includes(reveal)) {
      found.push(
        `${where}: reveal ${show(reveal)} must be one of ${REGIONS.join(', ')}`,
      );
    }
  }

  return found;
}

/** Everything wrong with one attachment. */
export function attachmentProblems(item, where) {
  const found = [];
  if (!isObject(item)) return [`${where}: not an object`];

  const asset = item.asset;
  // HTTPS only. A lens is data the app fetches, and anything else in a
  // published catalogue is a mistake or somebody testing what it will load.
  if (typeof asset !== 'string' || !asset.startsWith('https://')) {
    found.push(`${where}: asset must be an https:// URL, got ${show(asset)}`);
  } else if (asset.length > 500) {
    found.push(`${where}: asset URL is over 500 characters`);
  }

  const anchor = item.anchor;
  if (!ANCHORS.includes(anchor)) {
    found.push(
      `${where}: anchor ${show(anchor)} must be one of ${ANCHORS.join(', ')}`,
    );
  }

  const width = item.width;
  if (!isNumber(width)) {
    found.push(`${where}: width ${show(width)} is not a number`);
  } else if (!(width > 0 && width <= MAX_ATTACHMENT_WIDTH)) {
    found.push(
      `${where}: width ${width} must be above 0 and at most ` +
        `${MAX_ATTACHMENT_WIDTH} (multiples of the interpupillary distance)`,
    );
  }

  for (const axis of ['offsetX', 'offsetY']) {
    const value = item[axis] === undefined ? 0 : item[axis];
    if (!isNumber(value)) {
      found.push(`${where}: ${axis} ${show(value)} is not a number`);
    } else if (Math.abs(value) > MAX_ATTACHMENT_OFFSET) {
      found.push(
        `${where}: ${axis} ${value} is outside +/-${MAX_ATTACHMENT_OFFSET}`,
      );
    }
  }

  const rotation = item.rotation === undefined ? 0 : item.rotation;
  if (!isNumber(rotation)) {
    found.push(`${where}: rotation ${show(rotation)} is not a number`);
  } else if (Math.abs(rotation) > 360) {
    found.push(`${where}: rotation ${rotation} is outside +/-360`);
  }

  return found;
}

/**
 * Everything wrong with one lens, in the words the app would use.
 *
 * An empty array means the app will draw it.
 */
export function problems(lens) {
  const found = [];
  if (!isObject(lens)) return ['not an object'];

  const id = lens.id;
  if (typeof id !== 'string' || !ID.test(id) || id.length > 40) {
    found.push(`id ${show(id)} must be lowercase letters, digits, - and _`);
  }

  const name = lens.name;
  if (typeof name !== 'string' || !name.trim() || name.length > 40) {
    found.push(`name ${show(name)} must be 1-40 characters`);
  }

  const author = lens.author;
  if (
    author !== null &&
    author !== undefined &&
    (typeof author !== 'string' || author.length > 80)
  ) {
    found.push('author must be a string of at most 80 characters');
  }

  let schema = lens.schema === undefined ? 1 : lens.schema;
  // Number.isInteger is the whole check: JSON has one number type, and a
  // `2.0` in the file arrives here as 2 in JavaScript and as 2.0 in Python.
  // Python's isinstance(2.0, int) is false, so that lens is refused there and
  // would be accepted here. The vectors would catch it; it is spelled out
  // because it is the one place the two languages genuinely disagree.
  if (!Number.isInteger(schema) || !(schema >= 1 && schema <= SUPPORTED_SCHEMA)) {
    found.push(
      `schema ${show(schema)} must be an integer from 1 to ${SUPPORTED_SCHEMA}`,
    );
    schema = 1;
  }

  const attachments = lens.attachments;
  if (attachments !== null && attachments !== undefined) {
    if (!Array.isArray(attachments)) {
      found.push('attachments must be a list');
    } else if (attachments.length > MAX_ATTACHMENTS) {
      found.push(`at most ${MAX_ATTACHMENTS} attachments`);
    } else {
      attachments.forEach((item, index) => {
        found.push(...attachmentProblems(item, `attachment ${index}`));
      });
      if (attachments.length && schema < 2) {
        found.push(
          'attachments need schema 2; a lens claiming schema 1 with ' +
            'attachments is lying about what it needs to be drawn',
        );
      }
    }
  }

  const effects = lens.effects;
  if (effects !== null && effects !== undefined) {
    if (!Array.isArray(effects)) {
      found.push('effects must be a list');
    } else if (effects.length > MAX_EFFECTS) {
      found.push(`at most ${MAX_EFFECTS} effects`);
    } else {
      effects.forEach((item, index) => {
        found.push(...effectProblems(item, `effect ${index}`));
      });
      if (effects.length && schema < 3) {
        found.push(
          'effects need schema 3; a lens claiming less with effects ' +
            'is lying about what it needs to be drawn',
        );
      }
    }
  }

  const matrix = lens.matrix;
  // The identity lens, or an attachments-only lens.
  if (matrix === null || matrix === undefined) return found;

  if (!Array.isArray(matrix) || matrix.length !== MATRIX_LENGTH) {
    found.push(
      `matrix must be ${MATRIX_LENGTH} numbers, got ` +
        `${Array.isArray(matrix) ? matrix.length : typeof matrix}`,
    );
    return found;
  }

  matrix.forEach((value, i) => {
    const row = Math.floor(i / 5);
    const col = i % 5;
    const where = `row ${row}, ${col === 4 ? 'offset' : 'column ' + col}`;
    if (!isNumber(value)) {
      found.push(
        `${where}: ${show(value)} is not a usable number ` +
          '(NaN and infinity poison every pixel)',
      );
    } else {
      const limit = col === 4 ? MAX_OFFSET : MAX_COEFFICIENT;
      if (Math.abs(value) > limit) {
        found.push(`${where}: ${value} is outside +/-${limit}`);
      }
    }
  });

  return found;
}

/** Whether the app would draw this lens. */
export function isPublishable(lens) {
  return problems(lens).length === 0;
}
