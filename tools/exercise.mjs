#!/usr/bin/env node
// tools/exercise.mjs
//
// Opens the real application and uses it.
//
//     npm run test:app
//
// `node --test` covers the modules underneath, which are the half that can be
// checked without a window. It saw none of these, and all three reached
// somebody using the installed application:
//
//   - a text field that took one character per click, because every
//     keystroke rebuilt the field it was typed into;
//   - selection handles that never appeared, because the selection travelled
//     from the face to the list and not back;
//   - a rotate handle seven pixels above the top of the canvas.
//
// Each is a sentence about what happens when somebody uses the window, and
// the only way to check a sentence like that is to use the window. So this
// starts Electron, drives it over the debugging protocol, and asserts.
//
// It also takes the pictures, which used to be a second script driving the
// same interface in headless Chromium. Two drivers meant two things to update
// when a control changed, and the one that was not updated broke in CI the
// first time it mattered -- it was still setting `.value` on a `<select>`
// after the last select had gone. One driver, and it is the one that runs the
// real application.
//
// It needs a display. On a runner, and here, that is xvfb-run; the script
// finds one or says what is missing.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const shots = resolve(process.argv[2] ?? '/tmp/kyron-studio-exercise');
const port = 9412;
const cataloguePort = 9413;

// ---------------------------------------------------------------------------
// A library to import from
// ---------------------------------------------------------------------------
//
// The published one is on GitHub Pages, and a check that needs the internet is
// a check that goes red when GitHub has a bad afternoon. This serves the same
// shape from this machine: the application does its own real fetch, over a
// real socket, and applies every rule it applies in production -- the size
// ceiling, the content type, and the refusal to fetch anything that is not
// beside the catalogue. Only the address changes, through the same
// KYRON_ARTWORK_CATALOGUE a staging build would use.

/** A valid RGBA PNG of one colour, built here so the fetch has real bytes. */
function png(size, [r, g, b]) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0; // no filter
    for (let x = 0; x < size; x++) {
      const at = row + 1 + x * 4;
      raw[at] = r; raw[at + 1] = g; raw[at + 2] = b;
      // Transparent at the edges, which is what makes it a sticker.
      const edge = Math.min(x, y, size - 1 - x, size - 1 - y);
      raw[at + 3] = edge < size / 8 ? 0 : 255;
    }
  }

  const chunk = (kind, body) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0);
    head.write(kind, 4, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(kind, 'ascii'), body])), 0);
    return Buffer.concat([head, body, crc]);
  };

  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;   // bit depth
  header[9] = 6;   // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function crc32(buffer) {
  let crc = ~0;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return ~crc >>> 0;
}

const pictures = {
  // Named to collide with the PNG dropped in earlier, on purpose: an
  // attachment points at a resource by name, so the studio has to land this
  // somewhere else rather than quietly repointing artwork already placed.
  '/art/star.png': png(64, [0xff, 0xd5, 0x4f]),
  '/art/moon.png': png(64, [0x4c, 0xd4, 0xb0]),
};

const library = {
  schema: 1,
  artwork: [
    {
      id: 'star', name: 'Star', width: 64, height: 64,
      url: `http://127.0.0.1:${cataloguePort}/art/star.png`,
      author: 'Kyron', licence: 'CC0-1.0', tags: ['shape', 'sparkle'],
    },
    {
      id: 'moon', name: 'Moon', width: 64, height: 64,
      url: `http://127.0.0.1:${cataloguePort}/art/moon.png`,
      author: 'Kyron', licence: 'CC0-1.0', tags: ['night', 'sky'],
    },
    {
      // Refused before any socket is opened: it is not beside the catalogue.
      // A catalogue is a file somebody else edits, and this is what one of
      // them trying to make the studio fetch from elsewhere looks like.
      id: 'elsewhere', name: 'Elsewhere', width: 64, height: 64,
      url: 'https://example.invalid/art/elsewhere.png',
      author: 'Nobody', licence: 'CC0-1.0', tags: [],
    },
  ],
};

