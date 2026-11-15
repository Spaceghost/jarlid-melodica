// The lyric editor's lines, and the edits on them that don't need the page: splitting and
// joining lines, keeping a draft's review state and each line's word timings straight through
// both, and converting to and from the `timing` a Lyricsfile carries. Kept apart from
// lyric-editor.ts, which owns the DOM, so it can be tested.

export interface Line {
  t: number | null;
  text: string;
  /// Reviewing a draft: the words the engine was unsure of, until the line is edited, and
  /// whether a person has checked the line.
  doubt?: number[];
  ok?: boolean;
  /// When each word starts, by position in `words(text)`; null for a word not yet timed.
  /// Absent when the line has no word timing at all.
  words?: (number | null)[];
}

/// One line of `Lyrics.timing` (`lyricsfile::TimedLine` in Rust). An empty `text` is a pause.
export interface TimedLine {
  text: string;
  start: number;
  end?: number | null;
  words?: { text: string; start: number; end?: number | null }[];
}

/// A line's words, as word timings index them.
export const wordsOf = (text: string) => text.trim().split(/\s+/).filter(Boolean);

/// A draft's review state, as `Lyrics.draft` carries it: by line, blank lines included.
export interface DraftReview {
  doubt: number[][];
  reviewed: boolean[];
}

/// Blank lines are the gaps between verses. They have no start of their own to hear, so
/// a timing pass steps over them, and there is nothing in one to review.
export const isBlank = (l: Line) => !l.text.trim();

/// Give `lines` a draft's review state. Blank lines count as reviewed.
export function applyReview(lines: Line[], draft: DraftReview) {
  lines.forEach((line, i) => {
    line.doubt = draft.doubt[i] ?? [];
    line.ok = !!draft.reviewed[i] || isBlank(line);
  });
}

/// Lines of a draft with words that nobody has checked yet.
export const unreviewed = (lines: Line[]) => lines.filter((l) => !isBlank(l) && !l.ok).length;

/// What a saved edit records of a review: nothing once it is done, which is what lets it be
/// published (`publish_lyrics` refuses a saved edit that is still a draft).
export function reviewState(lines: Line[]): DraftReview | null {
  if (unreviewed(lines) === 0) return null;
  return {
    doubt: lines.map((l) => l.doubt ?? []),
    reviewed: lines.map((l) => !!l.ok || isBlank(l)),
  };
}

/// Split line `i`, whose text is now `text`, at character `at`; at the end, that opens an
/// empty line below. A timed line's second half starts where its share of the characters puts
/// it between this line and the next timed one: a guess, but a closer one than no time at all,
/// and in a draft it gets checked.
export function splitLine(lines: Line[], i: number, text: string, at: number, reviewing: boolean) {
  const line = lines[i];
  const head = text.slice(0, at).trimEnd();
  const tail = text.slice(at).trimStart();
  let t: number | null = null;
  if (line.t !== null && head && tail) {
    const next = lines.slice(i + 1).find((l) => l.t !== null && !isBlank(l))?.t ?? null;
    const end = next !== null && next > line.t ? next : line.t + 4;
    t = line.t + ((end - line.t) * head.length) / (head.length + tail.length);
  }
  if (line.words && head && tail) {
    // The words before the caret keep their times, and the second half starts at its first
    // word's, when that is known: a better guess than its share of the characters.
    const n = wordsOf(head).length;
    const rest = line.words.slice(n);
    line.words = line.words.slice(0, n);
    if (rest[0] != null) t = rest[0];
    line.text = head;
    const fresh: Line = { t, text: tail, words: rest };
    afterSplit(line, fresh, reviewing, true);
    lines.splice(i + 1, 0, fresh);
    return;
  }
  line.text = head;
  const fresh: Line = { t, text: tail };
  afterSplit(line, fresh, reviewing, !!(head && tail));
  lines.splice(i + 1, 0, fresh);
}

function afterSplit(line: Line, fresh: Line, reviewing: boolean, real: boolean) {
  if (!reviewing) return;
  fresh.ok = false;
  // A real split makes both halves new lines to the reviewer, and the engine's doubts
  // can't be divided by position. Opening an empty line below leaves this one as it was.
  if (real) {
    line.doubt = fresh.doubt = [];
    line.ok = false;
  }
}

