# Waveform sublines under each lyric line, vocals only, with the beat

## Goal

Cameron, 2026-11-15: "Can we add a visual waveform of the audio onto the lyric timing page and
align the words to the bumps in the waveform?" The waveform already existed, in the Timeline
panel, which he found hard to read and use, and a little laggy. Follow-up, the same day:

1. **"Can we high pass out the drums?"** Draw the waveform from the vocal range only, so the
   bumps are the singer more than the kit.
2. **"Can we annotate the BPM/beat?"** Show the tempo and mark each beat.
3. **"The waveforms are better as a background/subline of each lyric."** Every row in the
   editor gets its own strip of waveform under its words, covering just that line's time.
4. (From the first ask) the words line up with the bumps: each word sits at its start on the
   strip, and can be dragged onto a bump, snapping to it.

## Environment / context

- Backend: `app/src-tauri/src/timeline.rs` (`track_envelope`, `heard_words`); decode via
  `crate::autosync::decode_16k` (16 kHz mono i16 LE, whole song, ~4 s).
- Tempo: `crates/audio/src/tempo.rs` (`TempoTracker`: 3-band onset flux at ~200 Hz,
  autocorrelation; reports `bpm`, `confidence`, `beat_phase` from the best 20 s window).
- Editor: `app/src/lyric-editor.ts` (rows: `rowFor`, grid `time | text | ▶ | ✓`), pure ops in
  `app/src/edit-lines.ts` (`wordStarts`, `setWordStart`, `lineEnd`).
- Old panel: `app/src/lyric-timeline.ts` (one canvas, redrawn every frame).

## Decisions already made (don't re-ask)

- The vocal band is a band-pass, 250 Hz–3.5 kHz (4th-order Butterworth each side). A plain
  high-pass would drop the kick and bass but keep hats and cymbals, which sit above the voice.
  Snares overlap the voice's range and partly survive; nothing short of source separation
  removes them, and stems didn't pay in the aligner experiment.
- The beat grid is tracked (dynamic programming over the onset envelope, Ellis 2007), not a
  fixed grid from one BPM and phase: a 0.5 BPM error drifts a fixed grid by most of a second
  over a song.
- Sublines are always on in edit mode once the waveform has loaded (that's the ask). The old
  Timeline panel is left as it is until Cameron says whether to retire it.

## Design

- `track_envelope` also returns `voice` (vocal-band levels, same scale and rate as `levels`),
  `voiceOnsets` (seconds where vocal-band loudness rises sharply), `bpm` and `beats` (seconds).
- `crates/audio`: `TempoTracker::keep_history()` keeps the whole onset envelope;
  `audio::beats::track(onset, rate, bpm)` returns beat times.
- `app/src/lyric-sublines.ts`: a canvas under each timed row's words spanning the line (a
  little lead-in before its start, to its end). Vocal waveform, beat ticks, each word's label
  at its start with a tick, a playhead on the playing row. Drag a word's tick to move it;
  snaps to vocal onsets, heard words and beats (Alt: free). Click elsewhere on it to play from
  there. Canvases are drawn only when visible and reused across re-renders when nothing they
  show changed. BPM shown in the edit bar.

## Findings / gotchas

- Two cached songs (`TR_100251389`, `TR_100251393`; run with `JARLID_AUTOSYNC_TEST_AUDIO=<mp3>
  cargo test --release --lib real_song_has_a_beat -- --ignored --nocapture`): the analysis
  beyond decoding takes 0.25–0.33 s. 155.6 and 166.4 BPM, beat counts matching length × tempo,
  2.3–3.2 vocal onsets a second. Not checked by ear yet: 155/166 could be double-time readings
  of ~78/83 (the tracker's prior is centred on 120). The beat ticks would then fall on every
  eighth note, which is still a correct grid, only twice as dense.
- The tracker's whole onset envelope is kept only when asked (`keep_history`), so the live
  BPM readout's memory stays bounded.
- A drag on a strip must not re-render the rows until it is let go: `render()` replaces the
  rows, and the canvas being dragged (with its pointer capture) would go with them. Mid-drag
  only the row's time label is updated.

## Progress log

- [x] Backend: vocal band, onsets, beat tracker, tests (audio 42 pass, app 144 pass).
- [x] Frontend: sublines, drag + snap, BPM in bar; Timeline panel draws the vocal band too
  and its starts snap to vocal onsets. `tsc` clean, bun 103 pass.
- [x] README.
- [ ] **Cameron tries it in the real app** (dev build: `bun run tauri dev` in `app/`). Not
  exercised in a running app yet: the layout of the strips, the drag, the playhead.

## Open questions for the user

1. Retire the old Timeline panel now that each line has its own waveform? (Recommendation:
   yes, once the sublines have been used on a song or two; it holds the only line-end drag.)

## Things not to do

- No version bump or release unasked.
- No `title=` tooltips, no native controls.
- `cargo fmt` only on touched files.
