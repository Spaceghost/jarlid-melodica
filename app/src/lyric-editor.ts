// Editing lyrics in place, on the lyrics pane itself.
//
// The first version of this was a full page you opened. It was wrong: writing a whole
// lyric set or hand-typing timestamps is rare, and fixing *one line* is what actually
// happens. So the pencil now flips the pane itself into edit mode and every line carries
// its own controls.
//
// Two jobs live here, and they are deliberately not the same mode:
//
//   Correction — the lyrics already have timings and something is wrong. Per-line: fix
//   the words, set this line's start to now, check it by jumping back and listening.
//
//   Timestamp — the lyrics have no timings at all. The song plays and you mark each line
//   as it starts, continuously. Nothing jumps back, because a backward seek re-opens the
//   stream and rebuffers; doing that between every line would make the pass impossible.
//
// While edit mode is on this module owns the pane: it renders the rows and drives its own
// cursor. `highlightLine` in main.ts stands down, because it indexes `.line` nodes
// positionally and assumes ascending timestamps, and neither holds mid-pass.

import { invoke } from "@tauri-apps/api/core";
import * as confirm from "./lyric-confirm";
import * as timeline from "./lyric-timeline";
import * as sublines from "./lyric-sublines";
import { publicationFor } from "./lyric-publish";
import { fillMarked } from "./draft-marks";
import { sectionLabel, withSections } from "./sections";
import {
  applyReview,
  comparePos,
  deleteRange,
  editText,
  insertLines,
  isBlank,
  joinDown,
  joinLine,
  reviewState,
  sliceLines,
  splitLine,
  unreviewed as unreviewedIn,
  fromTiming,
  mergeTiming,
  retext,
  stampStart,
  toTiming,
  wordsOf,
  type Line,
  type Pos,
  type TimedLine,
} from "./edit-lines";

export interface Lyrics {
  synced: string | null;
  plain: string | null;
  source: string;
  /// The LRCLIB record this came from. A correction is a republish keyed on these four
  /// fields, so they have to travel with the lyrics or we'd correct the wrong record.
  id: number | null;
  trackName: string | null;
  artistName: string | null;
  albumName: string | null;
  duration: number | null;
  /// True when this is a local edit rather than what LRCLIB currently serves.
  overridden: boolean;
  /// Set when this is a cached copy old enough to be worth checking again.
  stale?: boolean;
  /// Set when the listener chose this record over the automatic match.
  pinned?: boolean;
  /// Set when `synced` was worked out on this machine from LRCLIB's plain lyrics, because
  /// LRCLIB had no timings (see `autosync` in Rust). Never published unless the listener does.
  auto?: boolean;
  /// Set while these lyrics are a draft the speech engine wrote, for a song LRCLIB has nothing
  /// for, and not every line has been reviewed. Kept in a saved edit until the review is done;
  /// until then it can't be published. Indexed by line, blank lines included.
  draft?: { doubt: number[][]; reviewed: boolean[] } | null;
  /// Why there is no draft for a song LRCLIB has nothing for.
  noDraft?: "noSinging" | "unclear" | null;
  /// What `synced` can't hold: word timings and line ends, line by line (see `lyricsfile` in
  /// Rust). Present when the record or the saved edit has any.
  timing?: TimedLine[] | null;
}

export interface EditorContext {
  /// Pandora's naming for the track. Also the key local edits are filed under.
  meta: { title: string; artist: string; album: string };
  lyrics: Lyrics;
  /// The edited track's length, captured when editing began. The playhead's own duration
  /// can't stand in for it: once playback moves on it is the next song's.
  duration: number | null;
  playhead: () => { position: number; duration: number; paused: boolean };
  transport: (cmd: string) => void;
  seek: (position: number) => void;
  /// False when a network renderer owns playback: timing needs a local playhead.
  canTransport: boolean;
  /// Hand replacement lyrics back to the now-playing screen.
  onApplied: (lyrics: Lyrics) => void;
  /// Leave edit mode and repaint the pane normally.
  onExit: () => void;
}

/// Taps land late — you hear the line, then press. Shifting stamps earlier by about a
/// reaction time is what makes a hand-tapped file feel right rather than consistently
/// behind.
const TAP_LATENCY = 0.33;

/// How far before a line to drop the playhead when checking it. Long enough to hear the
/// run-in, short enough not to sit through the previous line.
const CHECK_LEAD = 2.5;

/// How far "Back" goes during a timing pass: enough to hear the run-in to a line that was
/// marked wrong, without replaying the whole verse.
const REWIND = 5;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const lyricsEl = $("lyrics");
const bar = $("lyric-bar");
const statusEl = $("lyric-bar-status");
const timestampBtn = $<HTMLButtonElement>("lyric-timestamp");
const autoTimeBtn = $<HTMLButtonElement>("lyric-autotime");
const rewindBtn = $<HTMLButtonElement>("lyric-rewind");
const autoCheckWrap = $("lyric-autocheck-wrap");
const autoCheckBox = $<HTMLInputElement>("lyric-autocheck");
const saveBtn = $<HTMLButtonElement>("lyric-save");
const revertBtn = $<HTMLButtonElement>("lyric-revert");
const publishBtn = $<HTMLButtonElement>("lyric-publish");
const flagBtn = $<HTMLButtonElement>("lyric-flag");
const doneBtn = $<HTMLButtonElement>("lyric-done");
const timelineBtn = $<HTMLButtonElement>("lyric-timeline-btn");
const bpmEl = $("lyric-bpm");

let ctx: EditorContext | null = null;
let lines: Line[] = [];
let editing = false;
/// The lyrics are a draft (see `Lyrics.draft`): every line carries a ✓ to check it off, and
/// Publish waits until all of them are.
let reviewing = false;
/// The line selected in the list and on the timeline, or -1.
let selected = -1;
/// The line the next mark lands on, during a timestamp pass.
let cursor = 0;
let stamping = false;
let dirty = false;
let busy = false;
let stale = false;

export const isEditing = () => editing;

// ---- LRC text <-> lines ---------------------------------------------------

const STAMP = /^\s*\[(\d+):(\d+(?:[.:]\d+)?)\]\s?/;

function parseLines(text: string): Line[] {
  return text.split(/\r?\n/).map((raw) => {
    const m = STAMP.exec(raw);
    if (!m) return { t: null, text: raw.trim() };
    return {
      t: parseInt(m[1], 10) * 60 + parseFloat(m[2].replace(":", ".")),
      text: raw.slice(m[0].length).trim(),
    };
  });
}