/** Every path this served, so a refused URL can be shown never to be asked for. */
const asked = [];
const catalogue = createServer((request, response) => {
  asked.push(request.url);
  if (request.url === '/catalogue.json') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(library));
    return;
  }
  const picture = pictures[request.url];
  if (picture) {
    response.writeHead(200, { 'content-type': 'image/png' });
    response.end(picture);
    return;
  }
  response.writeHead(404).end();
});
await new Promise((ok, no) => {
  catalogue.on('error', no);
  catalogue.listen(cataloguePort, '127.0.0.1', ok);
});

const electron =
  process.env.ELECTRON ?? join(root, 'node_modules/electron/dist/electron');

// A window needs somewhere to open. Under a desktop session DISPLAY is
// already set and Electron is launched directly.
const headless = !process.env.DISPLAY;
const [command, argv] = headless
  ? ['xvfb-run', ['-a', '--server-args=-screen 0 1440x900x24', electron]]
  : [electron, []];

// A run that ended badly can leave a window holding the port, and then the
// next run drives *that* one -- which is how this file once reported a name
// field containing "2". Anything already there is not ours.
try {
  const stale = await fetch(`http://127.0.0.1:${port}/json/version`, {
    signal: AbortSignal.timeout(500),
  });
  if (stale.ok) {
    console.error(`something is already debugging on ${port}; close it first`);
    process.exit(1);
  }
} catch {
  // Nothing there, which is what we want.
}

const app = spawn(
  command,
  [...argv, root, '--no-sandbox', `--remote-debugging-port=${port}`],
  {
    // Its own process group, so closing it closes the Electron underneath.
    // `xvfb-run` is a shell script that execs a server and then the command:
    // killing the script leaves the window running, holding the debugging
    // port, and the next run drives that one instead of its own.
    stdio: ['ignore', 'ignore', 'pipe'],
    detached: true,
    env: {
      ...process.env,
      KYRON_ARTWORK_CATALOGUE: `http://127.0.0.1:${cataloguePort}/catalogue.json`,
    },
  },
);

/** Closes the window and everything it started. */
function close() {
  try {
    process.kill(-app.pid, 'SIGTERM');
  } catch {
    // Already gone.
  }
  catalogue.close();
}
process.on('exit', close);
let stderr = '';
app.stderr.on('data', (chunk) => { stderr += chunk; });
app.on('error', (error) => {
  console.error(`could not start ${command}: ${error.message}`);
  if (headless) console.error('a display is needed: install xvfb, or set DISPLAY');
  process.exit(1);
});

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

/** The debugging endpoint takes a moment, and the window a moment more. */
async function connect() {
  for (let tries = 0; tries < 60; tries++) {
    try {
      const [page] = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      // Not up yet.
    }
    if (app.exitCode !== null) {
      console.error(`the application exited with ${app.exitCode}`);
      console.error(stderr.split('\n').slice(-12).join('\n'));
      process.exit(1);
    }
    await wait(500);
  }
  console.error('the application never opened a debuggable window');
  console.error(stderr.split('\n').slice(-12).join('\n'));
  process.exit(1);
}

const socket = new WebSocket(await connect());
await new Promise((ok, no) => { socket.onopen = ok; socket.onerror = no; });

let id = 0;
const waiting = new Map();
const faults = [];
socket.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id && waiting.has(message.id)) {
    const { ok, no } = waiting.get(message.id);
    waiting.delete(message.id);
    message.error ? no(new Error(JSON.stringify(message.error))) : ok(message.result);
    return;
  }
  // The window is not allowed to throw, and it is not allowed to complain.
  // Both were how the first version of this file found its first bug.
  if (message.method === 'Runtime.exceptionThrown') {
    faults.push('threw: ' + (message.params.exceptionDetails.exception?.description
      ?? message.params.exceptionDetails.text));
  }
  if (message.method === 'Runtime.consoleAPICalled' &&
      ['error', 'warning'].includes(message.params.type)) {
    faults.push(`console.${message.params.type}: ` + message.params.args
      .map((it) => it.value ?? it.description ?? it.type).join(' '));
  }
};

