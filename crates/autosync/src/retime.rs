//! Timing every line of a listener's lyrics, taking the times they set as strong hints.
//!
//! A listener fixing a song's lyrics often times some lines by hand and not the rest. This
//! times the rest from what the speech engine heard, and checks the hand-set ones against it.
//!
//! 1. The lyric words are matched to the heard words as the line aligner matches them
//!    ([`crate::align`]), except that a heard word far from where the hints put its line costs
//!    more to match. That is what picks the right copy of a chorus the lyrics repeat.
//! 2. Each line's start is read off its matched words, as the line aligner reads it, and then
//!    shifted by how this listener stamps lines (the median of hint minus heard, over lines
//!    where the two agree): their taps and the generated times then read the same.
//! 3. A hand-set time stays where the heard words roughly agree with it ([`Params::agree`]).
//!    It moves only when enough of its words ([`Params::strong`]) were heard clearly elsewhere:
//!    then the tap was most likely on the wrong line or late.
//! 4. Lines neither heard nor hinted are placed between their neighbours, stanza by stanza
//!    ([`crate::align`]'s interpolation).
//!
//! Word starts inside the lines are then [`crate::words`]' job (and [`crate::refine`]'s, with the
//! forced aligner), on the spans [`spans`] makes.

use crate::align::{self, LineTime};
use crate::text::{is_section_label, words};
use crate::Heard;

/// One line as the listener left it.
#[derive(Debug, Clone)]
pub struct Hinted<'a> {
    pub text: &'a str,
    /// The time they set, if any.
    pub hint: Option<f64>,
}

/// Where a line's time came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum How {
    /// The listener's own time, kept: the heard words agree, or say nothing.
    Hint,
    /// The listener's time, moved: the heard words clearly put the line elsewhere.
    Moved,
    /// Untimed, and timed from its heard words.
    Heard,
    /// Neither hinted nor heard: placed between its neighbours.
    Placed,
    /// A blank line or a section label: never sung. A blank line keeps a hint it had (a pause,
    /// where the line before stops showing) while that still falls between its neighbours.
    None,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Retimed {
    pub t: Option<f64>,
    pub how: How,
}

#[derive(Debug, Clone)]
pub struct Params {
    pub align: align::Params,
    /// Seconds a hint and the heard words may disagree by and the hint still stand.
    pub agree: f64,
    /// Matched words a line needs before its heard time can move a hint: this many, or all of
    /// its words when it has fewer.
    pub strong: usize,
    /// Seconds beyond the hints around a line that its words are still expected in.
    pub slack: f64,
}

impl Default for Params {
    fn default() -> Self {
        Self {
            align: align::Params::default(),
            agree: 1.0,
            strong: 3,
            slack: 2.0,
        }
    }
}

/// The result: one entry per input line, and the listener's stamping offset that was applied.
#[derive(Debug, Clone)]
pub struct Retime {
    pub lines: Vec<Retimed>,
    /// Seconds added to heard line starts (negative: the listener stamps ahead of the voice).
    pub offset: f64,
    /// Share of lyric words matched to something heard.
    pub coverage: f64,
}

/// Bounds on the learned stamping offset, seconds.
const OFFSET_RANGE: (f64, f64) = (-0.8, 0.4);

