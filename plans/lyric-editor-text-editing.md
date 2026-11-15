# Lyric editor: behave like a text editor

## Goal

Cameron, 2026-11-15: the lyric editor "needs to work a little bit better as a text editor":

1. Delete at the end of a line brings the next line up, as Backspace at the start already does.
2. Up/Down arrows move between lines.
3. Selecting a block of text across lines works.
4. Cut and paste work, across lines too.
5. "Back 5s" and similar bar buttons don't appear consistently.

Also asked: "Do we also want metadata labels for chorus etc?" Those already exist (see
`plans/lyric-sections.md`, commit `aecaa6f`). A line that is only a label (`[Chorus]`,
`Verse 2:`) is drawn as a heading in the editor, never timed, and saved into `plain` only.

## Environment / context

- Editor DOM and behaviour: `app/src/lyric-editor.ts`. Pure line edits (tested):
  `app/src/edit-lines.ts`, `app/src/edit-lines.test.ts` (`bun test` in `app/`).
- Styles: `app/src/styles.css`, section "editing lyrics in place" (around line 2825).
- Bar markup: `app/index.html`, `#lyric-bar`. `[hidden]` is `display: none !important`.
- Runs in WebView2 (Chromium), so Chromium's contenteditable and Input Events behaviour is
  the target.

## Root cause

Each row's `.ln-text` was its own `contenteditable` host. A browser selection can't span
editing hosts, and caret movement stops at a host's edge. So up/down, block selection and
cross-line cut/paste could never work with that structure. Only Enter and Backspace had
been emulated by hand.

## Decisions (don't re-ask)

- **One editing host for the whole list** (`#lyrics` itself while editing). Row controls
  (time, ▶, ✓) are `contenteditable=false` islands with `user-select: none`. Native caret
  movement and selection then work across rows.
- **Every edit goes through the line model.** `beforeinput` is cancelled and the edit is
  applied to `lines` (`edit-lines.ts`), then the DOM is redrawn and the caret restored. The
  DOM never drifts from the model, and timings and review state follow every edit.
  IME composition can't be cancelled. Its result is diffed back into the model on `input`.
- **Own undo/redo** (Ctrl+Z, Ctrl+Y, Ctrl+Shift+Z), because cancelled input leaves native
  undo empty. It snapshots `lines`. A change made outside text editing (a timeline drag, a
  stamp) becomes its own undo step the next time the history is touched.
- **Joining lines at a line break adds a space** (Backspace at start, Delete at end), as
  joining had already done: two lyric lines are separate words. Deleting a *selection* that
  spans lines concatenates exactly, like any text editor.
- **Copy/cut carry the lines' timings** in a private clipboard type
  (`application/x-jarlid-lines`), so cut and paste moves timed lines with their times.
  `text/plain` carries just the words. Pasting LRC text still picks up its timestamps.
- **Word timings survive an edit for words it didn't touch.** Same word count keeps all
  times (a spelling fix), as before. Otherwise words wholly before or after the edit keep
  theirs, and the touched ones become untimed (the timeline spreads them evenly). This
  partly helps the ISSUES.md entry about edits losing word timings. That entry asks for a
  real aligner, which remains open.
- **The bar is stable.** Every button always shows and is disabled when it can't act, so the
  bar never reshuffles. Back 5s works outside a timing pass too (a plain seek back).

## Plan / steps

1. Model: `editText` (range edit on one line, keeping word times), `textBetween` / `slice`
   for copy, `insertLines` for paste, `deleteRange` across lines, `joinDown`. Tests.
2. Editor: single host, `beforeinput` dispatch, DOM↔model positions, copy/cut/paste, undo,
   render preserving selection and scroll.
3. CSS: controls unselectable, empty lines keep a caret box.
4. Bar: stable buttons.
5. Typecheck, tests, try it in the app.

## Progress log

- [x] 1. Model + tests: `editText`, `deleteRange`, `joinDown`, `sliceLines`, `insertLines`;
  `retext` now diffs into `editText`. 13 new tests in `edit-lines.test.ts`.
- [x] 2. Editor: one host, `beforeinput`, clipboard with timings, own undo. The list stops
  being editable during a timing pass, so Space marks instead of typing.
- [x] 3. CSS
- [x] 4. Bar: Back 5s, Check after each change, and Discard my edit are always shown, and
  disabled when they can't act.
- [x] 5. Verified: `tsc`, `bun test` (103 pass), and a headless Chromium run (Playwright)
  of the bundled editor. That run covered Delete at end, up/down through an empty line,
  typing and undo, cross-line selection, cut, paste with timings, Enter, Backspace, Ctrl+A
  copy, the bar, and Space during a pass. 23 checks, all passing.
- [ ] Cameron tries it in the real app (IME input and the Windows touch keyboard weren't tested).

## Findings / gotchas

- `cargo`/Rust is not involved; this is all `app/src`.
- Cutting whole lines first left an empty line holding the last cut line's start, which made it
  a pause marker. Now a line whose beginning is cut takes its first remaining word's time, or
  no start if nothing is left (`deleteRange`).
- To test the editor headless, bundle it with `Bun.build`, stub `@tauri-apps/api/core` with an
  `onResolve` plugin, and serve `index.html` with `#player` unhidden. It is hidden until a
  track loads, so nothing in it can take focus.

## Things not to do

- Don't go back to per-row `contenteditable`. It can't support cross-line selection.