function send(method, params = {}) {
  const at = ++id;
  socket.send(JSON.stringify({ id: at, method, params }));
  return new Promise((ok, no) => waiting.set(at, { ok, no }));
}

async function run(expression) {
  const { result, exceptionDetails } = await send('Runtime.evaluate', {
    expression: `(async () => {${expression}\n})()`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (exceptionDetails) {
    throw new Error(exceptionDetails.exception?.description ?? 'the page threw');
  }
  return result.value;
}

/** Types, one key at a time, the way somebody does. */
async function type(text) {
  for (const character of text) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', text: character });
    await send('Input.dispatchKeyEvent', { type: 'keyUp' });
    await wait(25);
  }
}

async function shoot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  await mkdir(shots, { recursive: true });
  await writeFile(join(shots, `${name}.png`), Buffer.from(data, 'base64'));
}

// ---------------------------------------------------------------------------

const results = [];
/**
 * Runs one check. `true` passes; a string is why it failed.
 *
 * Which means a check must not hand back a string it meant as data -- the
 * first three written here returned JSON and reported themselves as broken.
 */
async function check(what, body) {
  try {
    const why = await body();
    results.push([why === true || why === undefined, what, why]);
  } catch (error) {
    results.push([false, what, String(error).split('\n')[0]]);
  }
}

/** Page-side helpers, defined once in the window rather than in every step. */
const HELPERS = `
  const field = (label) => {
    const found = [...document.querySelectorAll('.field')]
      .find((it) => it.querySelector(':scope > label, :scope > .field-label')
        ?.textContent.startsWith(label));
    // Named. The failure this replaces was "Cannot set properties of null"
    // from a line that did not say which control it meant.
    if (!found) throw new Error('no field called ' + label);
    return found;
  };
  const slide = (label, value) => {
    const input = field(label).querySelector('input[type=range]');
    if (!input) throw new Error(label + ' is not a slider');
    input.value = String(value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const pick = (label, option) => {
    const where = field(label);
    const segment = [...where.querySelectorAll('.segment')]
      .find((it) => it.textContent === option);
    if (segment) return segment.click();
    // Longer lists are a popover rather than a segmented control, and both
    // have to be driven the way somebody would.
    where.querySelector('.picker').click();
    const item = [...document.querySelectorAll('.popover-item')]
      .find((it) => it.textContent === option);
    if (!item) throw new Error(option + ' is not offered under ' + label);
    item.click();
  };
`;

await send('Runtime.enable');
await send('Page.enable');
await wait(2500); // the mesh, and the first WebGL frame

await check('the window draws its panels', async () => {
  const counts = await run(`return JSON.stringify({
    objects: document.querySelectorAll('#objects li').length,
    fields: document.querySelectorAll('#inspector .field').length,
  })`);
  const { objects, fields } = JSON.parse(counts);
  return objects >= 2 && fields >= 3
    ? true
    : `objects=${objects} fields=${fields}`;
});

await check('the face is drawn, not just a canvas', async () => {
  const size = await run(`
    const canvas = document.querySelector('.viewport canvas');
    return canvas ? { w: canvas.width, h: canvas.height } : null;
  `);
  if (!size) return 'there is no canvas in the workspace';
  return size.w > 200 && size.h > 200 ? true : `the canvas is ${size.w}x${size.h}`;
});

await check('the workspace is not reporting trouble', async () =>
  (await run(`return document.querySelector('.viewport-trouble')?.textContent ?? true`)));

