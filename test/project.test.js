import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ASSET_BASE,
  PROJECT_VERSION,
  blank,
  blockers,
  load,
  matrixFor,
  publishPlan,
  publishable,
  save,
  schemaFor,
  toLens,
} from '../src/format/project.js';
import { fromAdjustments, isIdentity } from '../src/format/matrix.js';
import { problems } from '../src/format/lens.js';

/// A project is what the studio edits; a lens is what gets published. These
/// are the joins between them, and every one of them has a way of going
/// quietly wrong that ends as a lens somebody made never appearing.

const withArtwork = () => {
  const project = blank('specs');
  project.name = 'Specs';
  project.attachments.push({
    resource: 'glasses.png',
    anchor: 'eyes',
    width: 2.6,
  });
  project.resources.push({ name: 'glasses.png', bytes: 'PNG', width: 512, height: 180 });
  return project;
};

describe('opening and saving', () => {
  it('round-trips without losing anything', () => {
    const project = withArtwork();
    project.colour.adjustments = { contrast: 1.3, hue: 20 };
    assert.deepEqual(load(save(project)), project);
  });

  it('opens a file that is missing fields rather than refusing it', () => {
    // Forgiving on the way in on purpose: this is the studio's own scratch
    // file, and refusing to open one because a field is absent loses
    // somebody's afternoon. What has to be strict is what reaches a phone.
    const opened = load({ id: 'half', name: 'Half' });
    assert.equal(opened.id, 'half');
    assert.deepEqual(opened.attachments, []);
    assert.deepEqual(opened.effects, []);
    assert.equal(opened.version, PROJECT_VERSION);
    assert.ok(opened.colour);
  });

  it('refuses something that is not a project at all', () => {
    assert.throws(() => load('null'), TypeError);
    assert.throws(() => load('7'), TypeError);
  });
});

describe('the lens it publishes', () => {
  it('claims the smallest schema that carries what is in it', () => {
    // A lens claiming *less* than it needs is the dangerous direction: the
    // app drops it and says so in a log line on a stranger's phone.
    const plain = blank('plain');
    plain.colour.adjustments = { saturation: 0 };
    assert.equal(schemaFor(plain), 1);

    assert.equal(schemaFor(withArtwork()), 2);

    const effects = withArtwork();
    effects.effects.push({ kind: 'frost', blur: 0.2 });
    assert.equal(schemaFor(effects), 3);
  });

  it('leaves out a colour matrix that would change nothing', () => {
    const project = withArtwork();
    project.colour.adjustments = { contrast: 1, saturation: 1 };
    assert.equal(matrixFor(project), null);
    assert.ok(!('matrix' in toLens(project)));
  });

  it('lets a hand-written matrix win over the sliders', () => {
    // The sliders cannot describe every matrix, and a matrix cannot be turned
    // back into sliders. Somebody who typed twenty numbers gets those twenty
    // numbers, not the studio's guess at them.
    const typed = fromAdjustments({ sepia: 1 });
    const project = blank('typed');
    project.colour = { adjustments: { saturation: 0 }, matrix: typed };
    assert.deepEqual(matrixFor(project), typed);
  });

  it('writes the offsets only when they are not the default', () => {
    // The format's defaults are zero, and a catalogue full of "offsetX": 0
    // is noise in a review of a one-line change.
    const project = withArtwork();
    const [attachment] = toLens(project).attachments;
    assert.deepEqual(Object.keys(attachment), ['asset', 'anchor', 'width']);

    project.attachments[0].offsetY = -0.4;
    project.attachments[0].rotation = 12;
    const [moved] = toLens(project).attachments;
    assert.equal(moved.offsetY, -0.4);
    assert.equal(moved.rotation, 12);
    assert.ok(!('offsetX' in moved));
  });

  it('points an attachment at where the catalogue will serve it', () => {
    const [attachment] = toLens(withArtwork()).attachments;
    assert.equal(attachment.asset, `${ASSET_BASE}glasses.png`);
    assert.ok(attachment.asset.startsWith('https://'));
  });

  it('produces something the format accepts', () => {
    // The point of the whole module: what comes out of the studio has to be
    // a lens the app will draw, checked by the same rules the catalogue and
    // the app use.
    const project = withArtwork();
    project.colour.adjustments = { temperature: 0.3 };
    project.effects.push({ kind: 'fill', region: 'lowerFace' });

    assert.deepEqual(problems(toLens(project)), []);
  });
});