pub fn retime(lines: &[Hinted], heard: &[Heard], duration: f64, p: &Params) -> Retime {
    let sung = |l: &Hinted| !l.text.trim().is_empty() && !is_section_label(l.text);
    let hints: Vec<Option<f64>> = lines
        .iter()
        .map(|l| if sung(l) { l.hint } else { None })
        .collect();

    // Every lyric word with its line, and the span the hints expect it in: from this line's
    // hint (or the last one before it) to the next later hint, give or take `slack`.
    let mut lyric: Vec<(usize, String)> = Vec::new();
    for (i, l) in lines.iter().enumerate() {
        if sung(l) {
            lyric.extend(words(l.text).into_iter().map(|w| (i, w)));
        }
    }
    let spans: Vec<Option<(f64, f64)>> = (0..lines.len())
        .map(|i| {
            let lo = hints[..=i].iter().rev().find_map(|h| *h);
            let hi = hints[i + 1..].iter().find_map(|h| *h);
            if lo.is_none() && hi.is_none() {
                return None;
            }
            Some((
                lo.map_or(f64::NEG_INFINITY, |t| t - p.slack),
                hi.map_or(f64::INFINITY, |t| t + p.slack),
            ))
        })
        .collect();
    let expected: Vec<Option<(f64, f64)>> = lyric.iter().map(|(i, _)| spans[*i]).collect();
    let heard_words: Vec<String> = heard.iter().map(|h| words(&h.text).concat()).collect();
    let pairs = align::match_words(&lyric, heard, &heard_words, &expected, &p.align);
    let matched_words = pairs.iter().filter(|x| x.is_some()).count();

    // Seconds per word, as the line aligner measures it.
    let mut gaps = Vec::new();
    let mut last: Option<(usize, f64)> = None;
    for (k, m) in pairs.iter().enumerate() {
        if let Some(j) = *m {
            let t = heard[j].start;
            if let Some((lk, lt)) = last {
                if k == lk + 1 && t > lt {
                    gaps.push(t - lt);
                }
            }
            last = Some((k, t));
        }
    }
    let word_seconds = align::median(&mut gaps)
        .unwrap_or(align::DEFAULT_WORD_SECONDS)
        .clamp(0.15, 0.8);

    // Each line's heard start (no lead yet), from its first matched word stepped back over the
    // unmatched words before it.
    let mut stanza = 0;
    let mut out: Vec<LineTime> = lines
        .iter()
        .map(|l| {
            if !sung(l) {
                stanza += 1;
            }
            LineTime {
                t: None,
                words: 0,
                matched: 0,
                interpolated: false,
                stanza,
            }
        })
        .collect();
    let mut first: Vec<Option<usize>> = vec![None; lines.len()];
    for (k, (i, _)) in lyric.iter().enumerate() {
        let e = &mut out[*i];
        e.words += 1;
        first[*i].get_or_insert(k);
        if let Some(j) = pairs[k] {
            e.matched += 1;
            if e.t.is_none() {
                let before = k - first[*i].unwrap_or(k);
                e.t = Some(heard[j].start - before as f64 * word_seconds);
            }
        }
    }
    let heard_at: Vec<Option<f64>> = out
        .iter()
        .map(|l| {
            l.t.filter(|_| l.matched >= p.align.min_anchor_words.min(l.words))
        })
        .collect();

    // How this listener stamps: hint minus heard, where the two agree.
    let mut diffs: Vec<f64> = hints
        .iter()
        .zip(&heard_at)
        .filter_map(|(h, e)| Some(h.as_ref()? - e.as_ref()?))
        .filter(|d| d.abs() < p.agree)
        .collect();
    let offset = if diffs.len() >= 3 {
        align::median(&mut diffs).unwrap_or_default()
    } else {
        -p.align.lead
    }
    .clamp(OFFSET_RANGE.0, OFFSET_RANGE.1);

    let strong = |l: &LineTime| l.matched >= p.strong.min(l.words);
    let mut how: Vec<How> = vec![How::None; lines.len()];
    for i in 0..lines.len() {
        let line = &mut out[i];
        line.t = None;
        if line.words == 0 {
            continue;
        }
        let heard_t = heard_at[i].map(|e| e + offset);
        (line.t, how[i]) = match (hints[i], heard_t) {
            (Some(h), Some(e)) if (h - e).abs() > p.agree && strong(line) => (Some(e), How::Moved),
            (Some(h), _) => (Some(h), How::Hint),
            (None, Some(e)) => (Some(e), How::Heard),
            (None, None) => (None, How::Placed),
        };
    }

    // Order. Kept hints are the skeleton; a heard or moved time that doesn't fit between the
    // kept hints around it is dropped (a moved hint goes back to the hint), and heard times
    // that run backwards between them go too.
    let kept: Vec<usize> = (0..lines.len()).filter(|&i| how[i] == How::Hint).collect();
    for i in 0..lines.len() {
        if !matches!(how[i], How::Heard | How::Moved) {
            continue;
        }
        let t = out[i].t.unwrap_or_default();
        let lo = kept.iter().rev().find(|&&k| k < i).and_then(|&k| out[k].t);
        let hi = kept.iter().find(|&&k| k > i).and_then(|&k| out[k].t);
        if lo.is_some_and(|lo| t <= lo) || hi.is_some_and(|hi| t >= hi) {
            if how[i] == How::Moved {
                out[i].t = hints[i];
                how[i] = How::Hint;
            } else {
                out[i].t = None;
                how[i] = How::Placed;
            }
        }
    }
    let mut latest = f64::NEG_INFINITY;
    for i in 0..lines.len() {
        let Some(t) = out[i].t else { continue };
        if t < latest && how[i] != How::Hint {
            out[i].t = None;
            how[i] = How::Placed;
        } else {
            latest = latest.max(t);
        }
    }

    // The rest, between their neighbours and out from the ends.
    let line_seconds = align::line_pace(&out);
    align::interpolate(&mut out, |l| align::step(line_seconds, word_seconds, l));
    let placed = align::Alignment {
        lines: out,
        lyric_words: lyric.len(),
        matched_words,
        word_seconds,
        line_seconds,
    }
    .placed(if duration > 0.0 { duration } else { f64::MAX });

    let mut result: Vec<Retimed> = placed
        .iter()
        .zip(&how)
        .map(|(&t, &how)| Retimed { t, how })
        .collect();
    // A blank line's hint is a pause: kept while it still falls inside the gap it marked.
    for (i, l) in lines.iter().enumerate() {
        let Some(h) = l.hint.filter(|_| l.text.trim().is_empty()) else {
            continue;
        };
        let before = result[..i].iter().rev().find_map(|r| r.t);
        let after = result[i + 1..].iter().find_map(|r| r.t);
        if before.is_none_or(|b| h > b) && after.is_none_or(|a| h < a) {
            result[i].t = Some(h);
        }
    }
    Retime {
        lines: result,
        offset,
        coverage: matched_words as f64 / lyric.len().max(1) as f64,
    }
}