function stampOf(t: number) {
  const m = Math.floor(t / 60);
  return `${String(m).padStart(2, "0")}:${(t - m * 60).toFixed(2).padStart(5, "0")}`;
}

const serialize = (ls: Line[]) =>
  ls.map((l) => (l.t === null ? l.text : `[${stampOf(l.t)}] ${l.text}`)).join("\n");

const anyTimed = () => lines.some((l) => l.t !== null);

/// A section label ("Chorus:", "[Verse 2]") is never sung, so it never gets a time.
const isLabel = (l: Line) => !!sectionLabel(l.text);

/// The first line at or after `from` that a timing pass should land on, or -1.
const nextLyric = (from: number) => {
  for (let i = Math.max(0, from); i < lines.length; i++)
    if (!isBlank(lines[i]) && !isLabel(lines[i])) return i;
  return -1;
};

// ---- entering / leaving ---------------------------------------------------

export function begin(context: EditorContext) {
  ctx = context;
  editing = true;
  dirty = false;
  stale = false;
  busy = false;
  stamping = false;
  cursor = 0;

  load(context.lyrics);

  lyricsEl.classList.add("editing");
  setEditable(true);
  bar.hidden = false;
  render();
  refreshBar();
  if (reviewing) {
    setStatus(
      "A draft the speech engine wrote. Listen along, fix what's wrong, and ✓ each line once it's right. Underlined words are the ones it wasn't sure of."
    );
  }
  followTimer = window.setInterval(followPlayhead, 250);
  selected = -1;
  openSublines();
  if (localStorage.getItem(TIMELINE_KEY) === "open") openTimeline();
}

/// Take `l` as the lines to edit, with a draft's review state when it is one.
function load(l: Lyrics) {
  const src = l.synced || l.plain || "";
  // The LRC says which lines there are; a Lyricsfile's timing adds their words' times and
  // line ends. With no LRC at all, the timing is all there is.
  if (src) {
    lines = l.timing?.length ? mergeTiming(parseLines(src), l.timing) : parseLines(src);
  } else {
    lines = l.timing?.length ? fromTiming(l.timing) : [{ t: null, text: "" }];
  }
  const draft = l.draft;
  reviewing = !!draft;
  if (draft) applyReview(lines, draft);
  resetHistory();
}

export function end() {
  editing = false;
  stamping = false;
  window.clearInterval(followTimer);
  timeline.close();
  sublines.close();
  bpmEl.hidden = true;
  nowRow = -1;
  lyricsEl.classList.remove("editing", "stamping");
  setEditable(false);
  bar.hidden = true;
  confirm.cancel();
  ctx?.onExit();
  ctx = null;
}

doneBtn.addEventListener("click", () => {
  // Leaving with unsaved work should be possible, but not by accident — a timing pass is
  // several minutes of tapping and a stray click on Done should not bin it silently.
  if (dirty) {
    showConfirm({
      title: "Leave without saving?",
      message: "The changes on screen have not been saved, and closing the editor drops them.",
      go: "Discard",
      run: async () => {
        dirty = false;
        end();
      },
    });
    return;
  }
  end();
});

/// Playback moved to another track. The words still belong to the track being edited and
/// still save to it, but the playhead does not, so marking would write another song's
/// times into this one.
export function notePlaybackMoved() {
  if (!editing || stale) return;
  stale = true;
  stamping = false;
  lyricsEl.classList.remove("stamping");
  setEditable(true);
  refreshBar();
  render();
  setStatus(
    `Playback moved on. Words still save to ${ctx?.meta.artist} — ${ctx?.meta.title}, but timing needs this track playing.`,
    "err"
  );
}

// ---- rendering ------------------------------------------------------------

/// The whole list is one editing host, so a caret moves and a selection runs across lines the
/// way they do in any text editor. Each row's controls are islands in it that can't be edited
/// or selected. Typing never changes the page directly: every edit is made to `lines` and the
/// rows are drawn again (see "editing as text" below). A timing pass isn't editing: Space
/// marks lines then, so the list takes no typing.
function setEditable(on: boolean) {
  if (on) {
    lyricsEl.contentEditable = "true";
    lyricsEl.spellcheck = false;
    lyricsEl.setAttribute("role", "textbox");
    lyricsEl.setAttribute("aria-multiline", "true");
    lyricsEl.setAttribute("aria-label", "Lyrics");
  } else {
    lyricsEl.removeAttribute("contenteditable");
    lyricsEl.removeAttribute("role");
    lyricsEl.removeAttribute("aria-multiline");
    lyricsEl.removeAttribute("aria-label");
  }
}

/// Draw every row again, keeping the scroll position and, if the list has focus, the selection.
function render() {
  const keep = lyricsEl === document.activeElement ? modelSelection() : null;
  const top = lyricsEl.scrollTop;
  lyricsEl.replaceChildren(...lines.map(rowFor));
  sublines.prune();
  lyricsEl.scrollTop = top;
  if (keep && !stamping) setSelection(clampPos(keep.anchor), clampPos(keep.focus));
}

/// Rows keep `.line` and `data-idx` so the pane's own styling still applies; the extra
/// children are what edit mode adds.
function rowFor(line: Line, i: number) {
  const row = document.createElement("div");
  row.className = "line editable";
  row.dataset.idx = String(i);
  if (stamping && i === cursor) row.classList.add("cursor");
  if (isBlank(line)) row.classList.add("blank");
  if (isLabel(line)) row.classList.add("section");
  if (line.t !== null) row.classList.add("timed");
  if (i === nowRow) row.classList.add("now");
  if (i === selected) row.classList.add("selected");
  if (reviewing) row.classList.add("draft");

  const time = control("button", "ln-time");
  time.textContent = line.t === null ? "––:––" : stampOf(line.t);
  time.addEventListener("click", () => (stamping ? markAt(i) : setNow(i)));

  const text = document.createElement("div");
  text.className = "ln-text";
  fillMarked(text, line.text, line.doubt ?? []);
  // An empty line needs something in it to hold a caret.
  if (!line.text) text.append(document.createElement("br"));

  const check = control("button", "ln-check");
  check.textContent = "▶";
  check.disabled = line.t === null || !ctx?.canTransport || stale;
  check.addEventListener("click", () => checkLine(i));

  row.append(time, text, check);
  if (reviewing) row.append(reviewButton(line, i, row));
  // Its stretch of the song under the words, once the waveform is in (lyric-sublines.ts).
  const sub = sublines.stripFor(i);
  if (sub) row.append(sub);
  return row;
}

