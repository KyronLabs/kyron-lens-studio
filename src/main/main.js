// src/main/main.js
//
// The Electron main process: a window and the things the renderer cannot do
// for itself -- open a file, save a file, read artwork off the disk, fetch the
// artwork library, and open a pull request against the catalogue.
//
// The network lives here rather than in the renderer on purpose. The window's
// Content-Security-Policy is `connect-src 'self'` and `img-src 'self' data:`,
// so a document that loads a stranger's PNG has no way to call out with what
// it found. Keeping it that way costs two IPC calls.
//
// Everything else is in the renderer, and everything interesting is in
// src/format, which has no idea Electron exists.

import { BrowserWindow, Menu, app, dialog, ipcMain, shell } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CATALOGUE_URL,
  MAX_BYTES,
  TYPES,
  fetchable,
  piecesOf,
  publishable,
} from '../format/artwork.js';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, '..', 'app');

/** The project file currently open, so Save does not ask every time. */
let openPath = null;
let window = null;

function create() {
  window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1040,
    minHeight: 680,
    backgroundColor: '#17181c',
    title: 'Kyron Lens Studio',
    webPreferences: {
      // The renderer gets no Node at all. It is a document that draws panels;
      // everything that touches the disk goes through the named calls in
      // preload.js, which is a short list somebody can read.
      preload: join(here, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  window.loadFile(join(appDir, 'index.html'));

  // Two keys the menu used to carry that nothing else can reach. Without a
  // menu there is no other way into the developer tools, and the first thing
  // anybody is asked when a window comes up wrong is what the console says.
  window.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F12') {
      window?.webContents.toggleDevTools();
      event.preventDefault();
    } else if (input.key === 'F11') {
      window?.setFullScreen(!window.isFullScreen());
      event.preventDefault();
    }
  });

  window.on('closed', () => { window = null; });
}

/** Everything that opens a browser goes through here, never through the app. */
app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
});

app.whenReady().then(() => {
  // No menu bar. File held Open and Save, Edit held Undo and Redo, and all
  // four are buttons in the window's own top bar a few pixels below where the
  // menu was -- so it was a second copy of the same four things, in a strip
  // that on Windows is the first thing above the interface and reads as part
  // of the operating system rather than part of this. The keyboard shortcuts
  // it carried are handled by the window itself now, beside the buttons.
  Menu.setApplicationMenu(null);
  create();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) create();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------------------------------------------------------------------------
// What the renderer may ask for
// ---------------------------------------------------------------------------

ipcMain.handle('open-project', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(window, {
    title: 'Open a lens project',
    filters: [{ name: 'Lens project', extensions: ['lens.json', 'json'] }],
    properties: ['openFile'],
  });
  if (canceled || !filePaths.length) return null;
  openPath = filePaths[0];
  return { path: openPath, text: await readFile(openPath, 'utf8') };
});

ipcMain.handle('save-project', async (_event, text) => {
  if (!openPath) {
    const { canceled, filePath } = await dialog.showSaveDialog(window, {
      title: 'Save the lens project',
      defaultPath: 'lens.json',
      filters: [{ name: 'Lens project', extensions: ['json'] }],
    });
    if (canceled || !filePath) return null;
    openPath = filePath;
  }
  await writeFile(openPath, text, 'utf8');
  return { path: openPath };
});

ipcMain.handle('import-artwork', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(window, {
    title: 'Import artwork',
    filters: [{ name: 'Pictures', extensions: ['png', 'webp'] }],
    properties: ['openFile', 'multiSelections'],
  });
  if (canceled) return [];

  const files = [];
  for (const path of filePaths) {
    const bytes = await readFile(path);
    const type = extname(path) === '.webp' ? 'image/webp' : 'image/png';
    files.push({
      name: basename(path),
      bytes: `data:${type};base64,${bytes.toString('base64')}`,
    });
  }
  return files;
});

/**
 * Writes the catalogue entry and the artwork beside it.
 *
 * Deliberately stops at the working copy: it writes the files into a checkout
 * of kyron-lenses and opens it, rather than committing and pushing. Publishing
 * is somebody putting their name on a change to a catalogue that reaches
 * every phone, and the last step is theirs.
 */