/// The sung lines of a retime as [`crate::words`] spans: each from its start to the next timed
/// line's (a pause included), the last to `last_end`. Returns each span's input line index.
pub fn spans<'a>(
    lines: &[Hinted<'a>],
    r: &Retime,
    last_end: f64,
) -> Vec<(usize, crate::words::Line<'a>)> {
    let timed: Vec<usize> = (0..lines.len())
        .filter(|&i| r.lines[i].t.is_some())
        .collect();
    timed
        .iter()
        .enumerate()
        .filter(|(_, &i)| r.lines[i].how != How::None)
        .map(|(k, &i)| {
            let start = r.lines[i].t.unwrap_or_default();
            let end = timed
                .get(k + 1)
                .and_then(|&n| r.lines[n].t)
                .unwrap_or(last_end.max(start));
            (
                i,
                crate::words::Line {
                    text: lines[i].text,
                    start,
                    end,
                },
            )
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Heard words, one every `pace` seconds from `t0`, for each line's text in turn, `gap`
    /// seconds between lines. Returns them and each line's first heard word's time.
    fn sing(lines: &[&str], t0: f64, pace: f64, gap: f64) -> (Vec<Heard>, Vec<f64>) {
        let mut t = t0;
        let mut heard = Vec::new();
        let mut starts = Vec::new();
        for l in lines {
            starts.push(t);
            for w in l.split_whitespace() {
                heard.push(Heard {
                    text: w.into(),
                    start: t,
                    end: t + pace * 0.8,
                    p: 1.0,
                });
                t += pace;
            }
            t += gap;
        }
        (heard, starts)
    }

    fn hinted<'a>(lines: &[&'a str], hints: &[Option<f64>]) -> Vec<Hinted<'a>> {
        lines
            .iter()
            .zip(hints)
            .map(|(&text, &hint)| Hinted { text, hint })
            .collect()
    }

    const SONG: [&str; 6] = [
        "first date at an arcade",
        "bought me a coca cola",
        "asked me what i wanna play",
        "passed me the game controller",
        "nough of being sweet",
        "make a mess of me",
    ];

    #[test]
    fn untimed_lines_are_timed_by_ear_in_the_listeners_style() {
        let (heard, at) = sing(&SONG, 10.0, 0.3, 0.4);
        // The listener stamps 0.2 s ahead of the voice, on every other line.
        let hints: Vec<Option<f64>> = at
            .iter()
            .enumerate()
            .map(|(i, t)| (i % 2 == 0).then_some(t - 0.2))
            .collect();
        let r = retime(&hinted(&SONG, &hints), &heard, 60.0, &Params::default());
        assert!((r.offset + 0.2).abs() < 1e-9, "{}", r.offset);
        for (i, l) in r.lines.iter().enumerate() {
            let want = at[i] - 0.2;
            assert!((l.t.unwrap() - want).abs() < 1e-9, "line {i}: {l:?}");
            assert_eq!(l.how, if i % 2 == 0 { How::Hint } else { How::Heard });
        }
    }

    #[test]
    fn a_hint_close_to_the_voice_stays_and_a_wrong_one_moves() {
        let (heard, at) = sing(&SONG, 10.0, 0.3, 0.4);
        let mut hints: Vec<Option<f64>> = at.iter().map(|t| Some(t - 0.2)).collect();
        hints[1] = Some(at[1] + 0.5); // a late tap: kept
        hints[4] = Some(at[4] + 1.6); // tapped on the next line: moved
        let r = retime(&hinted(&SONG, &hints), &heard, 60.0, &Params::default());
        assert_eq!(r.lines[1].t, hints[1]);
        assert_eq!(r.lines[1].how, How::Hint);
        assert_eq!(r.lines[4].how, How::Moved);
        assert!((r.lines[4].t.unwrap() - (at[4] - 0.2)).abs() < 1e-9);
    }

    #[test]
    fn hints_pick_which_chorus_the_words_belong_to() {
        // The same line sung twice; only the second time is in the lyrics' second half, which
        // the hints around it say.
        let lines = [
            "la la love",
            "verse words here now",
            "la la love",
            "end of it all",
        ];
        let heard: Vec<Heard> = [
            ("la", 1.0),
            ("la", 1.3),
            ("love", 1.6),
            ("la", 30.0),
            ("la", 30.3),
            ("love", 30.6),
        ]
        .iter()
        .map(|&(w, t)| Heard {
            text: w.into(),
            start: t,
            end: t + 0.2,
            p: 1.0,
        })
        .collect();
        let hints = [None, Some(5.0), None, Some(32.0)];
        let r = retime(&hinted(&lines, &hints), &heard, 60.0, &Params::default());
        assert_eq!(r.lines[0].how, How::Heard);
        assert_eq!(r.lines[2].how, How::Heard);
        assert!(r.lines[0].t.unwrap() < 2.0, "{:?}", r.lines);
        assert!(
            (r.lines[2].t.unwrap() - 29.85).abs() < 0.01,
            "{:?}",
            r.lines
        );
    }

    #[test]
    fn unheard_lines_are_placed_and_blank_lines_keep_their_pause() {
        let lines = ["one two three", "", "four five six", "seven eight nine"];
        let (heard, _) = sing(&["one two three"], 1.0, 0.3, 0.0);
        let hints = [Some(0.9), Some(3.0), Some(8.0), None];
        let r = retime(&hinted(&lines, &hints), &heard, 30.0, &Params::default());
        assert_eq!(
            r.lines[1],
            Retimed {
                t: Some(3.0),
                how: How::None
            }
        );
        assert_eq!(r.lines[2].how, How::Hint);
        assert_eq!(r.lines[3].how, How::Placed);
        assert!(r.lines[3].t.unwrap() > 8.0);
        let s = spans(&hinted(&lines, &hints), &r, 30.0);
        assert_eq!(s.iter().map(|(i, _)| *i).collect::<Vec<_>>(), [0, 2, 3]);
        assert_eq!(s[0].1.end, 3.0, "the first line ends at its pause");
    }
}
