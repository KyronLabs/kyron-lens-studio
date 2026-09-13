#!/usr/bin/env node
// tools/shoot.mjs
//
// Photographs the window, and everything it can be put into.
//
//     node tools/shoot.mjs [outDir]
//
// This exists because the studio is a Windows desktop application and the
// place it is built is not Windows. The renderer is an ordinary page, though,
// and Electron's renderer *is* Chromium -- so loading src/app/index.html in
// headless Chromium and driving it over the debugging protocol exercises the
// real panels, the real state module and the real WebGL face. Everything
// except the four calls in preload.cjs, which are the parts that open a file
// dialog.
//
// It is not a test: nothing here asserts. It produces pictures to look at,
// which for a user interface is the check that matters and the one no
// assertion replaces.

import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(process.argv[2] ?? '/tmp/kyron-studio-shots');
const port = 9333;

const CHROME =
  process.env.CHROME ??
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const chrome = spawn(CHROME, [
  '--headless=new',
  '--no-sandbox',
  '--disable-gpu',
  '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader',
  '--allow-file-access-from-files',
  '--hide-scrollbars',
  `--remote-debugging-port=${port}`,
  '--user-data-dir=/tmp/kyron-studio-profile',
  '--window-size=1440,900',
  `file://${join(root, 'src/app/index.html')}`,
], { stdio: 'ignore' });

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

/** The debugging endpoint takes a moment to come up. */
async function target() {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((it) => it.json());
      const page = list.find((it) => it.type === 'page' && it.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      // Not listening yet.
    }
    await wait(250);
  }
  throw new Error('the browser never opened its debugging port');
}

const socket = new WebSocket(await target());
await new Promise((ready, failed) => {
  socket.addEventListener('open', ready, { once: true });
  socket.addEventListener('error', failed, { once: true });
});

let nextId = 1;
const pending = new Map();
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  const waiting = pending.get(message.id);
  if (!waiting) return;
  pending.delete(message.id);
  message.error ? waiting.failed(new Error(message.error.message)) : waiting.done(message.result);
});

function send(method, params = {}) {
  const id = nextId++;
  return new Promise((done, failed) => {
    pending.set(id, { done, failed });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

/** Runs an expression in the page and hands back what it evaluated to. */
async function run(expression) {
  // Wrapped: every evaluation shares one global scope, so a `const` declared
  // in one lands in the next and the second call dies on a redeclaration.
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

async function shoot(name) {
  await wait(400);
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile(join(out, `${name}.png`), Buffer.from(data, 'base64'));
  console.log(`${name}.png`);
}

await mkdir(out, { recursive: true });
await send('Page.enable');
await wait(2500); // the mesh, and the first WebGL frame

await shoot('01-opened');

// A colour lens, dialled rather than typed.
await run(`
  document.querySelectorAll('.tree li')[1].click();
  const set = (label, value) => {
    const field = [...document.querySelectorAll('.field')]
      .find((it) => it.textContent.startsWith(label));
    const input = field.querySelector('input[type=range]');
    input.value = String(value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  set('Temperature', 0.55);
  set('Contrast', 1.35);
  set('Saturation', 1.25);
  document.getElementById('lens-name').value = 'Golden hour';
  document.getElementById('lens-name').dispatchEvent(new Event('input', { bubbles: true }));
  document.getElementById('lens-id').value = 'golden-hour';
  document.getElementById('lens-id').dispatchEvent(new Event('input', { bubbles: true }));
`);
await shoot('02-colour');

// The same lens, over the reference chart.
await run(`document.querySelector('[data-view=photo]').click()`);
await shoot('03-photo');

await run(`document.querySelector('[data-view=json]').click()`);
await shoot('04-json');

// Artwork dropped in, hung on the face. Through the real drop handler,
// because the alternative is a hook in the application for the benefit of
// this file -- and a control that only exists for a screenshot is exactly
// what a studio should not have.
await run(`
  (async () => {
    document.querySelector('[data-view=face]').click();

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
    const file = new File([blob], 'star.png', { type: 'image/png' });
    const carried = new DataTransfer();
    carried.items.add(file);
    document.dispatchEvent(new DragEvent('drop', {
      dataTransfer: carried, bubbles: true, cancelable: true,
    }));
  })()
`);
await wait(500);
await run(`
  document.getElementById('add-attachment').click();
  const pick = document.querySelector('.inspector select');
  pick.value = 'star.png';
  pick.dispatchEvent(new Event('change', { bubbles: true }));
  const set = (label, value) => {
    const field = [...document.querySelectorAll('.field')]
      .find((it) => it.textContent.startsWith(label));
    const input = field.querySelector('input[type=range]');
    input.value = String(value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  set('Width', 1.1);
  set('Offset Y', -1.35);
`);
await wait(600);
await shoot('05-attachment');

await run(`document.getElementById('add-frost').click()`);
await shoot('06-frost');

await run(`document.getElementById('paint').click()`);
await shoot('07-paint');

socket.close();
chrome.kill();
console.log(`\nwritten to ${out}`);
process.exit(0);