/// A row control: inside the editing host, but not part of the text.
function control<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string) {
  const el = document.createElement(tag);
  el.className = cls;
  el.contentEditable = "false";
  return el;
}

/// A draft line's ✓: pressed once the line's words and start are right. A line in timed
/// lyrics needs a start before it can be checked, or it would vanish from the synced copy.
function reviewButton(line: Line, i: number, row: HTMLElement) {
  const ok = control("button", "ln-ok");
  ok.textContent = "✓";
  if (isBlank(line)) {
    ok.disabled = true;
    ok.style.visibility = "hidden";
    return ok;
  }
  const paint = () => {
    row.classList.toggle("reviewed", !!lines[i].ok);
    ok.setAttribute("aria-pressed", String(!!lines[i].ok));
    ok.setAttribute("aria-label", lines[i].ok ? "Reviewed — undo" : "Mark this line reviewed");
  };
  ok.disabled = line.t === null && anyTimed();
  ok.addEventListener("click", () => {
    lines[i].ok = !lines[i].ok;
    paint();
    markDirty();
  });
  paint();
  return ok;
}

// ---- the waveform under each line ------------------------------------------------
// Each timed row carries its stretch of the song's vocals, its words placed on it
// (lyric-sublines.ts). A word dragged there is retimed: one undo step per drag, and the rows
// are only rebuilt once it's let go, so the strip being dragged stays put.

function openSublines() {
  bpmEl.hidden = true;
  sublines.open({
    meta: () => ctx!.meta,
    lines: () => lines,
    playhead: () => ctx!.playhead(),
    duration: () => trackDuration(),
    canSeek: () => !!ctx?.canTransport && !stale,
    seek: (t) => ctx?.seek(t),
    begin: () => recordEdit("retime"),
    changed: (i, done) => {
      markDirty();
      if (done) {
        render();
        settleHistory();
        return;
      }
      const t = lines[i].t;
      const time = lyricsEl.querySelector(`.line[data-idx="${i}"] .ln-time`);
      if (time && t !== null) time.textContent = stampOf(t);
    },
    loaded: (bpm, problem) => {
      if (!editing) return;
      if (bpm) {
        bpmEl.textContent = `${Math.round(bpm)} BPM`;
        bpmEl.hidden = false;
      }
      if (problem) setStatus(problem, "err");
      render();
    },
  });
}

// ---- the timeline -----------------------------------------------------------
// The song's waveform with the lines laid on it (lyric-timeline.ts). Its edits go straight
// into `lines`; the list is repainted to match.

const TIMELINE_KEY = "lyrics.timeline";

function openTimeline() {
  timelineBtn.classList.add("on");
  timelineBtn.setAttribute("aria-pressed", "true");
  timeline.open({
    meta: () => ctx!.meta,
    lines: () => lines,
    selected: () => selected,
    select: (i) => selectLine(i, true),
    changed: () => {
      markDirty();
      render();
    },
    playhead: () => ctx!.playhead(),
    duration: () => trackDuration(),
    canSeek: () => !!ctx?.canTransport && !stale,
    seek: (t) => ctx?.seek(t),
  });
}

timelineBtn.addEventListener("click", () => {
  if (timeline.isOpen()) {
    timeline.close();
    timelineBtn.classList.remove("on");
    timelineBtn.setAttribute("aria-pressed", "false");
    localStorage.setItem(TIMELINE_KEY, "closed");
  } else {
    openTimeline();
    localStorage.setItem(TIMELINE_KEY, "open");
  }
});

/// Select line `i` in the list and on the timeline. From the timeline, the list scrolls to the
/// row; from the list, the timeline scrolls to the block.
function selectLine(i: number, fromTimeline: boolean) {
  if (i === selected) return;
  lyricsEl.querySelector(`.line[data-idx="${selected}"]`)?.classList.remove("selected");
  selected = i;
  const row = lyricsEl.querySelector<HTMLElement>(`.line[data-idx="${i}"]`);
  row?.classList.add("selected");
  if (fromTimeline) row?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  else timeline.reveal(i);
}

// ---- following the song ----------------------------------------------------
// Reviewing is reading along: the row now playing is marked, and kept in view unless the
// reviewer is busy in a line. A timing pass has its own cursor and needs none of this.

let followTimer = 0;
/// The row marked as playing, or -1.
let nowRow = -1;

