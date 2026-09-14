// src/format/artwork.js
//
// The Kyron artwork library, as rules.
//
// kyron-artwork publishes `catalogue.json` to GitHub Pages -- a list of CC0
// pieces anybody can put on a face. It exists because the first thing this
// tool asks of somebody opening it is the one thing they do not have yet:
// "Nothing imported yet" is where a beginner stops.
//
// Nothing here fetches anything. These are the checks applied to a file that
// arrived over the network, kept apart from the fetching so they can be run
// against a hostile catalogue in a test without a server. The fetching is in
// src/main/main.js, because the renderer must not be given the network: its
// Content-Security-Policy is `connect-src 'self'` and `img-src 'self' data:`,
// so a window that loads somebody's PNG cannot also call out.
//
// The trust model is the one kyron-lenses states for lenses: this is data,
// not code. A catalogue names pictures; it never names anything to run. The
// worst a hostile one can do is look wrong -- provided it cannot also make
// the studio fetch from somewhere it chose, which is what [fetchable] is for.

/** The schema this understands. A newer catalogue is refused, not guessed at. */
export const SCHEMA = 1;

/**
 * The largest picture that will be fetched, in bytes.
 *
 * The same ceiling the app applies to a lens asset. A sticker is a few
 * hundred kilobytes; anything approaching this is either a mistake or
 * somebody seeing how much a window will swallow.
 */
export const MAX_BYTES = 4 * 1024 * 1024;

/** What is served, and the only two types a picture may be. */
export const TYPES = new Set(['image/png', 'image/webp']);

/**
 * Where the library is published.
 *
 * Overridable with KYRON_ARTWORK_CATALOGUE so a staging build can point
 * elsewhere, which is the same escape hatch the app gives its lens catalogue
 * through `--dart-define=KYRON_LENS_CATALOGUE`.
 */
export const CATALOGUE_URL =
  'https://kyronlabs.github.io/kyron-artwork/catalogue.json';

/**
 * Whether the studio is willing to fetch `url` for a catalogue served from
 * `catalogueUrl`.
 *
 * Two rules, and both matter for the same reason: a catalogue is a file
 * somebody else edits, so every URL in it is somebody else's text.
 *
 * 1. **HTTPS**, or loopback. Plaintext over a network is somebody on the
 *    same wifi choosing what picture arrives. Loopback is allowed because a
 *    test server is not on a network, and browsers make the same exception.
 * 2. **The catalogue's own directory.** A piece must live beside the file
 *    that lists it. Without this, a catalogue could name any host on the
 *    internet and the studio would fetch it -- turning a list of pictures
 *    into a way to make somebody's machine make requests it did not choose.
 *    It is also what stops a piece and its listing being published out of
 *    step, which is why kyron-lenses serves its assets the same way.
 *
 * The first rule reads as redundant next to the second -- a scheme is part of
 * an origin, so http and https are already different origins -- and for a
 * piece it is. It is not redundant for [publishable], where a URL is checked
 * against itself and the origin rule can say nothing.
 */
export function fetchable(url, catalogueUrl) {
  let asked;
  let base;
  try {
    asked = new URL(url);
    base = new URL(catalogueUrl);
  } catch {
    return false;
  }

  const loopback =
    asked.hostname === 'localhost' ||
    asked.hostname === '127.0.0.1' ||
    asked.hostname === '[::1]' ||
    asked.hostname === '::1';
  if (asked.protocol !== 'https:' && !(asked.protocol === 'http:' && loopback)) {
    return false;
  }

  if (asked.origin !== base.origin) return false;

  // The catalogue's directory, not its path: `/kyron-artwork/catalogue.json`
  // permits `/kyron-artwork/art/star.png` and refuses `/somebody-else/x.png`.
  const directory = base.pathname.slice(0, base.pathname.lastIndexOf('/') + 1);
  return asked.pathname.startsWith(directory);
}

/**
 * Whether a catalogue may be fetched from `url` at all.
 *
 * `KYRON_ARTWORK_CATALOGUE` is a deliberate developer knob, and the same
 * escape hatch the app gives its lens catalogue -- but a knob set to
 * `http://somewhere/catalogue.json` would put the whole library, and every
 * picture the studio then fetches under it, on the far side of anybody
 * sitting on the same network. Checking it against itself leaves exactly one
 * rule with anything to say, which is the scheme.
 */
export function publishable(url) {
  return fetchable(url, url);
}

/**
 * The pieces in a catalogue, or an empty list.
 *
 * Forgiving one entry at a time, like the app's lens catalogue: a piece that
 * is missing a field costs that piece, not the library. Refusing the whole
 * file over one bad row would mean anybody's pull request could take the
 * library away from everybody.
 */
export function piecesOf(raw, catalogueUrl = CATALOGUE_URL) {
  if (!raw || typeof raw !== 'object') return [];
  if (raw.schema !== SCHEMA) return [];
  if (!Array.isArray(raw.artwork)) return [];

  const pieces = [];
  const seen = new Set();
  for (const entry of raw.artwork) {
    const piece = pieceOf(entry, catalogueUrl);
    if (!piece || seen.has(piece.id)) continue;
    seen.add(piece.id);
    pieces.push(piece);
  }
  return pieces;
}

/** One entry, or null if the studio could not use it. */
export function pieceOf(entry, catalogueUrl = CATALOGUE_URL) {
  if (!entry || typeof entry !== 'object') return null;
  const { id, name, url } = entry;
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(id)) return null;
  if (typeof name !== 'string' || !name.trim()) return null;
  if (typeof url !== 'string' || !fetchable(url, catalogueUrl)) return null;

  const width = Number.isInteger(entry.width) ? entry.width : null;
  const height = Number.isInteger(entry.height) ? entry.height : null;

  return {
    id,
    name: name.trim(),
    url,
    width,
    height,
    author: typeof entry.author === 'string' ? entry.author : '',
    licence: typeof entry.licence === 'string' ? entry.licence : '',
    tags: Array.isArray(entry.tags)
      ? entry.tags.filter((it) => typeof it === 'string')
      : [],
  };
}

/**
 * The file name a piece becomes once it is in a project.
 *
 * A resource is keyed by name, and an attachment points at one by name, so
 * two pieces landing on the same name would silently repoint an attachment
 * somebody had already placed. `taken` is the names already in the project.
 */
export function resourceName(piece, taken = []) {
  const already = new Set(taken);
  const base = `${piece.id}.png`;
  if (!already.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const tried = `${piece.id}-${n}.png`;
    if (!already.has(tried)) return tried;
  }
}

/**
 * Pieces matching what somebody typed, over name, id and tags.
 *
 * Ten pieces need no search. A hundred do, and the list is meant to grow --
 * so this is here from the start rather than added once the grid is
 * unusable.
 */
export function matching(pieces, words) {
  const needle = String(words ?? '').trim().toLowerCase();
  if (!needle) return pieces;
  return pieces.filter((piece) =>
    piece.name.toLowerCase().includes(needle) ||
    piece.id.includes(needle) ||
    piece.tags.some((tag) => tag.toLowerCase().includes(needle)));
}