/** The text input under a named label in the inspector. */
const namedField = (label) => `
  [...document.querySelectorAll('#inspector .field')]
    .find((field) => field.querySelector(':scope > label')?.textContent === ${JSON.stringify(label)})
    ?.querySelector('input[type=text]')`;

await check('a name can be typed one character at a time', async () => {
  // By label rather than by position. The first version took input[0], which
  // is whichever control the inspector happens to start with -- and when a
  // stale window answered the debugging port it was a slider, so the check
  // reported the field reading "2".
  const found = await run(`
    const field = ${namedField('Name')};
    if (!field) return false;
    field.focus();
    field.select();
    return true;
  `);
  if (!found) return 'there is no Name field in the inspector';

  await type('Golden hour');
  const state = await run(`
    const field = ${namedField('Name')};
    return { value: field.value, focused: document.activeElement === field };
  `);
  return state.value === 'Golden hour' && state.focused
    ? true
    : `the field reads ${JSON.stringify(state.value)}, focused=${state.focused}`;
});

await check('the first thing offered needs nothing the person does not have',
  async () => {
    // Somebody opening this for the first time has no PNGs and nothing drawn,
    // which is what "Nothing imported yet" used to be a dead end about. The
    // library is the only one of the three openings that asks nothing of
    // them, so it leads.
    const offered = await run(`
      return [...document.querySelectorAll('.first-run-actions button')]
        .map((it) => it.textContent);
    `);
    if (!offered.length) return 'the first-run panel offers nothing';
    return offered[0].startsWith('Kyron library')
      ? true
      : `it leads with ${JSON.stringify(offered)}`;
  });

await shoot('01-opened');

// A colour lens, dialled rather than typed.
await check('the colour sliders reach the lens', async () => {
  await run(`
    ${HELPERS}
    document.querySelectorAll('.tree li')[1].click();
    slide('Temperature', 0.55);
    slide('Contrast', 1.35);
    slide('Saturation', 1.25);
    return true;
  `);
  await wait(300);
  // `lens.matrix`, not `lens.colour.matrix`: the project keeps the sliders
  // that produced it, and the published lens carries only the twenty numbers.
  const lens = JSON.parse(await run(`return document.getElementById('json').textContent`));
  return Array.isArray(lens.matrix) && lens.matrix.length === 20
    ? true
    : `the lens has no colour matrix after three sliders were moved: ${
        JSON.stringify(lens.matrix)}`;
});
await shoot('02-colour');

// The same lens, over the reference chart, and as the file that gets
// published.
await run(`document.querySelector('[data-view=photo]').click(); return true`);
await wait(300);
await shoot('03-photo');
await run(`document.querySelector('[data-view=json]').click(); return true`);
await wait(200);
await shoot('04-json');
await run(`document.querySelector('[data-view=face]').click(); return true`);

await check('nothing in the window is a native select', async () =>
  (await run(`return document.querySelectorAll('select').length`)) === 0
    ? true
    : 'a <select> is back');

// Artwork dropped in through the real drop handler, because the alternative
// is a hook in the application for the benefit of this file -- and a control
// that exists only for a screenshot is what a studio should not have.
await check('a dropped PNG becomes a resource', async () => {
  await run(`
    const canvas = document.createElement('canvas');
    canvas.width = 240; canvas.height = 240;
    const c = canvas.getContext('2d');
    c.fillStyle = '#ffd54f';
    c.beginPath();
    for (let i = 0; i < 10; i++) {
      const r = i % 2 ? 48 : 110;
      const a = (Math.PI * 2 * i) / 10 - Math.PI / 2;
      c.lineTo(120 + Math.cos(a) * r, 120 + Math.sin(a) * r);
    }
    c.closePath(); c.fill();
    c.strokeStyle = '#ff8f00'; c.lineWidth = 8; c.stroke();

    const blob = await new Promise((done) => canvas.toBlob(done, 'image/png'));
    const carried = new DataTransfer();
    carried.items.add(new File([blob], 'star.png', { type: 'image/png' }));
    document.dispatchEvent(new DragEvent('drop', {
      dataTransfer: carried, bubbles: true, cancelable: true,
    }));
    return true;
  `);
  await wait(700);
  const names = await run(`
    return [...document.querySelectorAll('#resources .label')].map((it) => it.textContent);
  `);
  return names.includes('star.png') ? true : `the resources are ${names.join(', ')}`;
});