function followPlayhead() {
  if (!editing || !ctx) return;
  let at = -1;
  // Once playback has moved to another song, its playhead says nothing about these lines.
  if (!stamping && !stale) {
    const position = ctx.playhead().position;
    // Mid-edit, times needn't be in order: the latest start already passed wins.
    let best = -Infinity;
    lines.forEach((l, i) => {
      if (l.t !== null && !isBlank(l) && l.t <= position && l.t >= best) {
        best = l.t;
        at = i;
      }
    });
  }
  if (at === nowRow) return;
  lyricsEl.querySelector(`.line[data-idx="${nowRow}"]`)?.classList.remove("now");
  nowRow = at;
  const row = lyricsEl.querySelector<HTMLElement>(`.line[data-idx="${at}"]`);
  row?.classList.add("now");
  const typing = (document.activeElement as HTMLElement | null)?.isContentEditable;
  if (row && reviewing && !typing) row.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

// ---- editing as text ------------------------------------------------------
// The list is one text: lines joined by line breaks. The browser moves the caret and draws
// the selection; every change it would make is cancelled in `beforeinput` and made to `lines`
// instead (edit-lines.ts), so starts, word times and review state follow the words. Enter
// splits a line, Backspace at the start of a line joins it to the one above, and Delete at the
// end joins the next one up. Adding and removing lines has to work without a separate editor,
// or "no lyrics found" is a dead end, and a draft's lines are often broken in the wrong place.

const CLIP_TYPE = "application/x-jarlid-lines";

const textElOf = (i: number) =>
  lyricsEl.querySelector<HTMLElement>(`.line[data-idx="${i}"] .ln-text`);

/// The model position of a DOM point in the list, or null outside it. A point on a row's
/// controls, or between rows, lands at the near end of that row's words.
function posOf(node: Node, offset: number): Pos | null {
  if (!lines.length || !lyricsEl.contains(node)) return null;
  const end = (i: number): Pos => ({ line: i, off: lines[i].text.length });
  if (node === lyricsEl) {
    const row = lyricsEl.children[offset] as HTMLElement | undefined;
    return row ? { line: Number(row.dataset.idx), off: 0 } : end(lines.length - 1);
  }
  const el = node instanceof Element ? node : node.parentElement;
  const row = el?.closest<HTMLElement>(".line");
  if (!row) return null;
  const i = Number(row.dataset.idx);
  if (!(i in lines)) return null;
  const text = row.querySelector<HTMLElement>(".ln-text")!;
  if (text.contains(node)) {
    const r = document.createRange();
    r.selectNodeContents(text);
    r.setEnd(node, offset);
    return { line: i, off: Math.min(r.toString().length, lines[i].text.length) };
  }
  const before =
    node === row
      ? offset <= Array.prototype.indexOf.call(row.childNodes, text)
      : !!(text.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_PRECEDING);
  return before ? { line: i, off: 0 } : end(i);
}

interface Selected {
  anchor: Pos;
  focus: Pos;
  from: Pos;
  to: Pos;
  collapsed: boolean;
}

function modelSelection(): Selected | null {
  const sel = getSelection();
  if (!sel?.rangeCount || !sel.anchorNode || !sel.focusNode) return null;
  const anchor = posOf(sel.anchorNode, sel.anchorOffset);
  const focus = posOf(sel.focusNode, sel.focusOffset);
  if (!anchor || !focus) return null;
  const [from, to] = comparePos(anchor, focus) <= 0 ? [anchor, focus] : [focus, anchor];
  return { anchor, focus, from, to, collapsed: comparePos(from, to) === 0 };
}

const clampPos = (p: Pos): Pos => {
  const line = Math.min(Math.max(0, p.line), lines.length - 1);
  return { line, off: Math.min(p.off, lines[line].text.length) };
};

/// The DOM point for a model position.
function domPoint(p: Pos): [Node, number] {
  const el = textElOf(p.line)!;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let left = p.off;
  let lastNode: Node | null = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const len = node.textContent?.length ?? 0;
    if (left <= len) return [node, left];
    left -= len;
    lastNode = node;
  }
  return lastNode ? [lastNode, lastNode.textContent?.length ?? 0] : [el, 0];
}

function setSelection(anchor: Pos, focus: Pos = anchor) {
  if (!lines.length || !textElOf(anchor.line) || !textElOf(focus.line)) return;
  if (document.activeElement !== lyricsEl) lyricsEl.focus({ preventScroll: true });
  const [an, ao] = domPoint(anchor);
  const [fn, fo] = domPoint(focus);
  getSelection()?.setBaseAndExtent(an, ao, fn, fo);
}

/// Make an edit to `lines`: `run` changes them and returns where the caret goes. The stamping
/// cursor and the selected line follow their lines, wherever the edit moved them.
function edit(kind: string, run: () => Pos) {
  recordEdit(kind);
  const cursorLine = lines[cursor];
  const selectedLine = lines[selected];
  const caret = run();
  if (!lines.length) lines.push({ t: null, text: "" });
  const c = lines.indexOf(cursorLine);
  cursor = c >= 0 ? c : Math.min(cursor, lines.length - 1);
  const s = lines.indexOf(selectedLine);
  selected = s >= 0 ? s : -1;
  markDirty();
  render();
  const at = clampPos(caret);
  setSelection(at);
  lyricsEl
    .querySelector(`.line[data-idx="${at.line}"]`)
    ?.scrollIntoView({ block: "nearest", behavior: "auto" });
  settleHistory();
}

/// Delete what is selected, if anything; the caret is where it was.
function clearSelection(s: Selected): Pos {
  return s.collapsed ? s.from : deleteRange(lines, s.from, s.to, reviewing);
}

lyricsEl.addEventListener("beforeinput", (e) => {
  if (!editing) return;
  // An input method's text can't be cancelled; it is read back on `input`.
  if (e.inputType === "insertCompositionText") return;
  e.preventDefault();
  const s = modelSelection();
  if (!s) return;
  const type = e.inputType;
  if (type === "historyUndo") return undo();
  if (type === "historyRedo") return redo();

  if (type === "insertText" || type === "insertReplacementText") {
    let data = e.data ?? e.dataTransfer?.getData("text/plain") ?? "";
    data = data.replace(/\r\n?/g, "\n");
    // A spelling fix names the words it replaces, not the selection.
    const target = e.getTargetRanges()[0];
    const range =
      type === "insertReplacementText" && target
        ? rangeOf(target) ?? { from: s.from, to: s.to }
        : { from: s.from, to: s.to };
    if (data.includes("\n")) return pasteFragments({ ...s, ...range }, fragmentsOfText(data));
    edit(data === " " ? "space" : "type", () => {
      const at = comparePos(range.from, range.to)
        ? deleteRange(lines, range.from, range.to, reviewing)
        : range.from;
      editText(lines[at.line], at.off, at.off, data);
      return { line: at.line, off: at.off + data.length };
    });
    return;
  }

  if (type === "insertParagraph" || type === "insertLineBreak") {
    edit("break", () => {
      const at = clearSelection(s);
      splitLine(lines, at.line, lines[at.line].text, at.off, reviewing);
      return { line: at.line + 1, off: 0 };
    });
    return;
  }

  if (type.startsWith("delete") && type !== "deleteByCut" && type !== "deleteByDrag") {
    if (!s.collapsed) return edit("delete", () => clearSelection(s));
    const backward = type.includes("Backward");
    const { line: i, off } = s.from;
    const L = lines[i];
    if (backward && off === 0) {
      if (i === 0) return;
      edit("join", () => {
        if (!L.text) {
          lines.splice(i, 1);
          return { line: i - 1, off: lines[i - 1].text.length };
        }
        return { line: i - 1, off: joinLine(lines, i, L.text, reviewing) };
      });
      return;
    }
    if (!backward && off >= L.text.length) {
      if (i === lines.length - 1) return;
      edit("join", () => joinDown(lines, i, reviewing));
      return;
    }
    // Within the line: what the key would delete (a character, a word, to the line's end),
    // as the browser works it out, but never past this line.
    const target = e.getTargetRanges()[0];
    const r = target ? rangeOf(target) : null;
    let a = r ? (r.from.line < i ? 0 : r.from.line > i ? L.text.length : r.from.off) : off;
    let b = r ? (r.to.line > i ? L.text.length : r.to.line < i ? 0 : r.to.off) : off;
    if (a === b) {
      // No range offered: one character, whole if it is a surrogate pair.
      if (backward) a = off - (/[\uDC00-\uDFFF]/.test(L.text[off - 1]) && off > 1 ? 2 : 1);
      else b = off + (/[\uD800-\uDBFF]/.test(L.text[off]) ? 2 : 1);
    }
    edit(backward ? "backspace" : "delete", () => {
      editText(L, a, b, "");
      return { line: i, off: a };
    });
  }
  // Anything else (formatting, drag and drop) changes nothing.
});

