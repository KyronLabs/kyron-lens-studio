// src/main/main.js
//
// The Electron main process: a window and the four things the
// renderer cannot do for itself -- open a file, save a file, read artwork off
// the disk, and open a pull request against the catalogue.
//
// Everything else is in the renderer, and everything interesting is in
// src/format, which has no idea Electron exists.

import { BrowserWindow, Menu, app, dialog, ipcMain, shell } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
