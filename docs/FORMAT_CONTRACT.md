# Three implementations of one format

The lens format has three readers, in three languages, and they have to agree
on every lens ever published.

| | Where | What it is |
|:--|:--|:--|
| **The app** | `Lens.tryParse`, Kyron (Dart) | The one that matters. What it refuses, nobody sees. |
| **The tool** | `problems()`, `kyron-lenses/tools/lens.py` | What a catalogue is checked with before it is published. |
| **The studio** | `src/format/lens.js`, here | What tells an author their lens is wrong while they are drawing it. |

`kyron-lenses/docs/FORMAT.md` is blunt about the danger of the second one, and
the same applies twice over to the third:

> A lens that passes the tool, gets published, and is then dropped by the app
> leaves its explanation in a log line on a stranger's phone.

That is the whole failure mode. Nothing crashes, nothing is logged anywhere
anybody will look, and a lens somebody spent an afternoon on simply never
appears.

## Why the studio has its own copy anyway

The studio has to answer *"is this publishable yet?"* on every keystroke — as
a width is dragged, as an id is typed. The options were:

1. **Shell out to `lens.py`.** Correct by construction, and it means shipping
   a Python runtime inside a Windows app so that twenty comparisons can be
   made by the right process. Every keystroke becomes a subprocess.
2. **Only check on publish.** The author finds out at the end, which is the
   experience this tool exists to replace.
3. **A third implementation, held to the same spec.**

Three, with the emphasis on *held*.

## What holds it

`test/format-vectors.json` is a **copy** of the file of the same name in
kyron-lenses. 106 cases, each one a lens and whether the format accepts it:

```json
{
  "id": "ar-attachments-claiming-schema-1",
  "accept": false,
  "why": "a lens with attachments that claims schema 1 is lying about what it needs",
  "lens": { "id": "sneaky", "name": "Sneaky", "attachments": [ … ] }
}
```

The same file runs against all three implementations. `npm test` runs it here;
`lens.py vectors` runs it there; the app has it in its own test suite.

CI does one more thing, which matters because this is a copy rather than the
original: **it diffs `test/format-vectors.json` against the version in
kyron-lenses on every run.** A rule tightened upstream and not mirrored here
fails the build in this repository, rather than in a log line on a handset.

### Refreshing it

```bash
npm run vectors:refresh
```

That pulls the current `format-vectors.json` from kyron-lenses `main` and
re-runs the suite. If it fails, the rules moved: change `src/format/lens.js`
to match, and do not change the vectors to match the code.

## Proving the guard works

A test suite that passes proves nothing on its own — it has to fail when the
thing it guards is broken. Three rules were loosened on purpose and each was
caught, by name:

| Loosened | Caught by |
|:--|:--|
| `asset` may start with `http` rather than `https://` | `refuses ar-asset-plain-http` |
| a frost `blur` of exactly 0 is allowed | `refuses fx-frost-blur-zero` |
| attachments no longer require `schema: 2` | `refuses ar-attachments-claiming-schema-1` |

Do this again after any substantial change to `lens.js`. It costs a minute and
it is the only evidence that the contract is real.

## The one place the languages genuinely disagree

JSON has a single number type, and the two host languages do not.

`"schema": 2.0` arrives in Python as a `float`, and `isinstance(2.0, int)` is
false — so `lens.py` refuses it. In JavaScript it arrives as `2`, and
`Number.isInteger(2)` is true — so a naive port would accept it.

`lens.js` spells this out in a comment at the `schema` check rather than
leaving it to be rediscovered. There is no vector for it today; if one is ever
added upstream, this is the line it will land on.

## Adding a rule

In this order, or the contract is briefly false:

1. Add the case to `format-vectors.json` **in kyron-lenses**, and make
   `lens.py` agree.
2. Make `Lens.tryParse` in the app agree.
3. `npm run vectors:refresh` here, and make `lens.js` agree.

Doing 3 first means the studio refuses lenses the app would happily draw,
which is the mirror of the failure this file is about and just as confusing
for whoever hits it.