function rangeOf(r: StaticRange): { from: Pos; to: Pos } | null {
  const a = posOf(r.startContainer, r.startOffset);
  const b = posOf(r.endContainer, r.endOffset);
  if (!a || !b) return null;
  return comparePos(a, b) <= 0 ? { from: a, to: b } : { from: b, to: a };
}

// An input method writes into the page itself. Whatever it changed is read back into the
// lines; a change the rows can't hold any more is redrawn from them.
let composing = false;
lyricsEl.addEventListener("compositionstart", () => {
  if (!editing) return;
  composing = true;
  recordEdit("compose");
});
lyricsEl.addEventListener("compositionend", () => {
  composing = false;
  if (editing) syncFromPage();
});
lyricsEl.addEventListener("input", () => {
  if (editing && !composing) syncFromPage();
});

function syncFromPage() {
  const rows = [...lyricsEl.querySelectorAll<HTMLElement>(":scope > .line")];
  let changed = false;
  rows.forEach((row) => {
    const i = Number(row.dataset.idx);
    const text = row.querySelector(".ln-text")?.textContent ?? "";
    if (i in lines && text !== lines[i].text) {
      retext(lines[i], text);
      changed = true;
    }
  });
  if (changed) markDirty();
  const tidy =
    rows.length === lyricsEl.childNodes.length &&
    rows.length === lines.length &&
    rows.every((r) => r.querySelector(".ln-text"));
  if (!composing && (changed || !tidy)) {
    const keep = modelSelection();
    render();
    if (keep) setSelection(clampPos(keep.anchor), clampPos(keep.focus));
  }
  settleHistory();
}

// ---- the clipboard ---------------------------------------------------------
// A copy carries the lines twice: as text, for anywhere else, and with their starts and word
// times under a type of its own, so cutting lines and pasting them elsewhere moves them with
// their timing. Pasted LRC text keeps its timestamps too.

function writeClipboard(data: DataTransfer, frags: Line[]) {
  data.setData("text/plain", frags.map((l) => l.text).join("\n"));
  data.setData(
    CLIP_TYPE,
    JSON.stringify(frags.map(({ t, text, words }) => ({ t, text, ...(words ? { words } : {}) })))
  );
}

lyricsEl.addEventListener("copy", (e) => {
  const s = editing ? modelSelection() : null;
  if (!s || s.collapsed || !e.clipboardData) return;
  e.preventDefault();
  writeClipboard(e.clipboardData, sliceLines(lines, s.from, s.to));
});

lyricsEl.addEventListener("cut", (e) => {
  const s = editing ? modelSelection() : null;
  if (!s || !e.clipboardData) return;
  e.preventDefault();
  if (s.collapsed) return;
  writeClipboard(e.clipboardData, sliceLines(lines, s.from, s.to));
  edit("cut", () => clearSelection(s));
});

lyricsEl.addEventListener("paste", (e) => {
  if (!editing) return;
  e.preventDefault();
  const s = modelSelection();
  const data = e.clipboardData;
  if (!s || !data) return;
  const frags = fragmentsOfClip(data.getData(CLIP_TYPE)) ?? fragmentsOfText(data.getData("text/plain"));
  if (frags.length) pasteFragments(s, frags);
});

// Dragging text around would let the browser move it behind the model's back.
lyricsEl.addEventListener("dragstart", (e) => editing && e.preventDefault());
lyricsEl.addEventListener("drop", (e) => editing && e.preventDefault());

function pasteFragments(s: { from: Pos; to: Pos }, frags: Line[]) {
  edit("paste", () => {
    const at = comparePos(s.from, s.to) ? deleteRange(lines, s.from, s.to, reviewing) : s.from;
    return insertLines(lines, at, frags, reviewing);
  });
}

function fragmentsOfClip(json: string): Line[] | null {
  if (!json) return null;
  try {
    const raw = JSON.parse(json);
    if (!Array.isArray(raw) || !raw.length) return null;
    return raw.map((l): Line => {
      const t = typeof l?.t === "number" ? l.t : null;
      const words = Array.isArray(l?.words)
        ? l.words.map((w: unknown) => (typeof w === "number" ? w : null))
        : undefined;
      return { t, text: String(l?.text ?? ""), ...(words ? { words } : {}) };
    });
  } catch {
    return null;
  }
}

/// Plain text as lines. One line pastes as it is; several are read as LRC, so a pasted song
/// keeps any timestamps it has.
function fragmentsOfText(text: string): Line[] {
  text = text.replace(/\r\n?/g, "\n");
  if (!text) return [];
  if (!text.includes("\n")) {
    const m = STAMP.exec(text);
    return [m ? parseLines(text)[0] : { t: null, text }];
  }
  return parseLines(text);
}

// ---- undo -------------------------------------------------------------------
// Edits are cancelled before the browser makes them, so its own undo has nothing to undo:
// the editor keeps a history of the lines. Typing runs together into one step, broken at
// spaces and pauses. A change made some other way — a timing, a drag on the timeline — is a
// step of its own, found the next time the history is touched.

interface Snapshot {
  lines: Line[];
  caret: Pos | null;
}

let undoStack: Snapshot[] = [];
let redoStack: Snapshot[] = [];
let settled: Snapshot = { lines: [], caret: null };
let settledJson = "";
let lastKind = "";
let lastAt = 0;

const snapshot = (): Snapshot => ({
  lines: structuredClone(lines),
  caret: modelSelection()?.focus ?? null,
});

function resetHistory() {
  undoStack = [];
  redoStack = [];
  lastKind = "";
  settleHistory();
}

function settleHistory() {
  settled = snapshot();
  settledJson = JSON.stringify(lines);
}

/// Whether the lines changed since the history last saw them, other than by its own edits.
const changedOutside = () => JSON.stringify(lines) !== settledJson;

