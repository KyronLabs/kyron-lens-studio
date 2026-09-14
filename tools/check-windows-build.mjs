#!/usr/bin/env node
// tools/check-windows-build.mjs
//
// Looks at what the Windows build actually produced, before anybody is asked
// to download it.
//
// "electron-builder exited 0" is not the same as "there is an application
// here". A build can succeed and ship an installer whose payload is missing
// the two files the renderer needs -- both are gitignored build output copied
// in by tools/vendor.mjs, so forgetting that step produces a studio that
// installs, launches, and shows an empty window. That is precisely the class
// of fault a green tick hides.
//
// Plain Node with no dependencies, like everything else here, so it runs the
// same on a runner and on a workstation.

import { execFileSync } from 'node:child_process';
import { openSync, readFileSync, readSync, closeSync, statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

const dist = process.argv[2] ?? 'dist';

/** What the renderer loads from beside the page, and cannot start without. */
const REQUIRED_IN_ASAR = [
  'src/main/main.js',
  'src/main/preload.cjs',
  'src/app/index.html',
  'src/app/app.js',
  'src/app/viewport.js',
  // The handles. viewport.js imports both, so either one missing means the
  // face never draws at all rather than the handles quietly not working.
  'src/app/gesture.js',
  'src/app/plane.js',
  'src/format/lens.js',
  'src/format/face.js',
  // The two copies. Gitignored, so these are the ones that go missing.
  'src/app/vendor/three.module.js',
  'src/app/face/canonical_face_model.obj',
];

/**
 * Smallest an installer carrying a whole Electron runtime can plausibly be.
 *
 * A build that packaged nothing still writes a file; this is what tells that
 * apart from one that packaged an application.
 */
const MIN_INSTALLER_BYTES = 40 * 1024 * 1024;

/** And a ceiling, because a packaging mistake usually shows up as bulk. */
const MAX_INSTALLER_BYTES = 250 * 1024 * 1024;

const problems = [];
const notes = [];

function fail(message) {
  problems.push(message);
}

function note(message) {
  notes.push(message);
}

/** The files an asar holds, read out of its header. */
function asarEntries(path) {
  const fd = openSync(path, 'r');
  try {
    // The archive opens with four 32-bit little-endian words, the last of
    // which is the length of the JSON header.
    const prefix = Buffer.alloc(16);
    if (readSync(fd, prefix, 0, 16, 0) !== 16) {
      throw new Error('too short to be an asar');
    }
    const headerSize = prefix.readUInt32LE(12);
    if (headerSize <= 0 || headerSize > 64 * 1024 * 1024) {
      throw new Error(`implausible header size ${headerSize}`);
    }
    const header = Buffer.alloc(headerSize);
    readSync(fd, header, 0, headerSize, 16);
    const tree = JSON.parse(header.toString('utf8'));

    const found = new Map();
    const walk = (node, prefixPath) => {
      for (const [name, child] of Object.entries(node.files ?? {})) {
        const path = prefixPath ? `${prefixPath}/${name}` : name;
        if (child.files) {
          walk(child, path);
        } else {
          found.set(path, child.size ?? 0);
        }
      }
    };
    walk(tree, '');
    return found;
  } finally {
    closeSync(fd);
  }
}

const listing = await readdir(dist).catch(() => null);
if (listing === null) {
  console.error(`No ${dist}/ directory: electron-builder produced nothing.`);
  process.exit(1);
}

// ---------------------------------------------------------------- installer
const installers = listing.filter((name) => name.toLowerCase().endsWith('.exe'));
if (installers.length === 0) {
  fail(`No .exe in ${dist}/. It holds: ${listing.join(', ') || '(nothing)'}`);
} else if (installers.length > 1) {
  fail(`More than one installer in ${dist}/: ${installers.join(', ')}`);
}

for (const name of installers) {
  const path = join(dist, name);
  const { size } = statSync(path);

  if (size < MIN_INSTALLER_BYTES) {
    fail(
      `${name} is ${(size / 1024 / 1024).toFixed(1)} MB, below the ` +
        `${MIN_INSTALLER_BYTES / 1024 / 1024} MB an Electron installer takes. ` +
        'It cannot be carrying the runtime.',
    );
  } else if (size > MAX_INSTALLER_BYTES) {
    fail(
      `${name} is ${(size / 1024 / 1024).toFixed(1)} MB, past the ` +
        `${MAX_INSTALLER_BYTES / 1024 / 1024} MB ceiling. Something is being ` +
        'packaged that should not be.',
    );
  } else {
    note(`${name} is ${(size / 1024 / 1024).toFixed(1)} MB`);
  }

  const head = Buffer.alloc(2);
  const fd = openSync(path, 'r');
  readSync(fd, head, 0, 2, 0);
  closeSync(fd);
  if (head.toString('latin1') !== 'MZ') {
    fail(`${name} is not a Windows executable: it does not start with MZ.`);
  }

  // NSIS stamps its own name into the installer. Without it this is some
  // other executable that happens to be sitting in dist/.
  const body = readFileSync(path);
  if (!body.includes(Buffer.from('Nullsoft', 'latin1'))) {
    fail(`${name} carries no NSIS signature, so it is not an installer.`);
  }
}

// ------------------------------------------------------------- the app itself
const unpackedName = listing.find((name) => name.endsWith('-unpacked'));
if (!unpackedName) {
  fail(`No *-unpacked directory in ${dist}/: nothing was actually packaged.`);
} else {
  const unpacked = join(dist, unpackedName);
  const inside = await readdir(unpacked);

  const exe = inside.find((name) => name.toLowerCase().endsWith('.exe'));
  if (!exe) {
    fail(`${unpackedName}/ holds no .exe.`);
  } else if (exe === 'electron.exe') {
    // rcedit renames it to the product. Still electron.exe means the rename
    // did not happen, and the application will show up as "Electron".
    fail(`${unpackedName}/ still holds electron.exe: it was never renamed.`);
  } else {
    note(`the application is ${exe}`);

    // What Windows will show in the taskbar and in Programs and Features.
    // Only on Windows: this reads the executable's own version resource,
    // which is what rcedit writes and the one place the icon and the product
    // name can be seen without running the installer.
    if (process.platform === 'win32') {
      const info = execFileSync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `(Get-Item -LiteralPath '${join(unpacked, exe)}').VersionInfo | ` +
            'Select-Object -Property ProductName,FileDescription,CompanyName |' +
            ' ConvertTo-Json -Compress',
        ],
        { encoding: 'utf8' },
      );
      const stamped = JSON.parse(info);
      if (stamped.ProductName !== 'Kyron Lens Studio') {
        fail(
          'The executable says its product is ' +
            `"${stamped.ProductName}" rather than "Kyron Lens Studio".`,
        );
      } else {
        note(`stamped as ${stamped.ProductName} by ${stamped.CompanyName}`);
      }
    }
  }

  const asar = join(unpacked, 'resources', 'app.asar');
  let entries = null;
  try {
    entries = asarEntries(asar);
  } catch (error) {
    fail(`Could not read ${asar}: ${error.message}`);
  }

  if (entries) {
    const missing = REQUIRED_IN_ASAR.filter((path) => !entries.has(path));
    if (missing.length > 0) {
      fail(
        'The packaged application is missing: ' +
          missing.join(', ') +
          '. Did tools/vendor.mjs run before the build?',
      );
    }
    for (const path of REQUIRED_IN_ASAR) {
      if (entries.get(path) === 0) {
        fail(`${path} is packaged, but it is empty.`);
      }
    }
    note(`${entries.size} files packaged`);
  }
}

for (const line of notes) console.log(`  ${line}`);

if (problems.length > 0) {
  console.error('\nThe Windows build is not shippable:');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log('\nThe Windows build carries a real application.');