ipcMain.handle('publish', async (_event, plan) => {
  if (plan?.blockers?.length) {
    return { error: 'That lens is not publishable yet.' };
  }

  const { canceled, filePaths } = await dialog.showOpenDialog(window, {
    title: 'Where is your checkout of kyron-lenses?',
    properties: ['openDirectory'],
  });
  if (canceled || !filePaths.length) return null;
  const root = filePaths[0];

  try {
    const cataloguePath = join(root, 'lenses.json');
    const catalogue = JSON.parse(await readFile(cataloguePath, 'utf8'));
    const lenses = catalogue.lenses ?? [];
    const at = lenses.findIndex((it) => it.id === plan.lens.id);
    if (at >= 0) lenses[at] = plan.lens;
    else lenses.push(plan.lens);
    catalogue.lenses = lenses;
    catalogue.schema = Math.max(catalogue.schema ?? 1, plan.lens.schema ?? 1);

    for (const file of plan.files) {
      const comma = file.bytes.indexOf(',');
      await writeFile(
        join(root, file.path),
        Buffer.from(file.bytes.slice(comma + 1), 'base64'),
      );
    }
    await writeFile(cataloguePath, `${JSON.stringify(catalogue, null, 2)}\n`, 'utf8');

    return {
      path: root,
      wrote: ['lenses.json', ...plan.files.map((it) => it.path)],
      // Said rather than done: a commit is somebody's name on a change that
      // reaches every phone running Kyron.
      next: 'Review the diff, run tools/lens.py, then commit and open a pull request.',
    };
  } catch (error) {
    return { error: `Could not write into that checkout: ${error.message}` };
  }
});

// ---------------------------------------------------------------------------
// The Kyron artwork library
// ---------------------------------------------------------------------------

/**
 * Where the library is read from, and the one knob a staging build gets.
 *
 * Read once, at start: a value that could change between the catalogue fetch
 * and the picture fetch would defeat the same-directory rule below.
 */
const catalogueUrl = process.env.KYRON_ARTWORK_CATALOGUE || CATALOGUE_URL;

/** A catalogue past this is not a catalogue. The app applies the same ceiling. */
const MAX_CATALOGUE_BYTES = 512 * 1024;

/** Long enough for a cold CDN, short enough that a hung socket is not forever. */
const TIMEOUT_MS = 15000;

/**
 * Fetches a URL, refusing to read more than `limit` bytes.
 *
 * The length header is checked first because it is cheap, and then the body
 * is counted as it arrives because the header is the server's claim about
 * itself. A server that says 12 KB and sends 4 GB gets cut off at the limit.
 */
async function fetchCapped(url, limit) {
  const response = await fetch(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { accept: '*/*' },
  });
  if (!response.ok) {
    throw new Error(`the server answered ${response.status}`);
  }

  const claimed = Number(response.headers.get('content-length'));
  if (Number.isFinite(claimed) && claimed > limit) {
    throw new Error(`it is ${Math.round(claimed / 1024)} KB, over the limit`);
  }

  const chunks = [];
  let seen = 0;
  for await (const chunk of response.body) {
    seen += chunk.length;
    if (seen > limit) throw new Error('it is over the limit');
    chunks.push(chunk);
  }

  return {
    type: (response.headers.get('content-type') ?? '').split(';')[0].trim(),
    bytes: Buffer.concat(chunks),
  };
}

/**
 * The library, or why there isn't one.
 *
 * Every failure is returned and said out loud in the window. The app can fall
 * back to seven bundled lenses when its catalogue is unreachable; this has no
 * equivalent, and a grid that is quietly empty because a fetch 404'd looks
 * exactly like a library with nothing in it.
 */
ipcMain.handle('artwork-catalogue', async () => {
  // The override is checked before it is used. A catalogue over plaintext
  // would put the library, and every picture fetched under it, on the far
  // side of anybody sharing the network -- and the same-directory rule would
  // then happily permit all of them, because they would share its origin.
  if (!publishable(catalogueUrl)) {
    return {
      error: `KYRON_ARTWORK_CATALOGUE is set to ${catalogueUrl}, which is not ` +
        'a catalogue this will fetch: it must be https, or on this machine.',
      from: catalogueUrl,
    };
  }

  try {
    const { bytes } = await fetchCapped(catalogueUrl, MAX_CATALOGUE_BYTES);
    const pieces = piecesOf(JSON.parse(bytes.toString('utf8')), catalogueUrl);
    if (!pieces.length) {
      return { error: 'The artwork library is published but has nothing this version can read.' };
    }
    return { pieces, from: catalogueUrl };
  } catch (error) {
    return {
      error: `Could not read the artwork library: ${error.message}.`,
      from: catalogueUrl,
    };
  }
});

/**
 * One picture, as the data URL a resource already holds.
 *
 * The URL is checked here against the catalogue this process fetched, not
 * against anything the renderer says. The renderer is the part of this
 * program that has had a stranger's PNG in it.
 */
ipcMain.handle('artwork-fetch', async (_event, url) => {
  if (typeof url !== 'string' || !fetchable(url, catalogueUrl)) {
    return { error: 'That picture is not part of the Kyron artwork library.' };
  }

  try {
    const { type, bytes } = await fetchCapped(url, MAX_BYTES);
    if (!TYPES.has(type)) {
      return { error: `That is served as ${type || 'nothing in particular'}, not a picture.` };
    }
    return { bytes: `data:${type};base64,${bytes.toString('base64')}` };
  } catch (error) {
    return { error: `Could not fetch that picture: ${error.message}.` };
  }
});
