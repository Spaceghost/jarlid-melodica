// A strip of waveform under each timed line in the lyric editor: just that line's stretch of
// the song, with its words placed on it where they start, so a word sitting off its bump shows
// at a glance and is dragged onto it.
//
// The waveform is the vocal range only (the backend band-passes out the kick, the bass and the
// cymbals), so the bumps are mostly the singing. Beats are ticked along the bottom. A dragged
// word snaps to where the vocal range gets louder, to a word the speech engine heard, or to a
// beat; Alt drags freely.
//
// Each strip is its own small canvas, drawn once when it scrolls into view and kept across the
// editor's re-renders while nothing it shows has changed. Only the playhead moves every frame,
// and it is a positioned element, not a redraw. See plans/lyric-sublines.md.

import { invoke } from "@tauri-apps/api/core";
import { isBlank, lineEnd, setWordStart, wordStarts, wordsOf, type Line } from "./edit-lines";

export interface Envelope {
  title: string;
  artist: string;
  rate: number;
  levels: number[];
  voice: number[];
  voiceOnsets: number[];
  bpm: number | null;
  beats: number[];
}
export interface HeardWord {
  text: string;
  start: number;
  end: number;
  p: number;
}

export interface SublineHost {
  meta(): { title: string; artist: string; album: string };
  lines(): Line[];
  playhead(): { position: number; paused: boolean };
  duration(): number | null;
  canSeek(): boolean;
  seek(t: number): void;
  /// A drag is about to change line `i` (one undo step per drag).
  begin(i: number): void;
  /// Line `i` changed under a drag; `done` once it is let go.
  changed(i: number, done: boolean): void;
  /// The waveform arrived (or failed): draw the rows again.
  loaded(bpm: number | null, problem: string | null): void;
}

// ---- the song's data, shared with the timeline panel ------------------------------------------

let pending: { key: string; data: Promise<[Envelope, HeardWord[]]> } | null = null;

/// The edited song's envelope and heard words. One fetch per song, however many ask.
export function fetchSong(meta: { title: string; artist: string; album: string }) {
  const key = `${meta.artist}\u0000${meta.title}\u0000${meta.album}`;
  if (pending?.key !== key) {
    const data = Promise.all([
      invoke<Envelope>("track_envelope"),
      invoke<HeardWord[]>("heard_words", {
        artist: meta.artist,
        track: meta.title,
        album: meta.album || null,
      }),
    ]);
    pending = { key, data };
    // A failure is not kept: the next ask tries again (the song may be playing by then).
    data.catch(() => {
      if (pending?.data === data) pending = null;
    });
  }
  return pending.data;
}

/// The level range to stretch onto the drawing height: songs are mastered loud, so each one's
/// own range from its quiet tenth up, or every bar is the same height.
export function rangeOf(levels: number[]): [number, number] {
  const sorted = [...levels].sort((a, b) => a - b);
  const lo = sorted[Math.floor(sorted.length * 0.1)] ?? 0;
  const hi = sorted[sorted.length - 1] ?? 255;
  return [lo, Math.max(hi, lo + 1)];
}

// ---- state -----------------------------------------------------------------------------------

/// How much of the song before a line's start its strip shows, so a start that is late can be
/// dragged back onto the bump it missed.
const LEAD = 0.4;
/// The longest a strip runs: a last line, or one before a long instrumental, would otherwise
/// squash its words into the first few pixels.
const MAX_SPAN = 12;
const HEIGHT = 34;
const WAVE: [number, number] = [0, 21];
const LABELS: [number, number] = [22, 34];
/// How near a word's tick counts as grabbing it, and how near a target it snaps to, in pixels.
const GRAB = 6;
const SNAP = 8;

let host: SublineHost | null = null;
let env: Envelope | null = null;
let heard: HeardWord[] = [];
let range: [number, number] = [0, 255];