await check('adding an attachment selects it and shows its handles', async () => {
  await run(`document.getElementById('add-attachment').click(); return true`);
  await wait(600);
  // Every field's name, whether it is drawn as a <label> beside a control or
  // as the head of a slider row.
  const fields = await run(`
    return [...document.querySelectorAll('#inspector .field')].map((field) => {
      const head = field.querySelector(':scope > label, :scope > .field-label');
      return head ? head.firstChild?.textContent?.trim() ?? '' : '';
    });
  `);
  const wanted = ['Artwork', 'Anchor', 'Width', 'Offset X', 'Rotation'];
  const missing = wanted.filter((it) => !fields.includes(it));
  return missing.length === 0
    ? true
    : `the inspector is missing ${missing.join(', ')}; it shows ${fields.join(', ')}`;
});

await check('the selected attachment carries its handles', async () => {
  // The inspector showing an attachment is not the same as the face showing
  // one. For a whole release the handles never appeared, because selecting in
  // the list did not tell the viewport -- and every check that only read the
  // inspector passed the entire time.
  const seen = await run(`return globalThis.studioDiagnostics?.() ?? null`);
  if (!seen) return 'the window exposes no diagnostics';
  if (seen.contextLost) return 'the graphics context is lost';
  if (seen.attachments !== 1) return `the face has ${seen.attachments} attachments`;
  return seen.handlesOn === 0
    ? true
    : `the handles are on attachment ${seen.handlesOn}, not the selected one`;
});

await check('every option of a small choice is visible', async () => {
  const options = await run(`
    const group = [...document.querySelectorAll('.segmented')]
      .find((it) => it.getAttribute('aria-label') === 'Anchor');
    return group ? [...group.children].map((it) => it.textContent) : null;
  `);
  if (!options) return 'the anchor choice is not a segmented control';

  // Truncation is the failure this is here for: a segmented control reading
  // "mo…" and "fore…" has lost the one thing it is for. The labels are
  // compared against the anchors the format defines rather than a count, so
  // adding a sixth anchor and forgetting this window fails here.
  const want = ['eyes', 'nose', 'mouth', 'forehead', 'chin'];
  const same = options.length === want.length &&
    want.every((it, at) => options[at] === it);
  return same ? true : `the anchors read ${options.join(' / ')}`;
});

await check('the artwork can be chosen and the attachment placed', async () => {
  await run(`
    ${HELPERS}
    pick('Artwork', 'star.png');
    return true;
  `);
  await wait(400);
  await run(`
    ${HELPERS}
    slide('Width', 1.1);
    slide('Offset Y', -1.35);
    return true;
  `);
  await wait(600);
  const lens = JSON.parse(await run(`return document.getElementById('json').textContent`));
  const [attachment] = lens.attachments ?? [];
  if (!attachment) return 'the lens has no attachment';
  return attachment.asset?.endsWith('star.png') && attachment.width === 1.1
    ? true
    : `the attachment is ${JSON.stringify(attachment)}`;
});
await shoot('05-attachment');

await check('an effect can be added', async () => {
  await run(`document.getElementById('add-frost').click(); return true`);
  await wait(500);
  const lens = JSON.parse(await run(`return document.getElementById('json').textContent`));
  return lens.effects?.some((it) => it.kind === 'frost')
    ? true
    : 'adding Frost put no frost in the lens';
});
await shoot('06-frost');

