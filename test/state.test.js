import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { COLOUR, Editor, HISTORY, LENS } from '../src/app/state.js';
import { blank } from '../src/format/project.js';
import { fromAdjustments, isIdentity } from '../src/format/matrix.js';

/// The editor, checked without a window.
///
/// Everything the studio does to a project goes through this, so a fault here
/// is a fault in every panel at once -- and none of it needs Electron to find.

describe('changing things', () => {
  it('never mutates the project it was given', () => {
    // The whole basis of undo. If an edit writes into the old project, every
    // snapshot on the history stack quietly becomes the current one and undo
    // does nothing at all while appearing to work.
    const before = blank('one');
    const frozen = JSON.stringify(before);
    const editor = new Editor(before);

    editor.setField('name', 'Changed');
    editor.setAdjustment('contrast', 1.5);
    editor.addAttachment({ anchor: 'nose', width: 1 });

    assert.equal(JSON.stringify(before), frozen);
    assert.notEqual(editor.project, before);
  });

  it('tells whoever is watching, once per change', () => {
    let told = 0;
    const editor = new Editor(blank(), () => { told += 1; });
    editor.setField('name', 'A');
    editor.setField('name', 'B');
    assert.equal(told, 2);
  });

  it('does not record a change that changes nothing', () => {
    // Dragging a slider back to where it started should not fill the history
    // with steps that do nothing, or undo stops meaning anything.
    const editor = new Editor(blank('x'));
    editor.setField('name', 'Untitled');
    assert.equal(editor.canUndo, false);
  });
});

describe('undo', () => {
  it('goes back and forward again', () => {
    const editor = new Editor(blank());
    editor.setField('name', 'First');
    editor.setField('author', 'Someone');

    assert.equal(editor.project.author, 'Someone');
    editor.undo();
    assert.equal(editor.project.author, '');
    assert.equal(editor.project.name, 'First');
    editor.undo();
    assert.equal(editor.project.name, 'Untitled');

    editor.redo();
    assert.equal(editor.project.name, 'First');
    editor.redo();
    assert.equal(editor.project.author, 'Someone');
  });

  it('collapses a drag into one step', () => {
    // Forty frames of a slider is one action to the person dragging it.
    const editor = new Editor(blank());
    for (const value of [1.1, 1.2, 1.3, 1.4, 1.5]) {
      editor.setAdjustment('contrast', value);
    }
    assert.equal(editor.adjustments.contrast, 1.5);

    editor.undo();
    assert.equal(editor.adjustments.contrast, 1);
    assert.equal(editor.canUndo, false);
  });

  it('does not collapse two different sliders into one step', () => {
    const editor = new Editor(blank());
    editor.setAdjustment('contrast', 1.4);
    editor.setAdjustment('saturation', 0.5);

    editor.undo();
    assert.equal(editor.adjustments.saturation, 1);
    assert.equal(editor.adjustments.contrast, 1.4);
  });

  it('throws away the future when something new is done', () => {
    const editor = new Editor(blank());
    editor.setField('name', 'A');
    editor.setField('name', 'B');
    editor.undo();
    assert.equal(editor.canRedo, true);

    editor.setField('author', 'Someone');
    assert.equal(editor.canRedo, false);
  });

  it('stops remembering at the limit rather than growing forever', () => {
    const editor = new Editor(blank());
    for (let i = 0; i < HISTORY + 40; i++) {
      editor.setField('name', `name ${i}`);
      editor.setField('author', `author ${i}`);
    }
    let steps = 0;
    while (editor.canUndo) {
      editor.undo();
      steps += 1;
      assert.ok(steps <= HISTORY, 'the history did not stop growing');
    }
    assert.equal(steps, HISTORY);
  });

  it('has nothing to undo or redo at the start', () => {
    const editor = new Editor(blank());
    assert.equal(editor.canUndo, false);
    assert.equal(editor.canRedo, false);
    editor.undo();
    editor.redo();
    assert.deepEqual(editor.project, blank());
  });
});

describe('colour', () => {
  it('drops a typed matrix the moment a slider is touched', () => {
    // Otherwise every control on the panel is inert and nothing says why:
    // matrixFor lets a typed matrix win, so the sliders would move and the
    // lens would not.
    const editor = new Editor(blank());
    editor.setMatrix([
      1, 0, 0, 0, 20,
      0, 1, 0, 0, 0,
      0, 0, 1, 0, 0,
      0, 0, 0, 1, 0,
    ]);
    assert.ok(editor.colourIsTyped);

    editor.setAdjustment('saturation', 0.4);
    assert.ok(!editor.colourIsTyped);
    assert.equal(editor.matrix[4], 0);
  });

  it('goes back to changing nothing when reset', () => {
    const editor = new Editor(blank());
    editor.setAdjustment('hue', 90);
    editor.setAdjustment('sepia', 0.5);
    assert.ok(editor.matrix);

    editor.resetColour();
    // Null rather than the identity: a lens that carries twenty numbers
    // meaning "leave it alone" makes the app build a ColorFilter and run it
    // over every pixel of every frame to change nothing.
    assert.equal(editor.matrix, null);
    assert.ok(isIdentity(fromAdjustments(editor.project.colour.adjustments)));
  });
});