/// Join line `i`, whose text is now `text`, onto the end of the line above. A blank line
/// above is simply dropped: the line keeps its own place and start. Returns where the join
/// is, in the line above's text.
export function joinLine(lines: Line[], i: number, text: string, reviewing: boolean): number {
  const above = lines[i - 1];
  if (isBlank(above)) {
    lines.splice(i - 1, 1);
    return 0;
  }
  const at = above.text.trimEnd().length + 1;
  const below = lines[i];
  // Word times survive a join when both halves had them, or the joined line has a mix.
  if (above.words || below.words) {
    above.words = [
      ...(above.words ?? wordsOf(above.text).map(() => null)),
      ...(below.words ?? wordsOf(text).map((_, k) => (k === 0 ? below.t : null))),
    ];
  }
  above.text = `${above.text.trimEnd()} ${text.trimStart()}`;
  if (reviewing) {
    above.doubt = [];
    above.ok = false;
  }
  lines.splice(i, 1);
  return at;
}

/// Line `i`'s text changed to `text`, by whatever means (an input method, say). Worked out as
/// the one edit between the common start and end of the two, then made with `editText`.
export function retext(line: Line, text: string) {
  const old = line.text;
  let a = 0;
  while (a < old.length && a < text.length && old[a] === text[a]) a++;
  let b = 0;
  while (b < old.length - a && b < text.length - a && old[old.length - 1 - b] === text[text.length - 1 - b])
    b++;
  editText(line, a, old.length - b, text.slice(a, text.length - b));
}

// ---- editing as text ------------------------------------------------------------------------
// The editor is one text across all the lines: a caret or a selection is a pair of positions,
// and every edit — typing, deleting, cutting, pasting — is made here, so each line's start,
// word times and review state follow the words they belong to.

/// A place in the lines: line `line`, `off` characters in.
export interface Pos {
  line: number;
  off: number;
}

export const comparePos = (a: Pos, b: Pos) => a.line - b.line || a.off - b.off;

/// Each word of `text` as [start, end) in characters, in the order `wordsOf` gives them.
function wordSpans(text: string): [number, number][] {
  const out: [number, number][] = [];
  for (const m of text.matchAll(/\S+/g)) out.push([m.index!, m.index! + m[0].length]);
  return out;
}

/// Replace characters [start, end) of `line` with `insert`. Word times stay when the line still
/// has as many words (a spelling fixed). Otherwise the words the edit didn't touch keep their
/// times and the ones it did lose theirs: which time belongs to a changed word is unknown. The
/// engine's doubts are about words that have now been looked at, so they go.
export function editText(line: Line, start: number, end: number, insert: string) {
  const old = line.text;
  const text = old.slice(0, start) + insert + old.slice(end);
  line.text = text;
  if (line.doubt?.length) line.doubt = [];
  if (!line.words) return;
  const n = wordsOf(text).length;
  if (n === line.words.length) return;
  const spans = wordSpans(old);
  const joined = (c: string | undefined) => c !== undefined && /\S/.test(c);
  // A word is untouched if it lies wholly outside the edit and nothing new is glued onto it.
  const before = spans.filter(([, e]) => e < start || (e === start && !joined(text[start]))).length;
  const afterAt = start + insert.length;
  const after = spans.filter(([s]) => s > end || (s === end && !joined(text[afterAt - 1]))).length;
  const mid = n - before - after;
  if (mid < 0) {
    delete line.words;
    return;
  }
  const words = [
    ...line.words.slice(0, before),
    ...Array<number | null>(mid).fill(null),
    ...line.words.slice(line.words.length - after),
  ];
  if (words.some((w) => w !== null)) line.words = words;
  else delete line.words;
}

const cloneLine = (l: Line): Line => ({
  ...l,
  ...(l.words ? { words: l.words.slice() } : {}),
  ...(l.doubt ? { doubt: l.doubt.slice() } : {}),
});

