// test/artwork.test.js
//
// The rules applied to the artwork library, against a catalogue that is
// trying things on. Every URL in a catalogue is somebody else's text, and
// `fetchable` is the only thing between that text and a fetch the main
// process makes on their behalf.

import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CATALOGUE_URL,
  SCHEMA,
  fetchable,
  matching,
  pieceOf,
  piecesOf,
  publishable,
  resourceName,
} from '../src/format/artwork.js';

const BASE = CATALOGUE_URL;
const good = (over = {}) => ({
  id: 'star',
  name: 'Star',
  url: 'https://kyronlabs.github.io/kyron-artwork/art/star.png',
  width: 512,
  height: 512,
  author: 'Kyron',
  licence: 'CC0-1.0',
  tags: ['shape', 'sparkle'],
  ...over,
});

describe('fetchable', () => {
  it('takes a piece served beside its catalogue', () => {
    strictEqual(fetchable(good().url, BASE), true);
  });

  it('refuses another host', () => {
    strictEqual(
      fetchable('https://example.invalid/art/star.png', BASE),
      false,
    );
  });

  it('refuses another path on the same host', () => {
    // GitHub Pages serves every repository in an organisation from one
    // origin, so same-origin alone would let a catalogue name a file out of
    // any other KyronLabs Pages site.
    strictEqual(
      fetchable('https://kyronlabs.github.io/somebody-else/art/star.png', BASE),
      false,
    );
  });

  it('refuses a path that only looks like the directory', () => {
    strictEqual(
      fetchable('https://kyronlabs.github.io/kyron-artwork-evil/x.png', BASE),
      false,
    );
  });

  it('refuses plaintext over a network', () => {
    strictEqual(
      fetchable('http://kyronlabs.github.io/kyron-artwork/art/star.png', BASE),
      false,
    );
  });

  it('refuses a scheme that is not the web at all', () => {
    for (const url of [
      'file:///etc/passwd',
      'data:image/png;base64,AAAA',
      'javascript:alert(1)',
      'not a url',
    ]) {
      strictEqual(fetchable(url, BASE), false, url);
    }
  });

  it('allows plaintext on loopback, and only there', () => {
    const local = 'http://127.0.0.1:8080/catalogue.json';
    strictEqual(fetchable('http://127.0.0.1:8080/art/star.png', local), true);
    strictEqual(fetchable('http://10.0.0.1:8080/art/star.png', local), false);
  });

  it('refuses a port that differs from the catalogue', () => {
    const local = 'http://127.0.0.1:8080/catalogue.json';
    strictEqual(fetchable('http://127.0.0.1:9090/art/star.png', local), false);
  });
});

describe('piecesOf', () => {
  it('reads a catalogue', () => {
    const pieces = piecesOf({ schema: SCHEMA, artwork: [good()] }, BASE);
    strictEqual(pieces.length, 1);
    strictEqual(pieces[0].name, 'Star');
    strictEqual(pieces[0].width, 512);
  });

  it('refuses a schema it does not know', () => {
    deepStrictEqual(piecesOf({ schema: SCHEMA + 1, artwork: [good()] }, BASE), []);
  });

  it('drops one bad entry rather than the library', () => {
    const pieces = piecesOf({
      schema: SCHEMA,
      artwork: [
        good(),
        good({ id: 'evil', url: 'https://example.invalid/x.png' }),
        good({ id: 'heart', name: 'Heart' }),
      ],
    }, BASE);
    deepStrictEqual(pieces.map((it) => it.id), ['star', 'heart']);
  });

  it('keeps the first of two entries claiming one id', () => {
    const pieces = piecesOf({
      schema: SCHEMA,
      artwork: [good({ name: 'Star' }), good({ name: 'Impostor' })],
    }, BASE);
    strictEqual(pieces.length, 1);
    strictEqual(pieces[0].name, 'Star');
  });

  it('is empty for anything that is not a catalogue', () => {
    for (const raw of [null, 'a string', 42, {}, { schema: SCHEMA }]) {
      deepStrictEqual(piecesOf(raw, BASE), []);
    }
  });
});

describe('pieceOf', () => {
  it('refuses an id that is not a file-safe word', () => {
    for (const id of ['../escape', 'Star', 'star.png', '', 'a/b']) {
      strictEqual(pieceOf(good({ id }), BASE), null, id);
    }
  });

  it('fills in what an entry leaves out', () => {
    const piece = pieceOf({ id: 'x', name: 'X', url: good().url }, BASE);
    strictEqual(piece.author, '');
    strictEqual(piece.width, null);
    deepStrictEqual(piece.tags, []);
  });

  it('keeps only the tags that are words', () => {
    const piece = pieceOf(good({ tags: ['shape', 7, null, 'love'] }), BASE);
    deepStrictEqual(piece.tags, ['shape', 'love']);
  });
});

describe('resourceName', () => {
  it('names a piece after its id', () => {
    strictEqual(resourceName(good(), []), 'star.png');
  });

  it('does not tread on a resource already in the project', () => {
    // An attachment points at a resource by name, so reusing one would
    // silently repoint artwork somebody had already placed on the face.
    strictEqual(resourceName(good(), ['star.png']), 'star-2.png');
    strictEqual(resourceName(good(), ['star.png', 'star-2.png']), 'star-3.png');
  });
});

describe('matching', () => {
  const pieces = piecesOf({
    schema: SCHEMA,
    artwork: [
      good(),
      good({ id: 'heart', name: 'Heart', tags: ['love', 'reaction'] }),
      good({ id: 'crown', name: 'Crown', tags: ['head'] }),
    ],
  }, BASE);

  it('gives everything back for nothing typed', () => {
    strictEqual(matching(pieces, '').length, 3);
    strictEqual(matching(pieces, '   ').length, 3);
  });

  it('finds by name, by id and by tag', () => {
    deepStrictEqual(matching(pieces, 'crow').map((it) => it.id), ['crown']);
    deepStrictEqual(matching(pieces, 'HEART').map((it) => it.id), ['heart']);
    deepStrictEqual(matching(pieces, 'love').map((it) => it.id), ['heart']);
  });

  it('finds nothing rather than everything when nothing matches', () => {
    deepStrictEqual(matching(pieces, 'zzz'), []);
  });
});

describe('publishable', () => {
  it('takes the published catalogue', () => {
    strictEqual(publishable(CATALOGUE_URL), true);
  });

  it('takes a test server on this machine', () => {
    strictEqual(publishable('http://127.0.0.1:8080/catalogue.json'), true);
    strictEqual(publishable('http://localhost:8080/catalogue.json'), true);
  });

  it('refuses a plaintext catalogue somewhere else', () => {
    // The rule with nothing else in front of it. A catalogue is checked
    // against itself, so origin and directory always agree; if this were
    // unchecked, the override would be a way to serve the whole library,
    // pictures included, over a network anybody can sit on.
    strictEqual(publishable('http://artwork.example/catalogue.json'), false);
    strictEqual(publishable('http://192.168.1.9/catalogue.json'), false);
  });

  it('refuses a catalogue that is not on the web', () => {
    strictEqual(publishable('file:///tmp/catalogue.json'), false);
  });
});
