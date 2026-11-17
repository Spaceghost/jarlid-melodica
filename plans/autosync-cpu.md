# Auto-sync sidecar CPU use

## Goal

`jarlid-autosync.exe` was measured averaging 110% CPU (1.1 cores, peaks 150–200%) for 90 s on
2026-11-16 5:46 PM PST (01:46Z, PID 30488). Cameron didn't know of anything syncing, and the machine
was ~86% busy. It contributes to audio glitches and UI stalls. The task: find why, make it near-idle
when there is nothing to sync and cheaper when there is, with before/after numbers.

## Environment / context

- Machine: i7-10710U (6 cores / 12 threads, 15 W), Intel UHD iGPU (Vulkan), Windows 11.
- Installed engine: `%APPDATA%\com.camer.pandora-desktop\autosync\engine-0.2.0\` (Parakeet via
  ggml, GPU setting on → Vulkan on the iGPU). Aligner: `...\autosync\aligner\mms-fa-int8.onnx`
  + `onnxruntime.dll` (ORT 1.31.1).
- App log: `%LOCALAPPDATA%\com.camer.pandora-desktop\logs\jarlid.log` (`[autosync]` lines).
- `threads()` in `app/src-tauri/src/autosync/mod.rs` = logical/4 → 3 here. The sidecar runs at
  BELOW_NORMAL priority.
- Sidecar source `crates/autosync-sidecar`; app side `app/src-tauri/src/autosync/`. A sidecar
  change only reaches users as a new engine release (manifest hash pinned in `component.rs`).
- Bench harness (scratch, not in repo):
  `C:\Users\camer\AppData\Local\Temp\claude\bc125a2150c32671\8b74860b-8dfb-456d-8385-4cc313d0a166\scratchpad\bench\bench.py`.
  It drives a sidecar exe at BELOW_NORMAL over one song (180 s, `TR_38134925.mp3` → 16 kHz WAV),
  with 95 line spans (195 s of audio) taken from a stored refined file. It reports wall time and
  sidecar CPU-seconds, model load excluded. Run it through `srmctl run --slots N`.

## Findings

1. **Not a spin loop or a re-scan.** The sidecar only does work when a command arrives (a stdin
   reader plus one worker), and the app stops it after 90 s idle (`IDLE`). It never went idle
   because the app kept feeding it real jobs.
2. **Every new song is processed, once.** Per song the log shows `timing words` (Parakeet hears
   the whole song) and/or `sharpening word timings` (the MMS-FA aligner over every line). There
   were 64 sharpen jobs from 2026-11-15 2:27 PM to 11-16 6:03 PM PST, and **no song was
   repeated**, so the caching works. The work is real, just expensive.
3. Stack samples (cdb `-pv`, 6 samples, 6:05 PM PST) during a sharpen job put the CPU in
   `onnxruntime.dll` compute kernels, on the worker thread and `session-1-intra-op-0/1`.
4. **Aligner cost, one 180 s song** (installed 0.2.0 exe, same spans each run):

   | threads | ORT spinning | CPU-s | wall | machine busy |
   |---|---|---|---|---|
   | 3 (before) | on (default) | 114 / 119 / 121 / 134 / 149 / 186 / 204 | 41–122 s | 58–85% |
   | 3 | off | 101 / 107 / 132 / 134 / 160 | 40–97 s | 59–80% |
   | 2 | off | 95 / 102 | 54–58 s | 55–60% |
   | 1 (after) | n/a (no pool) | **77 / 94 / 96 / 98** | 79–110 s | 38–58% |

   The same work costs ~90 CPU-s at any thread count. Extra threads only add spin and sync
   waste, which grows with machine load (186–204 CPU-s at 3 threads when busy). One thread has
   no pool to spin, holds at most one core, and still finishes well inside the song before.
5. **Hearing (Parakeet), same song:** GPU on: 15–17 CPU-s in 70–86 s. GPU off: 272 CPU-s in
   123 s. With the GPU on, the CPU cost is small, **but the iGPU 3D engine sits at 55–70% for
   ~70 s per song**. That engine is shared with dwm and WebView2, so it is a plausible cause of
   the UI stalls. Not proven.
6. What remains after the fix: ~90 CPU-s of aligner per new song, about 0.5 core averaged over a
   3-minute song, capped at 1 core. Going lower means doing less work (see open questions).

## Decisions already made (don't re-ask)

- Aligner on 1 thread (`ALIGNER_THREADS`), app-side only, so no engine release is needed
  (`027285f`). The trade-off: sharpening takes ~110 s instead of ~40 s, and so does the editor's
  "Time the rest" (`retime.rs`), because the aligner is loaded once per sidecar process.

## Progress log

- [x] Profile live process: real per-song jobs, ORT compute, no busy loop
- [x] Offline bench: aligner threads × spinning, hearing GPU on/off
- [x] Fix: aligner on one thread (`027285f`); clippy and `cargo test autosync` pass
- [x] Released in v1.27.2 (`70e9537`, 2026-11-17 12:51 PM PST): setup .exe, .sig, latest.json all up
- [ ] Live after-measurement once this machine runs 1.27.2

## Open questions for the user

Answered 2026-11-17: Cameron asked to process only the playing and next songs. That was already
the behaviour (`native.rs` `TrackStarted` / `NextDownloaded`); my "every new song in the
background" wording had misled. Given that, he chose no setting, just a patch release of the fix.
Lyrics-pane gating and the GPU A/B were dropped.

## Things not to do

- Don't bump versions or cut an engine/app release without Cameron asking.
- Don't trust single bench runs: the live app's own sidecar and other load swing CPU-seconds by
  ±40%. Interleave variants and compare at similar machine load.
- `intra_op.allow_spinning=0` (sidecar change) only saves ~12% at 3 threads. One thread makes it
  moot without an engine release.