interface Strip {
  el: HTMLElement;
  canvas: HTMLCanvasElement;
  head: HTMLElement;
  /// The line it draws, and what it showed when last drawn.
  line: number;
  from: number;
  to: number;
  key: string;
  drawn: string;
}
/// Strips by what they show, so a re-render that changed nothing here reuses them as they are.
let strips = new Map<string, Strip>();
let used = new Set<string>();
let drag: { strip: Strip; word: number; moved: boolean } | null = null;
let frame = 0;

const visible = new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting) draw(stripOf(e.target));
});
const resized = new ResizeObserver((entries) => {
  for (const e of entries) draw(stripOf(e.target));
});
const byEl = new WeakMap<Element, Strip>();
const stripOf = (el: Element) => byEl.get(el)!;

export function open(h: SublineHost) {
  host = h;
  env = null;
  heard = [];
  strips = new Map();
  fetchSong(h.meta()).then(
    ([e, words]) => {
      if (host !== h) return;
      heard = words;
      const meta = h.meta();
      if (e.title !== meta.title || e.artist !== meta.artist) {
        h.loaded(null, "The waveforms need this song playing.");
        return;
      }
      env = e;
      range = rangeOf(e.voice.length ? e.voice : e.levels);
      h.loaded(e.bpm, null);
    },
    (err) => {
      if (host === h) h.loaded(null, `No waveform: ${err}`);
    }
  );
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(tick);
}

export function close() {
  host = null;
  env = null;
  drag = null;
  strips = new Map();
  cancelAnimationFrame(frame);
}

// ---- building ----------------------------------------------------------------------------------

/// The stretch of song line `i`'s strip shows, or null for a line that gets none.
function spanOf(lines: Line[], i: number): [number, number] | null {
  const line = lines[i];
  if (line.t === null || isBlank(line)) return null;
  const length = songLength();
  const end = Math.min(lineEnd(lines, i, length || line.t + MAX_SPAN), line.t + MAX_SPAN);
  return [Math.max(0, line.t - LEAD), Math.max(end, line.t + 0.5)];
}

/// The strip for line `i`, for the editor to put in its row, or null when it gets none (not
/// timed, empty, or no waveform yet). Call [`prune`] once the rows are all built.
export function stripFor(i: number): HTMLElement | null {
  if (!host || !env) return null;
  const lines = host.lines();
  const span = spanOf(lines, i);
  if (!span) return null;
  const line = lines[i];
  const key = JSON.stringify([span, line.text, wordStarts(lines, i, songLength()), line.words]);
  used.add(key);
  let s = strips.get(key);
  if (s) {
    s.line = i;
    return s.el;
  }
  const el = document.createElement("div");
  el.className = "ln-sub";
  el.contentEditable = "false";
  const canvas = document.createElement("canvas");
  const head = document.createElement("div");
  head.className = "ln-sub-head";
  head.hidden = true;
  el.append(canvas, head);
  s = { el, canvas, head, line: i, from: span[0], to: span[1], key, drawn: "" };
  strips.set(key, s);
  byEl.set(el, s);
  visible.observe(el);
  resized.observe(el);
  wire(s);
  return el;
}

/// Forget strips the last render didn't use.
export function prune() {
  for (const [key, s] of strips) {
    if (used.has(key) || s === drag?.strip) continue;
    visible.unobserve(s.el);
    resized.unobserve(s.el);
    strips.delete(key);
  }
  used = new Set();
}

function songLength() {
  return host?.duration() || (env ? env.voice.length / env.rate : 0) || 0;
}

// ---- drawing -----------------------------------------------------------------------------------

const css = (el: Element, name: string) => getComputedStyle(el).getPropertyValue(name).trim();