/// Delete from `from` to `to` (in order), across lines or within one. Across lines, the text
/// joins exactly where the deletion ends, as in any text editor. The first line keeps its
/// start, unless nothing of it is left: then the line the deletion ended in keeps its own.
/// Returns the caret.
export function deleteRange(lines: Line[], from: Pos, to: Pos, reviewing: boolean): Pos {
  if (from.line === to.line) {
    editText(lines[from.line], from.off, to.off, "");
    return from;
  }
  const a = lines[from.line];
  const b = lines[to.line];
  editText(b, 0, to.off, "");
  // With its beginning gone, the last line starts at its first word left, if that has a time.
  // With nothing left it starts nowhere: a timed empty line would be a pause.
  if (to.off > 0) b.t = b.words?.[0] ?? (b.text.trim() ? b.t : null);
  editText(a, from.off, a.text.length, "");
  lines.splice(from.line + 1, to.line - from.line - 1);
  if (!a.text) {
    lines.splice(from.line, 1);
    if (reviewing && b.text.trim()) b.ok = false;
    return { line: from.line, off: 0 };
  }
  if (b.text) {
    if (a.words || b.words) {
      const aw = a.words ?? wordsOf(a.text).map(() => null);
      const bw = b.words ?? wordsOf(b.text).map((_, k) => (k === 0 ? b.t : null));
      // Joined mid-word, the two halves are one word now, with no known time.
      const glued = /\S$/.test(a.text) && /^\S/.test(b.text);
      const words = glued ? [...aw.slice(0, -1), null, ...bw.slice(1)] : [...aw, ...bw];
      if (words.some((w) => w !== null)) a.words = words;
      else delete a.words;
    }
    a.text += b.text;
  }
  if (reviewing) {
    a.doubt = [];
    a.ok = false;
  }
  lines.splice(from.line + 1, 1);
  return from;
}

/// Join the line below `i` onto it: Delete at the end of a line. The counterpart of Backspace
/// at the start of the next one (`joinLine`), with the caret left where it was.
export function joinDown(lines: Line[], i: number, reviewing: boolean): Pos {
  const below = lines[i + 1];
  if (!below.text.trim()) {
    lines.splice(i + 1, 1);
    return { line: i, off: lines[i].text.length };
  }
  const at = joinLine(lines, i + 1, below.text, reviewing);
  return { line: i, off: Math.max(0, at - 1) };
}

/// The lines between `from` and `to`, cut down to the selection, with their starts and word
/// times: what a copy carries. A first line copied from mid-way starts at its first word, if
/// that has a time.
export function sliceLines(lines: Line[], from: Pos, to: Pos): Line[] {
  const out = lines.slice(from.line, to.line + 1).map(cloneLine);
  const last = out[out.length - 1];
  editText(last, to.off, last.text.length, "");
  if (from.off > 0) {
    const first = out[0];
    editText(first, 0, from.off, "");
    first.t = first.words?.[0] ?? null;
  }
  return out;
}

/// Insert `frags` at `at`: a paste. One fragment goes into the line. More split it: the first
/// fragment ends this line, the last starts the rest of it, and the ones between are lines of
/// their own, with their own starts. Pasted into the start of a line, the line moves down
/// whole, start and all. Returns the caret, after what was pasted.
export function insertLines(lines: Line[], at: Pos, frags: Line[], reviewing: boolean): Pos {
  const line = lines[at.line];
  const first = frags[0];
  if (frags.length === 1) {
    if (!line.text && first.text) {
      // An empty line takes a whole copied line as it is, time and all.
      lines[at.line] = { ...cloneLine(first), t: first.t ?? line.t };
      if (reviewing) lines[at.line].ok = false;
    } else {
      editText(line, at.off, at.off, first.text);
      if (reviewing && first.text) line.ok = false;
    }
    return { line: at.line, off: at.off + first.text.length };
  }

  const tail = cloneLine(line);
  let head: Line;
  if (!line.text.slice(0, at.off).trim()) {
    // Nothing before the caret: the line moves down whole, and the first fragment takes its place.
    editText(tail, 0, at.off, "");
    head = cloneLine(first);
  } else {
    editText(tail, 0, at.off, "");
    tail.t = tail.words?.[0] ?? null;
    if (reviewing) tail.ok = false;
    head = line;
    editText(head, at.off, head.text.length, "");
    editText(head, head.text.length, head.text.length, first.text);
    if (reviewing) head.ok = false;
  }

  const last = frags[frags.length - 1];
  let end: Line;
  if (!last.text) end = tail;
  else if (!tail.text) end = cloneLine(last);
  else {
    end = tail;
    editText(end, 0, 0, last.text);
    end.t = last.t ?? tail.t;
    if (reviewing) end.ok = false;
  }

  lines.splice(at.line, 1, head, ...frags.slice(1, -1).map(cloneLine), end);
  return { line: at.line + frags.length - 1, off: last.text.length };
}

