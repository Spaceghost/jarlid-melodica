# History card: thumbs, and a Play button that shows up at once

## Goal

Two asks (2026-11-15):

1. Clicking a cover on the recently-played strip should offer thumbs up / down, as the main
   transport does for the song playing.
2. The card's "Play again" button sometimes doesn't appear on first open, and usually takes a
   couple of seconds when it does.

## Findings

- The card asks Rust for `saved_index` every time it opens. That reads and parses every
  saved-song sidecar (`<id>.json` beside each cached song) from disk, each time. Measured on this
  machine with 369 sidecars: ~5.3 s the first time (cold; Defender scans each file), ~140–360 ms
  warm. A cold read is the "couple of seconds"; someone closing the card while it waits and
  reopening it is the "doesn't load on first open".
- Thumbs need a station token and a track token (`station.addFeedback`). History entries kept
  neither the track token nor the station a thumb goes to. Saved songs' sidecars do keep a
  `trackToken` (from when the song was last served); whether Pandora accepts an old one is not
  known, so a failure has to be shown, not swallowed.

## Approach

- Rust `cache::all_saved` memoizes parsed sidecars by path + modified time + size, so only new or
  changed sidecars are read; listing is one directory read. `saved_index` runs on a blocking
  thread.
- UI keeps the last index in memory, fetches it in the background on each new track, and judges
  the card from it immediately on open, refreshing behind.
- `nowplaying` now carries `trackToken` and `thumbStation`; history entries record them and the
  rating given. New command `native_rate` rates any track on any station.
- The card shows thumbs for any entry with a track token (its own, else its saved sidecar's).
  For the song playing now they are the main thumbs (same command, same skip on thumbs down).

## Progress

- [x] Rust: memo, `rate_track`, `thumb_target`, `native_rate`, nowplaying fields
- [x] UI: index cache + prefetch (3 s after each new track); card thumbs; tokens recorded in history
- [x] Tests (engine 28, bun 107 + new thumbTarget/memo tests), tsc, cargo check; committed
- [ ] Try in the running app: thumbs on an older cover (does Pandora take an old track token?),
      and that Play again appears instantly. Not yet released.
