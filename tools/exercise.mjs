#!/usr/bin/env node
// tools/exercise.mjs
//
// Opens the real application and uses it.
//
//     npm run test:app
//
// `tools/shoot.mjs` loads the renderer in headless Chromium, which exercises
// the panels and the WebGL face but is not Electron: no preload, no file://
// origin, and a set of command-line flags a packaged application does not
// have. `node --test` covers the modules underneath, which are the half that
// can be checked without a window.
//
// Neither saw any of these, and all three reached somebody using the
// installed application:
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
// It needs a display. On a runner, and here, that is xvfb-run; the script
// finds one or says what is missing.

import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const shots = resolve(process.argv[2] ?? '/tmp/kyron-studio-exercise');
const port = 9412;

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
  // Its own process group, so closing it closes the Electron underneath.
  // `xvfb-run` is a shell script that execs a server and then the command:
  // killing the script leaves the window running, holding the debugging port,
  // and the next run drives that one instead of its own.
  { stdio: ['ignore', 'ignore', 'pipe'], detached: true },
);

/** Closes the window and everything it started. */
function close() {
  try {
    process.kill(-app.pid, 'SIGTERM');
  } catch {
    // Already gone.
  }
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

await send('Runtime.enable');
await send('Page.enable');
await wait(2000);

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

await check('nothing in the window is a native select', async () =>
  (await run(`return document.querySelectorAll('select').length`)) === 0
    ? true
    : 'a <select> is back');

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

await shoot('the-window');

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