/// The editor's lines from a Lyricsfile's timing. A line's end becomes the empty line that
/// clears the display there, which is how the editor (and LRC) hold a pause.
export function fromTiming(timing: TimedLine[]): Line[] {
  const out: Line[] = [];
  timing.forEach((tl, i) => {
    const line: Line = { t: tl.start, text: tl.text };
    const n = wordsOf(tl.text).length;
    if (tl.words?.length && tl.words.length === n) line.words = tl.words.map((w) => w.start);
    out.push(line);
    const next = timing[i + 1];
    if (tl.end != null && tl.text.trim() && (!next || tl.end < next.start)) {
      const cleared = next && !next.text.trim() && Math.abs(next.start - tl.end) < 0.005;
      if (!cleared) out.push({ t: tl.end, text: "" });
    }
  });
  return out;
}

/// What a saved edit or a publication carries beyond its LRC: the timed lines with their words,
/// and each line's end where an empty line follows it. Null when no line has word times — then
/// the LRC says everything, pauses included.
export function toTiming(lines: Line[]): TimedLine[] | null {
  const timed = lines.filter((l) => l.t !== null);
  const anyWords = timed.some((l) => l.words?.some((w) => w !== null));
  if (!anyWords) return null;
  return timed.map((l, i) => {
    const out: TimedLine = { text: l.text.trim(), start: l.t! };
    const next = timed[i + 1];
    if (out.text && next && !next.text.trim()) out.end = next.t;
    const words = wordsOf(l.text);
    // Only lines whose every word has a time: the format has no untimed word.
    if (l.words && l.words.length === words.length && l.words.every((w) => w !== null)) {
      out.words = words.map((text, k) => ({ text, start: l.words![k]! }));
    }
    return out;
  });
}

// ---- the timeline's edits -------------------------------------------------------------------
// What dragging on the timeline does to the lines. Every move is clamped so lines stay in
// order: a line can't start before the one above it or after the one below.

/// The smallest gap kept between neighbouring starts, seconds.
const MIN_GAP = 0.05;

/// The nearest timed line after `i` (blank or not), or -1.
const nextTimed = (lines: Line[], i: number) =>
  lines.findIndex((l, k) => k > i && l.t !== null);
/// The nearest timed line before `i`, or -1.
const prevTimed = (lines: Line[], i: number) => {
  for (let k = i - 1; k >= 0; k--) if (lines[k].t !== null) return k;
  return -1;
};

/// Where line `i` stops showing: the next timed line's start, which is its pause (an empty
/// line) when it has one. `fallback` past the last line.
export function lineEnd(lines: Line[], i: number, fallback: number): number {
  const n = nextTimed(lines, i);
  return n >= 0 ? lines[n].t! : fallback;
}

/// Whether line `i` ends in a pause: the next timed line is an empty one.
export function endsInPause(lines: Line[], i: number) {
  const n = nextTimed(lines, i);
  return n >= 0 && isBlank(lines[n]);
}

/// Each word's start as the timeline draws it: its own time, or for words not yet timed, an
/// even share of the time between the timed words around it (or the line's start and end).
export function wordStarts(lines: Line[], i: number, fallbackEnd: number): number[] {
  const line = lines[i];
  const n = wordsOf(line.text).length;
  if (!n || line.t === null) return [];
  const own = line.words?.length === n ? line.words : Array<number | null>(n).fill(null);
  const end = lineEnd(lines, i, fallbackEnd);
  const known = own.map((w, k) => (k === 0 ? (w ?? line.t!) : w));
  const out: number[] = [];
  for (let k = 0; k < n; k++) {
    if (known[k] !== null) {
      out.push(known[k]!);
      continue;
    }
    let j = k + 1;
    while (j < n && known[j] === null) j++;
    const from = out[k - 1];
    const to = j < n ? known[j]! : end;
    // An even share: the untimed run k..j-1 splits the time between its timed neighbours.
    out.push(from + (to - from) / (j - k + 1));
    known[k] = out[k];
  }
  return out;
}

/// Stamp line `line`'s start at `t` (a tap), unclamped: a timing pass sorts its neighbours out
/// itself. Its word times keep their places in the line, moving with it, since a tap says
/// when the line starts, not how it is sung.
export function stampStart(line: Line, t: number) {
  if (line.t !== null && line.words) {
    const by = t - line.t;
    line.words = line.words.map((w) => (w === null ? null : w + by));
  }
  line.t = t;
}

