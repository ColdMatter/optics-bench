# Local lens catalogue for imported .zmx files

## Intent

An imported `.zmx` lens currently goes into the current setup and nowhere else, so
using it again means re-importing the file (and re-choosing any glass substitutes).
Imported lenses should instead land in a **local catalogue file** the user owns, and
show up in the catalogue browser from then on. Separately and deliberately, chosen
local lenses can be **promoted** into the shared catalogue in the repo.

## Goals

- Import `.zmx` → lens is inserted (as today) **and** written to a local catalogue
  file, e.g. `my-lenses.json`, chosen by the user and possibly on a synced folder.
- Local lenses appear in the catalogue list with the bundled ones, tagged **Local**,
  searchable the same way, each removable.
- Re-adding a local lens never re-asks about glasses that were already substituted.
- A repo script promotes chosen local lenses into the shared, bundled catalogue.

## Non-goals

- Firefox/Safari support for the local file (they keep today's import behaviour).
- Syncing between machines (a synced folder does that).
- Editing prescriptions inside the app.

## Approaches considered

1. **App writes the file directly (File System Access API) — chosen.** The file *is*
   the catalogue; Chrome/Edge only. Checked: on a `file://` page Chromium is a secure
   context, exposes `showOpenFilePicker`/`showSaveFilePicker`, and IndexedDB works for
   remembering the file handle.
2. Browser storage plus Export/Load buttons. Works everywhere, but the file only
   exists after an explicit export.
3. Download an updated file after each import. Clutters Downloads; must be reloaded
   each session. Ruled out.

## Design

**Local file format** (`my-lenses.json`):

```json
{ "version": 1,
  "lenses": [ { "prescription": { …LensPrescription… },
                "substitutions": { "H-ZF52": { "kind": "bundled", "name": "N-SF6" },
                                   "FOO":    { "kind": "index", "index": 1.85 } } } ] }
```

`substitutions` stores the user's *choice* (the existing `GlassChoice`), not the
resulting `GlassData`, because `substituteGlass` renames the data to the original
glass name and the promotion step needs to know which bundled glass was picked.
Prescriptions are validated with the same rules as setup files (`readPrescription`
in `io.ts`, exported or shared); an invalid file gives a message naming the path.

**In the app** (new `src/ui/localCatalogue.ts`; `catalogue.ts` integrates it):

- The dialog shows `Local catalogue: <file name> [Change…]`, or `[Choose file…]` when
  none is connected, or `[Reconnect]` when Chrome needs permission again after a
  restart. The handle is kept in IndexedDB.
- On a successful import, if no file is connected the user is asked to choose or
  create one; cancelling still inserts the lens, it just isn't saved locally.
- Saving replaces an existing local entry with the same part number. A local part
  with the same number as a bundled one is listed alongside it.
- Adding a local lens applies its substitutions as setup glasses (via
  `substituteGlass`, as today). If it names a non-bundled glass that it has no
  substitution for (e.g. the original import's setup already defined it), the
  existing glass-choice step runs, and the choice is written back to the entry.
- Rows for local lenses get a **Local** tag and a remove button (removes from the
  file only; setups that use it are unaffected, since setups embed prescriptions).
- If the file can't be read or written, the dialog says so; import into the setup
  still works.
- Without the File System Access API the local-catalogue line reads "The local
  catalogue needs Chrome or Edge" and import behaves as today.

**Promotion** (`npm run promote-lenses -- <my-lenses.json> [part …]`,
`scripts/promote-lenses.ts`, bundled with rolldown like `check-setup`):

- Promotes the named parts, or all of them, into **`src/data/extra-lenses.json`**,
  which the catalogue concatenates with `lenses.json`. Not `lenses.json` itself,
  because `npm run lenses` regenerates that from the Thorlabs list and would wipe them.
- Glasses: a bundled substitution rewrites the lens's `glassAfter` to the bundled
  glass name; a lens with a constant-index substitution, or with a glass that is
  neither bundled nor substituted, is refused with the reason.
- A part number already in the shared catalogue is refused unless `--replace`.
- Prints what was added, replaced and refused; the user commits the result.

**Docs:** README "Importing a lens" and "Lens catalogue" sections describe the
local file and the promote script.

## Left to the builder

Module boundaries within the UI, the IndexedDB key names, exact wording of messages,
and ordering of the list (local lenses sorted in with the rest by part number is
fine). No new tests unless asked; the existing suite and e2e smoke test must pass.