describe('attachments and effects', () => {
  it('selects what it just added', () => {
    // Adding something and then having to find it is the kind of small
    // rudeness that makes a tool feel unfinished.
    const editor = new Editor(blank());
    editor.addAttachment();
    assert.deepEqual(editor.selection, { kind: 'attachment', index: 0 });

    editor.addEffect('frost');
    assert.deepEqual(editor.selection, { kind: 'effect', index: 0 });
  });

  it('gives a new attachment defaults the format accepts', () => {
    const editor = new Editor(blank());
    editor.addAttachment();
    const [added] = editor.project.attachments;
    assert.ok(added.width > 0 && added.width <= 12);
    assert.ok(['eyes', 'nose', 'mouth', 'forehead', 'chin'].includes(added.anchor));
  });

  it('gives a new effect the format\'s own defaults', () => {
    // Matched to LensEffect.tryParse in the app: `json['feather'] ?? 0.14`.
    // A studio that started a fill somewhere else would show one thing and
    // publish another for anybody who never touched the control.
    const editor = new Editor(blank());
    editor.addEffect('fill');
    assert.deepEqual(editor.project.effects[0], {
      kind: 'fill',
      region: 'lowerFace',
      feather: 0.14,
      keepShading: 0.35,
    });

    editor.addEffect('frost');
    assert.deepEqual(editor.project.effects[1], {
      kind: 'frost',
      blur: 0.16,
      desaturate: 0.3,
      lift: 0.16,
      feather: 0.05,
    });
  });

  it('moves the selection off something that was deleted', () => {
    // A selection pointing at index 1 of a list with one item in it is how an
    // inspector ends up reading properties of undefined.
    const editor = new Editor(blank());
    editor.addAttachment();
    editor.removeAttachment(0);
    assert.deepEqual(editor.selection, LENS);
    assert.equal(editor.project.attachments.length, 0);
  });

  it('changes only the one it was asked to', () => {
    const editor = new Editor(blank());
    editor.addAttachment({ anchor: 'eyes' });
    editor.addAttachment({ anchor: 'chin' });
    editor.setAttachment(0, { width: 3 });

    assert.equal(editor.project.attachments[0].width, 3);
    assert.equal(editor.project.attachments[1].anchor, 'chin');
    assert.equal(editor.project.attachments[1].width, 2);
  });
});

describe('artwork', () => {
  it('replaces artwork of the same name rather than keeping both', () => {
    // Re-importing is how somebody iterates on a drawing. Two resources with
    // one name would publish whichever the code happened to find first.
    const editor = new Editor(blank());
    editor.addResource({ name: 'star.png', bytes: 'one' });
    editor.addResource({ name: 'star.png', bytes: 'two' });

    assert.equal(editor.project.resources.length, 1);
    assert.equal(editor.resource('star.png').bytes, 'two');
  });

  it('unhooks anything using artwork that is deleted', () => {
    // So that what is on screen is what would publish, rather than an
    // attachment quietly pointing at a file that is gone.
    const editor = new Editor(blank());
    editor.addResource({ name: 'star.png', bytes: 'one' });
    editor.addAttachment({ resource: 'star.png' });
    editor.removeResource('star.png');

    assert.equal(editor.project.attachments[0].resource, null);
    assert.ok(editor.blockers.some((it) => it.kind === 'missing-artwork'));
  });
});

describe('what it would publish', () => {
  it('is the lens, not the project', () => {
    const editor = new Editor(blank('specs'));
    editor.setField('name', 'Specs');
    editor.addResource({ name: 'g.png', bytes: 'PNG' });
    editor.addAttachment({ resource: 'g.png', anchor: 'eyes', width: 2.6 });

    const lens = editor.lens;
    assert.equal(lens.schema, 2);
    assert.ok(lens.attachments[0].asset.startsWith('https://'));
    assert.ok(!('resource' in lens.attachments[0]));
    assert.deepEqual(editor.blockers, []);
  });

  it('knows when the file on disk is behind', () => {
    const editor = new Editor(blank());
    assert.equal(editor.dirty, false);

    editor.setField('name', 'Changed');
    assert.equal(editor.dirty, true);

    editor.toFile();
    assert.equal(editor.dirty, false);

    editor.undo();
    assert.equal(editor.dirty, true);
  });
});

describe('selection', () => {
  it('starts on the lens itself', () => {
    assert.deepEqual(new Editor(blank()).selection, LENS);
  });

  it('can be pointed at the colour panel', () => {
    const editor = new Editor(blank());
    editor.select(COLOUR);
    assert.equal(editor.selection.kind, 'colour');
  });
});