/// Move line `i`'s start to `t`, between its neighbours. Its first word moves with it.
export function setStart(lines: Line[], i: number, t: number): number {
  const p = prevTimed(lines, i);
  const n = nextTimed(lines, i);
  const lo = p >= 0 ? lines[p].t! + MIN_GAP : 0;
  let hi = n >= 0 ? lines[n].t! - MIN_GAP : Infinity;
  // Not past its own second word either.
  const w = lines[i].words;
  if (w && w.length > 1 && w[1] !== null) hi = Math.min(hi, w[1] - MIN_GAP);
  const at = clamp(t, lo, hi);
  lines[i].t = at;
  if (w?.length) w[0] = at;
  return at;
}

/// Move line `i`'s end to `t`. An end before the next line starts is a pause: the empty line
/// after it moves, or one is put there. Dragged up to the next line, the pause goes. Returns
/// the index of the pause line, or -1 if there is none now.
export function setEnd(lines: Line[], i: number, t: number): number {
  const line = lines[i];
  if (line.t === null) return -1;
  const n = nextTimed(lines, i);
  // The line whose start bounds the pause: past an existing pause, the one after it.
  const pause = n >= 0 && isBlank(lines[n]) ? n : -1;
  const after = pause >= 0 ? nextTimed(lines, pause) : n;
  const timedWords = line.words?.filter((w): w is number => w !== null) ?? [];
  const lastWord = timedWords.length ? timedWords[timedWords.length - 1] : line.t;
  const lo = lastWord + MIN_GAP * 2;
  const hi = after >= 0 ? lines[after].t! : Infinity;
  const at = clamp(t, lo, hi);
  if (after >= 0 && at > hi - MIN_GAP) {
    if (pause >= 0) lines.splice(pause, 1);
    return -1;
  }
  if (pause >= 0) {
    lines[pause].t = at;
    return pause;
  }
  lines.splice(i + 1, 0, { t: at, text: "" });
  return i + 1;
}

/// Move word `k` of line `i` to `t`, between its neighbours. Untimed words around it take the
/// times the timeline shows for them, so what was on screen is what is kept; word 0 is the
/// line's start, so it moves the line.
export function setWordStart(
  lines: Line[],
  i: number,
  k: number,
  t: number,
  fallbackEnd: number
): number {
  if (k === 0) return setStart(lines, i, t);
  const shown = wordStarts(lines, i, fallbackEnd);
  const line = lines[i];
  line.words = shown.slice();
  const end = lineEnd(lines, i, fallbackEnd);
  const lo = shown[k - 1] + MIN_GAP;
  const hi = (k + 1 < shown.length ? shown[k + 1] : end) - MIN_GAP;
  const at = clamp(t, lo, hi);
  line.words[k] = at;
  return at;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));

/// `lines` (from the LRC, which keeps every line, timed or not) with what `timing` adds: word
/// times on the lines it matches by start and text, and an empty line where a line ends
/// before the next begins. The LRC stays the authority on which lines there are, so anything
/// indexed by them — a draft's review — still lines up.
export function mergeTiming(lines: Line[], timing: TimedLine[]): Line[] {
  const out = lines.map((l) => ({ ...l }));
  for (const tl of timing) {
    if (!tl.text.trim()) continue;
    // LRC keeps hundredths; timing keeps milliseconds.
    const i = out.findIndex(
      (l) => l.t !== null && Math.abs(l.t - tl.start) < 0.011 && l.text.trim() === tl.text.trim()
    );
    if (i < 0) continue;
    if (tl.words?.length && tl.words.length === wordsOf(out[i].text).length) {
      out[i].words = tl.words.map((w) => w.start);
    }
    if (tl.end != null && !endsInPause(out, i) && tl.end < lineEnd(out, i, Infinity) - 0.005) {
      out.splice(i + 1, 0, { t: tl.end, text: "" });
    }
  }
  return out;
}

/// For each of `shown` (the pane's timed lines), its words' start times from `timing`, when a
/// timing line has the same start and text and times every word; otherwise undefined.
export function wordTimesFor(
  shown: { t: number; text: string }[],
  timing: TimedLine[]
): (number[] | undefined)[] {
  return shown.map((l) => {
    const tl = timing.find(
      (x) => Math.abs(x.start - l.t) < 0.011 && x.text.trim() === l.text.trim()
    );
    const n = wordsOf(l.text).length;
    return tl?.words?.length && tl.words.length === n ? tl.words.map((w) => w.start) : undefined;
  });
}