function recordEdit(kind: string) {
  const outside = changedOutside();
  if (outside) undoStack.push(settled);
  const now = Date.now();
  // A space ends a run of typing, and starts the next, so undo goes back a word at a time.
  const runOn =
    !outside &&
    (kind === "type" || kind === "backspace" || kind === "delete") &&
    kind === lastKind &&
    now - lastAt < 1500;
  if (!runOn) undoStack.push(snapshot());
  if (undoStack.length > 500) undoStack.shift();
  redoStack = [];
  lastKind = kind === "space" ? "type" : kind;
  lastAt = now;
}

function restore(to: Snapshot) {
  lines = structuredClone(to.lines);
  if (!lines.length) lines.push({ t: null, text: "" });
  cursor = Math.min(cursor, lines.length - 1);
  if (selected >= lines.length) selected = -1;
  lastKind = "";
  markDirty();
  render();
  if (to.caret) setSelection(clampPos(to.caret));
  settleHistory();
}

function undo() {
  if (changedOutside()) {
    undoStack.push(settled);
    redoStack = [];
  }
  const prev = undoStack.pop();
  if (!prev) return;
  redoStack.push(snapshot());
  restore(prev);
}

function redo() {
  if (changedOutside()) redoStack = [];
  const next = redoStack.pop();
  if (!next) return;
  undoStack.push(snapshot());
  restore(next);
}

lyricsEl.addEventListener("keydown", (e) => {
  if (!editing || !(e.ctrlKey || e.metaKey) || e.altKey) return;
  const key = e.key.toLowerCase();
  if (key === "z" && !e.shiftKey) {
    e.preventDefault();
    undo();
  } else if ((key === "z" && e.shiftKey) || key === "y") {
    e.preventDefault();
    redo();
  }
});

// The line the caret is in is the line selected on the timeline.
document.addEventListener("selectionchange", () => {
  if (!editing || document.activeElement !== lyricsEl) return;
  const s = modelSelection();
  if (s) selectLine(s.focus.line, false);
});

function markDirty() {
  dirty = true;
  refreshBar();
}

// ---- timing ---------------------------------------------------------------

/// Set one line's start to the current playhead. The correction case: you noticed a
/// single line is out, so you fix that line.
function setNow(i: number) {
  if (!ctx || stale || !ctx.canTransport) return;
  stampStart(lines[i], Math.max(0, ctx.playhead().position - TAP_LATENCY));
  markDirty();
  render();
  if (autoCheckBox.checked) checkLine(i);
}

/// Mark during a continuous pass: stamp the cursor line and move on. Deliberately does
/// not seek, verify, or re-render anything but the rows — the song is still playing and
/// the next line is seconds away.
function markAt(i: number) {
  if (!ctx || stale || isBlank(lines[i])) return;
  stampStart(lines[i], Math.max(0, ctx.playhead().position - TAP_LATENCY));
  dirty = true;
  dropMisplacedGaps(i);
  const next = nextLyric(i + 1);
  if (next < 0) {
    // Last line with words: a gap after it (the outro) has to start after it, too.
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j].t;
      if (t !== null && t < lines[i].t!) lines[j].t = null;
    }
    stopStamping();
    return;
  }
  cursor = next;
  render();
  showCursor();
}

/// A timed blank line clears the display through an instrumental gap, which is worth
/// keeping, but only while it still falls between the lines around it. Retiming those
/// lines moves the gap's real position; a stamp left behind would sort into the middle of
/// a verse and blank it. So once line `i` is marked, a blank line between it and the
/// lyric before it keeps its time only if it still sits between theirs.
function dropMisplacedGaps(i: number) {
  let prev = i - 1;
  while (prev >= 0 && isBlank(lines[prev])) prev--;
  const lo = prev >= 0 ? (lines[prev].t ?? -Infinity) : -Infinity;
  const hi = lines[i].t!;
  for (let j = prev + 1; j < i; j++) {
    const t = lines[j].t;
    if (t !== null && (t < lo || t > hi)) lines[j].t = null;
  }
}

/// Centre the cursor row, so the next click lands where the last one did. Instant, not
/// smooth: during a pass the cursor moves every few seconds and a smooth scroll would
/// still be gliding when the next line needs marking.
function showCursor() {
  lyricsEl
    .querySelector(`.line[data-idx="${cursor}"]`)
    ?.scrollIntoView({ block: "center", behavior: "auto" });
}

/// A mark that landed wrong is fixed by going back a few seconds and marking again, not
/// by sitting through the whole song. During a pass the cursor steps back with the playhead
/// to the first line marked after the new position, so the next press redoes it. Outside
/// one it is just a few seconds back, to hear a line again.
function rewind() {
  if (!ctx || stale || !ctx.canTransport) return;
  const to = Math.max(0, ctx.playhead().position - REWIND);
  ctx.seek(to);
  if (!stamping) {
    setStatus(`Back to ${stampOf(to)}.`);
    return;
  }
  const redo = lines.findIndex((l, i) => i < cursor && !isBlank(l) && l.t !== null && l.t > to);
  if (redo >= 0) cursor = redo;
  render();
  showCursor();
  setStatus(
    redo >= 0
      ? `Back to ${stampOf(to)}. Mark line ${cursor + 1} again when it starts.`
      : `Back to ${stampOf(to)}.`
  );
}

rewindBtn.addEventListener("click", rewind);

// ---- timing by ear --------------------------------------------------------

/// One line as `autosync_retime` gives it back (`autosync/retime.rs`).
interface RetimedLine {
  t: number | null;
  how: "hint" | "moved" | "heard" | "placed" | "none";
  words: number[] | null;
}
interface Retimed {
  lines: RetimedLine[];
  offset: number;
  coverage: number;
  sharpened: number | null;
  unsharpenedWhy: string | null;
}