function draw(s: Strip | undefined, force = false) {
  if (!s || !host || !env || !s.el.isConnected) return;
  const width = s.el.clientWidth;
  const sig = `${s.key}|${width}|${window.devicePixelRatio}`;
  if (!width || (!force && s.drawn === sig)) return;
  s.drawn = sig;
  const dpr = window.devicePixelRatio || 1;
  const { canvas } = s;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${HEIGHT}px`;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(HEIGHT * dpr);
  const g = canvas.getContext("2d")!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const c = {
    fg: css(s.el, "--fg"),
    dim: css(s.el, "--dim"),
    faint: css(s.el, "--faint"),
    accent: css(s.el, "--accent"),
    line: css(s.el, "--accent-line"),
  };
  const lines = host.lines();
  const line = lines[s.line];
  if (!line || line.t === null) return;
  const pps = width / (s.to - s.from);
  const xOf = (t: number) => (t - s.from) * pps;

  // The vocal range's loudness, mirrored about the middle. The loudest moment under each
  // pixel, so a short attack isn't averaged away. Before the line starts it is dimmer.
  const [top, bottom] = WAVE;
  const mid = (top + bottom) / 2;
  const half = (bottom - top) / 2;
  const [lo, hi] = range;
  const levels = env.voice.length ? env.voice : env.levels;
  const startX = xOf(line.t);
  for (let x = 0; x < width; x++) {
    const a = Math.max(0, Math.floor((s.from + x / pps) * env.rate));
    const b = Math.min(levels.length, Math.max(a + 1, Math.floor((s.from + (x + 1) / pps) * env.rate)));
    if (a >= levels.length) break;
    let v = 0;
    for (let k = a; k < b; k++) v = Math.max(v, levels[k]);
    if (v <= lo) continue;
    const h = Math.max(0.5, ((v - lo) / (hi - lo)) * half);
    g.fillStyle = x < startX ? c.faint : c.dim;
    g.globalAlpha = x < startX ? 0.5 : 0.55;
    g.fillRect(x, mid - h, 1, h * 2);
  }
  g.globalAlpha = 1;

  // The beats, as short ticks along the bottom of the waveform.
  g.fillStyle = c.faint;
  for (const b of env.beats) {
    if (b < s.from || b > s.to) continue;
    g.fillRect(Math.round(xOf(b)), bottom - 4, 1, 4);
  }

  // While a word is dragged, the places it would snap to.
  if (drag?.strip === s) {
    g.fillStyle = c.accent;
    g.globalAlpha = 0.6;
    for (const t of env.voiceOnsets) {
      if (t < s.from || t > s.to) continue;
      const x = xOf(t);
      g.beginPath();
      g.moveTo(x - 3, top);
      g.lineTo(x + 3, top);
      g.lineTo(x, top + 4);
      g.fill();
    }
    g.globalAlpha = 1;
  }

  // The words, each a tick where it starts and its text after it. A word with a time of its
  // own is solid; one placed by an even share of its line is dashed.
  const words = wordsOf(line.text);
  const starts = wordStarts(lines, s.line, songLength());
  g.font = "10px Inter, 'Segoe UI', system-ui, sans-serif";
  g.textBaseline = "middle";
  g.textAlign = "left";
  starts.forEach((t, k) => {
    const x = Math.round(xOf(t));
    const next = k + 1 < starts.length ? xOf(starts[k + 1]) : width;
    const own = k === 0 || line.words?.[k] != null;
    g.strokeStyle = own ? c.accent : c.line;
    g.lineWidth = own ? 2 : 1;
    g.setLineDash(own ? [] : [2, 2]);
    g.beginPath();
    g.moveTo(x + 0.5, top);
    g.lineTo(x + 0.5, LABELS[1]);
    g.stroke();
    g.setLineDash([]);
    g.fillStyle = drag?.strip === s && drag.word === k ? c.accent : c.fg;
    g.fillText(fit(g, words[k] ?? "", next - x - 6), x + 4, (LABELS[0] + LABELS[1]) / 2);
  });
}

function fit(g: CanvasRenderingContext2D, text: string, room: number) {
  if (room < 8) return "";
  if (g.measureText(text).width <= room) return text;
  let t = text;
  while (t.length > 1 && g.measureText(`${t}…`).width > room) t = t.slice(0, -1);
  return `${t}…`;
}

/// The playhead, on whichever strip it is in. Moved, not drawn.
let headOn: Strip | null = null;
function tick() {
  if (!host) return;
  frame = requestAnimationFrame(tick);
  const ph = host.playhead();
  let on: Strip | null = null;
  if (host.canSeek() && env) {
    for (const s of strips.values()) {
      if (s.el.isConnected && ph.position >= s.from && ph.position < s.to) {
        // Strips overlap by their lead-in; the later line's own start wins.
        const t = host.lines()[s.line]?.t ?? s.from;
        if (!on || (ph.position >= t && t > (host.lines()[on.line]?.t ?? on.from))) on = s;
      }
    }
  }
  if (headOn && headOn !== on) headOn.head.hidden = true;
  headOn = on;
  if (on) {
    on.head.hidden = false;
    const x = ((ph.position - on.from) / (on.to - on.from)) * on.el.clientWidth;
    on.head.style.transform = `translateX(${Math.round(x)}px)`;
  }
}

// ---- dragging words ------------------------------------------------------------------------

function wire(s: Strip) {
  const { canvas } = s;
  const local = (e: PointerEvent) => e.clientX - canvas.getBoundingClientRect().left;
  const pps = () => canvas.clientWidth / (s.to - s.from);
  const tOf = (x: number) => s.from + x / pps();

  /// The word whose tick is under `x`, or -1.
  const wordAt = (x: number) => {
    if (!host) return -1;
    const starts = wordStarts(host.lines(), s.line, songLength());
    let best = -1;
    let reach = GRAB;
    starts.forEach((t, k) => {
      const d = Math.abs((t - s.from) * pps() - x);
      if (d <= reach) {
        reach = d;
        best = k;
      }
    });
    return best;
  };

  canvas.addEventListener("pointerdown", (e) => {
    if (!host || e.button !== 0) return;
    // The strip sits inside the text being edited; a press on it must not move the caret.
    e.preventDefault();
    const k = wordAt(local(e));
    if (k < 0) {
      // Anywhere else: play from there.
      if (host.canSeek()) host.seek(Math.max(0, tOf(local(e)) - 0.15));
      return;
    }
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      // the pointer is already gone; the press still counts
    }
    drag = { strip: s, word: k, moved: false };
  });

  canvas.addEventListener("pointermove", (e) => {
    if (!host) return;
    const x = local(e);
    if (!drag || drag.strip !== s) {
      canvas.style.cursor = wordAt(x) >= 0 ? "ew-resize" : "pointer";
      return;
    }
    if (!drag.moved) {
      drag.moved = true;
      host.begin(s.line);
    }
    // The strip keeps its span while dragging, so what's under the pointer holds still.
    const t = snap(tOf(x), pps(), e.altKey);
    setWordStart(host.lines(), s.line, drag.word, t, songLength());
    host.changed(s.line, false);
    draw(s, true);
  });

  const release = () => {
    if (!drag || drag.strip !== s) return;
    const moved = drag.moved;
    drag = null;
    if (moved) host?.changed(s.line, true);
    else draw(s, true);
  };
  canvas.addEventListener("pointerup", release);
  canvas.addEventListener("pointercancel", release);
}

/// `t`, pulled onto the nearest place a word could start within reach: where the vocal range
/// gets louder, a heard word's start, or a beat. Words land off the beat as often as on it, so
/// a beat only pulls from half as far.
function snap(t: number, pps: number, free: boolean) {
  if (free || !env) return t;
  let best = t;
  let reach = SNAP / pps;
  const consider = (at: number, weight = 1) => {
    const d = Math.abs(at - t) / weight;
    if (d < reach) {
      reach = d;
      best = at;
    }
  };
  env.voiceOnsets.forEach((at) => consider(at));
  heard.forEach((w) => consider(w.start));
  env.beats.forEach((at) => consider(at, 0.5));
  return best;
}