describe('what is stopping it publishing', () => {
  it('says nothing about a project that is ready', () => {
    assert.deepEqual(blockers(withArtwork()), []);
    assert.ok(publishable(withArtwork()));
  });

  it('repeats the format in the words the app would use', () => {
    const project = withArtwork();
    project.id = 'Not An Id';
    const found = blockers(project);
    assert.ok(found.some((it) => it.kind === 'format' && it.why.includes('id')));
  });

  it('notices artwork that has not been imported', () => {
    // Only the studio can see this. `toLens` happily writes a URL for a file
    // nobody has drawn yet, the format accepts it because it is a valid
    // HTTPS URL, and the lens publishes and 404s on every phone.
    const project = withArtwork();
    project.resources = [];
    const found = blockers(project);
    assert.equal(found.length, 1);
    assert.equal(found[0].kind, 'missing-artwork');
    assert.ok(found[0].why.includes('glasses.png'));
  });

  it('notices an attachment with nothing behind it', () => {
    const project = blank('empty');
    project.attachments.push({ anchor: 'eyes', width: 1 });
    assert.ok(blockers(project).some((it) => it.kind === 'missing-artwork'));
  });

  it('notices a lens that does nothing at all', () => {
    // Publishable by the format -- an id and a name is a valid lens -- and
    // pointless: it arrives in the strip as a tile that changes nothing.
    const project = blank('nothing');
    project.name = 'Nothing';
    assert.deepEqual(problems(toLens(project)), []);
    assert.ok(blockers(project).some((it) => it.kind === 'empty'));
  });

  it('leaves an attachment that already has its own URL alone', () => {
    const project = blank('borrowed');
    project.name = 'Borrowed';
    project.attachments.push({
      asset: 'https://example.com/hat.png',
      anchor: 'forehead',
      width: 2,
    });
    assert.deepEqual(blockers(project), []);
    assert.equal(toLens(project).attachments[0].asset, 'https://example.com/hat.png');
  });
});

describe('the publish plan', () => {
  it('names the file to write and the entry to add', () => {
    const plan = publishPlan(withArtwork());
    assert.deepEqual(plan.files.map((it) => it.path), ['assets/glasses.png']);
    assert.equal(plan.lens.id, 'specs');
    assert.deepEqual(plan.blockers, []);
  });

  it('writes one file for artwork used twice', () => {
    const project = withArtwork();
    project.attachments.push({
      resource: 'glasses.png',
      anchor: 'mouth',
      width: 1.2,
    });
    assert.equal(publishPlan(project).files.length, 1);
  });

  it('carries the blockers so nothing publishes on a half-built plan', () => {
    const project = withArtwork();
    project.resources = [];
    const plan = publishPlan(project);
    assert.ok(plan.blockers.length > 0);
    // And the plan is still described, so the studio can show what *would*
    // be written next to why it cannot be.
    assert.equal(plan.lens.id, 'specs');
  });

  it('does not plan to upload something already served elsewhere', () => {
    const project = blank('borrowed');
    project.name = 'Borrowed';
    project.attachments.push({
      asset: 'https://example.com/hat.png',
      anchor: 'forehead',
      width: 2,
      resource: 'hat.png',
    });
    project.resources.push({ name: 'hat.png', bytes: 'PNG' });
    assert.deepEqual(publishPlan(project).files, []);
  });
});

describe('a blank project', () => {
  it('starts at rest and changes nothing', () => {
    const project = blank();
    assert.ok(isIdentity(fromAdjustments(project.colour.adjustments)));
    assert.equal(matrixFor(project), null);
    assert.equal(schemaFor(project), 1);
  });
});