/// Time every line and word from what the speech engine heard. The times already set are
/// strong hints: kept where the singing roughly agrees, moved where it clearly doesn't. The
/// result is an ordinary edit: undo takes it back, and nothing is saved until Save.
async function autoTime() {
  if (busy || stamping || !ctx) return;
  const before = JSON.stringify(lines);
  setBusy(true);
  setStatus("Timing every line and word from what the speech engine heard…");
  try {
    const r = await invoke<Retimed>("autosync_retime", {
      ...keyArgs(),
      duration: trackDuration(),
      lines: lines.map((l) => ({ text: l.text, t: l.t })),
    });
    if (!ctx || !editing) return;
    if (JSON.stringify(lines) !== before || r.lines.length !== lines.length) {
      setStatus("The lyrics changed while they were being timed. Try again.", "err");
      return;
    }
    recordEdit("autotime");
    lines.forEach((line, i) => {
      const got = r.lines[i];
      // To the hundredth, as the LRC holds it, so the timing lines up with its stamps exactly.
      line.t = got.t === null ? null : Math.round(got.t * 100) / 100;
      if (got.words && got.words.length === wordsOf(line.text).length) line.words = got.words;
      else delete line.words;
    });
    markDirty();
    render();
    settleHistory();
    const count = (how: RetimedLine["how"]) => r.lines.filter((l) => l.how === how).length;
    const moved = r.lines.flatMap((l, i) => (l.how === "moved" ? [i + 1] : []));
    const parts = [
      `Timed ${count("heard")} lines by ear`,
      count("placed") ? `${count("placed")} between their neighbours` : "",
      `kept ${count("hint")} of your times`,
      moved.length
        ? `moved ${moved.length} the singing put elsewhere (line ${moved.join(", ")})`
        : "",
    ].filter(Boolean);
    const words =
      r.sharpened !== null
        ? `Words sharpened by the aligner on ${r.sharpened} lines.`
        : `Words from the speech engine only (${r.unsharpenedWhy}).`;
    setStatus(`${parts.join(", ")}. ${words} Check it, then save.`, "ok");
  } catch (e) {
    setStatus(String(e), "err");
  } finally {
    setBusy(false);
  }
}

autoTimeBtn.addEventListener("click", () => void autoTime());

function checkLine(i: number) {
  const t = lines[i].t;
  if (t === null || !ctx || !ctx.canTransport || stale) return;
  ctx.seek(Math.max(0, t - CHECK_LEAD));
  setStatus(`Playing from ${stampOf(Math.max(0, t - CHECK_LEAD))} to check line ${i + 1}.`);
}

function startStamping() {
  if (!ctx || stale || !ctx.canTransport) return;
  stamping = true;
  // Resume where there is work rather than restamping good lines from the top.
  cursor = lines.findIndex((l) => l.t === null && !isBlank(l) && !isLabel(l));
  if (cursor < 0) cursor = nextLyric(0);
  if (cursor < 0) {
    stamping = false;
    setStatus("There are no lines to time yet.", "err");
    return;
  }
  lyricsEl.style.setProperty("--stamp-pad", `${Math.round(lyricsEl.clientHeight / 2)}px`);
  lyricsEl.classList.add("stamping");
  setEditable(false);
  render();
  refreshBar();
  showCursor();
  setStatus(`Space or click a line's time as each line starts. ← goes back ${REWIND}s. Esc stops.`);
  if (ctx.playhead().paused) ctx.transport("play");
}

function stopStamping() {
  stamping = false;
  lyricsEl.classList.remove("stamping");
  setEditable(true);
  render();
  refreshBar();
  // The pass's extra padding just went, so the list moved under the reader. Bring back
  // the line the pass ended on.
  lyricsEl
    .querySelector(`.line[data-idx="${cursor}"]`)
    ?.scrollIntoView({ block: "nearest", behavior: "auto" });
  setStatus(dirty ? "Timing pass done — save it." : "");
}

timestampBtn.addEventListener("click", () => (stamping ? stopStamping() : startStamping()));

// Space marks during a pass. It must not fire while a line's text has focus, or typing a
// space would stamp instead of typing.
window.addEventListener("keydown", (e) => {
  if (!editing) return;
  // An open confirmation takes Escape for itself (see lyric-confirm.ts).
  if (e.key === "Escape") {
    if (stamping) stopStamping();
    return;
  }
  const el = e.target as HTMLElement;
  if (el.isContentEditable || el.tagName === "INPUT") return;
  if (stamping && e.key === " ") {
    e.preventDefault();
    markAt(cursor);
  } else if (stamping && e.key === "ArrowLeft") {
    e.preventDefault();
    rewind();
  }
});

// ---- the action bar -------------------------------------------------------

function setStatus(text: string, kind?: "ok" | "err") {
  statusEl.textContent = text;
  statusEl.classList.toggle("ok", kind === "ok");
  statusEl.classList.toggle("err", kind === "err");
}

function refreshBar() {
  const timed = anyTimed();
  timestampBtn.textContent = stamping ? "Stop timing" : timed ? "Retime all…" : "Add timings…";
  // The bar keeps the same buttons in the same places whatever is going on, so nothing moves
  // under the pointer; one that can't act right now is disabled, not hidden.
  timestampBtn.disabled = busy || stale || !ctx?.canTransport;
  rewindBtn.disabled = busy || stale || !ctx?.canTransport;
  autoTimeBtn.disabled = busy || stamping;
  // Checking a line is only meaningful once something has a time, and auto-checking would
  // wreck a continuous pass.
  autoCheckBox.disabled = stamping || !timed;
  autoCheckWrap.classList.toggle("off", autoCheckBox.disabled);
  saveBtn.disabled = busy || !dirty;
  revertBtn.disabled = busy || !ctx?.lyrics.overridden;
  flagBtn.disabled = busy || !ctx?.lyrics.id;
  // A draft goes out only once a person has checked every line of it.
  const left = unreviewed();
  publishBtn.disabled = busy || !publication() || left > 0;
  publishBtn.textContent = left
    ? `${left} ${left === 1 ? "line" : "lines"} left to review`
    : PUBLISH_LABEL;
}

const PUBLISH_LABEL = publishBtn.textContent;

/// Lines of a draft with words that nobody has checked yet.
const unreviewed = () => (reviewing ? unreviewedIn(lines) : 0);

/// What a saved edit records of the review (see `reviewState`).
const draftState = (): Lyrics["draft"] => (reviewing ? reviewState(lines) : null);

function setBusy(on: boolean) {
  busy = on;
  refreshBar();
}

/// The edited track's length. The live playhead only fills in while this track is still
/// the one playing — after that it describes another song, and a publish or lookup keyed
/// on it would land on that song's identity.
const trackDuration = () =>
  ctx?.duration || (ctx && !stale ? ctx.playhead().duration : 0) || null;

const keyArgs = () => ({
  artist: ctx!.meta.artist,
  track: ctx!.meta.title,
  album: ctx!.meta.album || null,
});

