# Retime a listener's lyrics from what the engine heard

## Goal

Cameron, 2026-11-15, on "nice guys finish last" (bludnymph): he fixed the text and line breaks
and timed some lines by hand, not all. He wants the app to time every line and word
automatically from speech/word detection, written into the edit where he can review it.

1. **Lookalike letters.** Text pasted from lyric sites can carry Cyrillic (and similar)
   letters that look Latin (`mе`, `livеr`). Always replace them with the plain ASCII letter,
   "for all similar non-ASCII characters". Also scan the other stored lyrics for them.
2. **"Time the rest" in the lyric editor** (Cameron: "yes, this"). A button that writes
   generated line and word times into the edit, for him to review and nudge.
3. **His times are strong hints, not fixed anchors** ("I suspect you can do per-word
   alignment better than I can"). The aligner may move a hand-set line time when the audio
   clearly disagrees.

## Environment / context

- Override: `%APPDATA%\com.camer.pandora-desktop\lyrics-overrides\f6c2a6bacfd3161a.json`
  (95 lines, 35 timed, no word times, `source: "local edit"`).
- Heard words: `%LOCALAPPDATA%\com.camer.pandora-desktop\lyrics-heard\f6c2a6bacfd3161a.json`
  (engine 0.1.0, 381 words; heard almost every line).
- Forced aligner ("Sharper word timing"): Cameron enabled it 2026-11-15; installed at
  `%APPDATA%\com.camer.pandora-desktop\autosync\aligner`.
- Code: `crates/autosync/src/retime.rs` (line pass), `lookalike.rs` (folding);
  `app/src-tauri/src/autosync/retime.rs` (command `autosync_retime`: lines, words, aligner);
  editor button `#lyric-autotime` in `app/index.html`, handler `autoTime` in
  `app/src/lyric-editor.ts`.
- Try the line pass offline: `cargo run --release -p autosync --example retime --
  <override.json> <heard.json>` (from `crates/`).

## Decisions already made (don't re-ask)

- Option (b): an editor control writes the times into the edit (Cameron, 2026-11-15).
- Hand-set times are strong hints, not pins (Cameron, 2026-11-15).
- Lookalike letters are always folded to ASCII, everywhere lyrics text is read or saved.

## Design (as built)

- **Lines** (`autosync::retime`): the line aligner's word match (`align::match_words`) with an
  expected span per lyric word, from the hints around its line ± 2 s. A match outside costs
  0.5 per second, capped at 1.2 (a perfect match scores 1.5, so strong evidence still wins).
  Line start = first matched word, stepped back over unmatched ones. **Stamping offset** =
  median(hint − heard) over lines where they agree within 1 s (≥ 3 such lines; else −0.15 s),
  clamped to −0.8…+0.4 s, added to every heard start, so generated lines read like his taps.
  A hint stays unless it's more than 1 s from the heard time *and* ≥ 3 of its words (or all of
  a shorter line's) matched; then it moves. Kept hints are the skeleton: heard/moved times that
  don't fit between them are dropped (a moved hint reverts). The rest are interpolated by
  stanza (`align::interpolate`, `Alignment::placed`). Blank lines keep a pause hint while it
  still falls between its neighbours.
- **Words**: `words::time_words` on the new spans (each to the next timed line, pause
  included), then `refine::refine` with emissions from the sidecar when sharper word timing is
  on, the aligner is installed and the song's audio is found (now playing, or in the song
  cache). Hand-set word times are not kept: all words are re-made.
- **Editor**: one undoable edit; line times rounded to 0.01 s (as the LRC holds them). The
  status line says how many lines were kept, timed by ear, placed, and moved (by line number),
  and whether the aligner sharpened the words or why not.
- **Lookalikes** (`autosync::lookalike::fold`): Cyrillic/Greek letters with a Latin twin,
  fullwidth letters/digits, invisible characters. A line containing any Cyrillic/Greek letter
  *without* a Latin twin is real text: only mixed-script words are folded in it. Fullwidth
  punctuation is left (correct in Japanese). Applied in `text::words`, `ctc::romanize`,
  `lyrics::lookup` (so every reader sees folded text) and `save_lyrics_override`. Stored
  auto-sync results and refined lines made from unfolded text are migrated on read.

## Findings / gotchas

- `lrc::parse` drops lines without a stamp, so untimed lines in a saved edit never got a line or
  word time before this.
- **LRCLIB itself serves lookalikes.** Scan 2026-11-15 of everything stored on this machine:
  96 of ~1,640 cached LRCLIB records, 7 auto-sync results, 1 refined result and the nice-guys
  override had them. 364 Cyrillic `е` (U+0435), a few `о`, `ѕ`, `а`, two BOMs; most common
  words "thе" (35), "mе" (22), "whеn" (13). Zero lines of real Cyrillic/Greek were in the
  stores. Fullwidth `？` showed up only in real Japanese lines, which is why punctuation is not
  folded.
- Folding changes the plain text, so `fnv(plain)` no longer matched auto-sync results stored
  from the raw text: without the migration, 7 songs would have been re-heard and lost their
  auto-synced lines until then. `folded_result` keeps a result when its folded timed lines are
  exactly the folded plain's sung lines.
- Nice guys, line pass: coverage 84%, offset −0.26 s; 35 hints kept, none moved, 3 lines placed
  ("Now I'm on my knees", "Baby", the third chorus's first line, which the engine heard as
  "My sky is finished, I style").

## Progress log

- [x] Read the code paths; design (above).
- [x] Lookalike folding + migration (`cde5147`). The override's 4 Cyrillic `е` replaced on
  disk, original kept as `lyrics-overrides\f6c2a6bacfd3161a.json.before-lookalike-fold.bak`.
- [x] Line pass, command, editor button, README (`e7a2951`). Crate tests 64 pass, app tests 141
  pass, `tsc` clean, bun tests 103 pass.
- [ ] **Not exercised in the app**: the button, the sidecar emission path and the editor
  apply. Needs a build with these commits (dev run or a release; Cameron's call).
- [ ] Cameron runs "Time the rest" on nice guys, checks by ear, saves.

## Open questions for the user

1. How do you want to try it: a dev build (`bun run tauri dev` in `app/`), or a release?
   (A release only on your say-so.)

## Follow-ups (not started)

- The editor shows pasted lookalikes as they are until the edit is saved and reopened (save
  folds them). A TypeScript twin of `fold` on paste/typing would fix the screen too.

## Things not to do

- Don't write into `lyrics-overrides` without a `.bak` beside the original.
- Don't bump versions or cut a release unasked.
- Don't fold fullwidth punctuation or whole lines of real Cyrillic/Greek.