await check('the Kyron library opens and shows its pictures', async () => {
  await run(`document.getElementById('library').click(); return true`);
  // A fetch of a catalogue and then of each visible picture, over a socket.
  await wait(1500);

  const open = await run(`return document.getElementById('library-dialog')?.open === true`);
  if (!open) return 'the library dialog did not open';

  const grid = await run(`
    return [...document.querySelectorAll('.library-piece')].map((tile) => ({
      name: tile.querySelector('.library-name').textContent,
      // Whether a picture actually arrived, not merely whether an <img> is
      // there: an empty grid of frames is what a silent failure looks like.
      drawn: (tile.querySelector('img').src ?? '').startsWith('data:image/png'),
    }));
  `);
  if (grid.length !== 2) {
    return `the grid holds ${grid.length} pieces: ${JSON.stringify(grid)}`;
  }
  if (!grid.every((it) => it.drawn)) {
    return `a tile has no picture: ${JSON.stringify(grid)}`;
  }
  return true;
});
await shoot('07-library');

await check('a catalogue cannot point the studio at another server', async () => {
  // The third entry names example.invalid. It is not in the grid above, and
  // the point of this check is the stronger statement: no socket was opened
  // for it. `asked` is every path the test server was asked for, so a
  // request that went elsewhere would not appear -- which is why the grid
  // count above is the evidence for the refusal and this is the evidence
  // that the refusal happened before any fetch.
  const names = await run(`
    return [...document.querySelectorAll('.library-piece .library-name')]
      .map((it) => it.textContent);
  `);
  if (names.includes('Elsewhere')) return `the grid offers ${names.join(', ')}`;

  const reached = await run(`
    const answer = await window.studio.artworkFetch('https://example.invalid/art/elsewhere.png');
    return answer?.error ?? 'it fetched it';
  `);
  return reached.includes('not part of the Kyron artwork library')
    ? true
    : `asking for it directly gave: ${reached}`;
});

await check('the search field is drawn by Kyron, not by the browser', async () => {
  // It went in as `type="search"`, which the shared input rule did not name,
  // so it came up as a native box with a browser-drawn clear button in the
  // middle of a Kyron dialog. That is the same objection this file makes to
  // <select>, and nothing caught it but a screenshot.
  const drawn = await run(`
    const box = document.getElementById('library-search');
    const style = getComputedStyle(box);
    const wanted = getComputedStyle(document.documentElement)
      .getPropertyValue('--radius-control').trim();
    return { radius: style.borderTopLeftRadius, wanted, padding: style.paddingLeft };
  `);
  return drawn.radius === drawn.wanted && drawn.padding !== '0px'
    ? true
    : `it has radius ${drawn.radius} where the system says ${drawn.wanted}, ` +
      `and ${drawn.padding} of padding`;
});

await check('searching the library narrows it', async () => {
  await run(`
    const box = document.getElementById('library-search');
    box.focus();
    return true;
  `);
  await type('night');
  await wait(400);
  const names = await run(`
    return [...document.querySelectorAll('.library-piece .library-name')]
      .map((it) => it.textContent);
  `);
  if (names.join() !== 'Moon') return `searching "night" left ${names.join(', ')}`;

  // Escape in a search field clears it before it reaches the dialog. Asserted
  // rather than assumed, because the alternative -- one Escape closing a
  // dialog with a half-typed search in it -- is a different tool to use.
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await wait(400);
  const after = await run(`
    return {
      open: document.getElementById('library-dialog').open,
      typed: document.getElementById('library-search').value,
      shown: document.querySelectorAll('.library-piece').length,
    };
  `);
  if (!after.open) return 'Escape closed the dialog instead of clearing the search';
  if (after.typed !== '') return `the box still reads ${JSON.stringify(after.typed)}`;
  return after.shown === 2 ? true : `clearing it left ${after.shown} pieces`;
});