/// The edit, in the shape LRCLIB and the cache both want. Lines that never got a time
/// still belong in the plain form. Section labels belong *only* there: in the LRC, or a
/// Lyricsfile's lines, a player would show them as sung. Labels the plain text had that the
/// timed lines never carried are put back over the lines they headed (see sections.ts).
function edited() {
  const body = serialize(lines).trim();
  if (!body) return { synced: null, plain: null, timing: null };
  if (!anyTimed()) return { synced: null, plain: body, timing: null };
  const sung = lines.filter((l) => !isLabel(l));
  return {
    synced: serialize(sung).trim(),
    plain: withSections(
      ctx?.lyrics.plain,
      lines.map((l) => l.text)
    ),
    timing: toTiming(sung),
  };
}

async function saveOverride(): Promise<Lyrics> {
  const saved = await invoke<Lyrics>("save_lyrics_override", {
    ...keyArgs(),
    lyrics: { ...ctx!.lyrics, ...edited(), draft: draftState(), overridden: true },
  });
  ctx!.lyrics = saved;
  ctx!.onApplied(saved);
  dirty = false;
  refreshBar();
  return saved;
}

saveBtn.addEventListener("click", async () => {
  if (busy || !ctx) return;
  const body = edited();
  if (!body.synced && !body.plain) {
    setStatus("There is nothing to save.", "err");
    return;
  }
  setBusy(true);
  try {
    await saveOverride();
    const left = unreviewed();
    setStatus(
      left
        ? `Saved, with ${left} ${left === 1 ? "line" : "lines"} still to review. The review carries on from here next time.`
        : "Saved. These lyrics are yours until you discard them.",
      "ok"
    );
  } catch (e) {
    setStatus(String(e), "err");
  } finally {
    setBusy(false);
  }
});

revertBtn.addEventListener("click", async () => {
  if (busy || !ctx) return;
  setBusy(true);
  try {
    await invoke("clear_lyrics_override", keyArgs());
    const fresh = await invoke<Lyrics>("fetch_lyrics", {
      ...keyArgs(),
      duration: trackDuration(),
    });
    ctx.lyrics = fresh;
    ctx.onApplied(fresh);
    load(fresh);
    dirty = false;
    render();
    refreshBar();
    setStatus(
      fresh.draft
        ? "Your edit is gone; this is the speech engine's draft again."
        : "Your edit is gone; this is what LRCLIB serves.",
      "ok"
    );
  } catch (e) {
    setStatus(String(e), "err");
  } finally {
    setBusy(false);
  }
});

// ---- publishing -----------------------------------------------------------

/// The edit as LRCLIB would file it, under the record it came from (see `publicationFor`).
const publication = () =>
  ctx ? publicationFor(ctx.lyrics, ctx.meta, trackDuration(), edited()) : null;

publishBtn.addEventListener("click", () => {
  const p = publication();
  if (!p) {
    setStatus("The track's length isn't known yet, and LRCLIB needs it to file lyrics.", "err");
    return;
  }
  showConfirm({
    title: ctx!.lyrics.id ? "Publish this correction?" : "Add these lyrics to LRCLIB?",
    message: ctx!.lyrics.id
      ? `This becomes the version everyone gets for ${p.artistName} — ${p.trackName}. The current one is kept as an earlier revision, so nothing is destroyed.`
      : `This adds ${p.artistName} — ${p.trackName} to the public LRCLIB database, where anyone can fetch it.`,
    go: "Publish",
    run: async () => {
      const saved = await saveOverride(); // the fix should survive a failed publish
      setStatus("Solving LRCLIB's proof-of-work…");
      await invoke("publish_lyrics", { publication: p });
      setStatus("Published to LRCLIB.", "ok");
      await settle(saved);
    },
  });
});

/// Once LRCLIB serves the correction itself the local copy is redundant — drop it, so the
/// pane stops calling itself an edit. If LRCLIB hasn't caught up, keep ours.
/// Whether two LRC texts time the same lines alike. Not a string comparison: LRCLIB rewrites
/// the LRC it derives from a published Lyricsfile in its own spacing (`[00:12.00]Line`, no
/// space), so the text it serves back differs from what was sent while saying the same thing.
function sameLrc(a: string | null, b: string | null) {
  const norm = (lrc: string | null) =>
    parseLines(lrc ?? "")
      .filter((l) => l.t !== null)
      .map((l) => `${Math.round(l.t! * 100)}|${l.text.trim()}`)
      .join("\n");
  return norm(a) === norm(b);
}

async function settle(saved: Lyrics) {
  if (!ctx) return;
  try {
    await invoke("clear_lyrics_override", keyArgs());
    const fresh = await invoke<Lyrics>("fetch_lyrics", {
      ...keyArgs(),
      duration: trackDuration(),
    });
    if (sameLrc(fresh.synced, saved.synced) && (fresh.plain ?? null) === (saved.plain ?? null)) {
      ctx.lyrics = fresh;
      ctx.onApplied(fresh);
      refreshBar();
      setStatus("Published to LRCLIB — it now serves your version.", "ok");
      return;
    }
  } catch {
    // fall through and put the local copy back
  }
  await saveOverride().catch(() => {});
}

flagBtn.addEventListener("click", () => {
  const id = ctx?.lyrics.id;
  if (!id) return;
  showConfirm({
    title: "Report these lyrics?",
    message:
      "Tells LRCLIB the published lyrics for this track are wrong — the right move when they belong to a different song entirely and there is nothing to correct by hand.",
    go: "Report",
    reason: true,
    run: async (reason) => {
      await invoke("flag_lyrics", {
        trackId: id,
        content: reason || null,
        ...keyArgs(),
      });
      setStatus("Reported to LRCLIB.", "ok");
    },
  });
});

// ---- confirmation ---------------------------------------------------------

/// Ask first (see lyric-confirm.ts), then run the action with the bar busy and its outcome
/// in the status line. `run` gets the reason typed, when one was asked for.
async function showConfirm(opts: {
  title: string;
  message: string;
  go: string;
  reason?: boolean;
  run: (reason: string) => Promise<void>;
}) {
  const reason = await confirm.ask(opts);
  if (reason === null || busy || !editing) return;
  setBusy(true);
  setStatus("Working…");
  try {
    await opts.run(reason);
  } catch (e) {
    setStatus(String(e), "err");
  } finally {
    setBusy(false);
  }
}