await check('a piece from the library becomes a resource of its own', async () => {
  await run(`
    const tile = [...document.querySelectorAll('.library-piece')]
      .find((it) => it.querySelector('.library-name').textContent === 'Star');
    if (!tile) throw new Error('the library is not offering Star');
    tile.click();
    return true;
  `);
  await wait(800);

  const names = await run(`
    return [...document.querySelectorAll('#resources .label')].map((it) => it.textContent);
  `);
  // star.png is the PNG dropped in earlier, and an attachment is already
  // pointing at it. A library piece landing on that name would silently
  // replace artwork somebody had placed on the face.
  if (!names.includes('star.png')) return `the dropped star is gone: ${names.join(', ')}`;
  if (!names.includes('star-2.png')) return `the resources are ${names.join(', ')}`;

  const attachment = JSON.parse(
    await run(`return document.getElementById('json').textContent`),
  ).attachments?.[0];
  return attachment?.asset?.endsWith('star.png') &&
      !attachment.asset.endsWith('star-2.png')
    ? true
    : `the attachment moved to ${attachment?.asset}`;
});
await shoot('08-library-added');

await check('the library closes and does not fetch the catalogue twice', async () => {
  const before = asked.filter((it) => it === '/catalogue.json').length;
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await wait(300);
  if (await run(`return document.getElementById('library-dialog')?.open === true`)) {
    return 'Escape did not close the library';
  }

  await run(`document.getElementById('library').click(); return true`);
  await wait(800);
  const after = asked.filter((it) => it === '/catalogue.json').length;
  if (after !== before) return `it was read ${after} times, not ${before}`;

  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await wait(300);
  return true;
});

await check('the paint dialog opens and closes', async () => {
  await run(`document.getElementById('paint').click(); return true`);
  await wait(400);
  const open = await run(`return document.getElementById('paint-dialog')?.open === true`);
  if (!open) return 'the paint dialog did not open';
  await shoot('09-paint');
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await wait(400);
  return (await run(`return document.getElementById('paint-dialog')?.open === true`))
    ? 'Escape did not close the paint dialog'
    : true;
});

await check('the lens is publishable once it does something', async () => {
  const state = await run(`return {
    status: document.getElementById('logger-status').textContent,
    blocked: document.getElementById('publish').disabled,
  }`);
  return state.blocked === false
    ? true
    : `Publish is still disabled, and the bar says "${state.status}"`;
});

await check('the first-run panel goes away, and only ever appears once',
  async () => (await run(`return document.querySelectorAll('.first-run').length`)) === 0
    ? true
    : 'the first-run panel is still there with an attachment in the lens');

await check('a lost graphics context is reported and recovered', async () => {
  await run(`
    const canvas = document.querySelector('.viewport canvas');
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    globalThis.__lose = gl.getExtension('WEBGL_lose_context');
    globalThis.__lose.loseContext();
    return true;
  `);
  await wait(700);
  const said = await run(`return !!document.querySelector('.viewport-trouble')`);
  await run(`globalThis.__lose.restoreContext(); return true`);
  await wait(1200);
  const cleared = await run(`
    const canvas = document.querySelector('.viewport canvas');
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    return JSON.stringify({
      lost: gl.isContextLost(),
      trouble: !!document.querySelector('.viewport-trouble'),
    });
  `);
  const { lost, trouble } = JSON.parse(cleared);
  if (!said) return 'the loss was never reported';
  return !lost && !trouble ? true : `after restore lost=${lost} trouble=${trouble}`;
});

await shoot('10-recovered');

// ---------------------------------------------------------------------------

for (const fault of faults) results.push([false, 'the window stayed quiet', fault]);

let bad = 0;
for (const [ok, what, why] of results) {
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}${ok ? '' : `\n        ${why}`}`);
}
console.log(`\n${results.length - bad} of ${results.length} passed`);
console.log(`a picture of the window is in ${shots}`);

socket.close();
close();
process.exit(bad === 0 ? 0 : 1);
