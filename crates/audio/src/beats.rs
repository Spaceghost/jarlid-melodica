//! Where every beat of a whole song falls.
//!
//! [`crate::TempoTracker`] says how fast a song is and where one beat sits, which is all a live
//! readout needs. Laying a grid from those two numbers across a whole song does not work: the
//! tempo is good to a fraction of a BPM, and 0.5 BPM out at 120 is 4 ms a beat, most of a
//! second by the end of a four-minute song. Live drummers drift further than that on their own.
//!
//! So this tracks the beats instead, the way Ellis does ("Beat Tracking by Dynamic Programming",
//! 2007): every moment gets a score — how strong the onset there is, plus the best score of an
//! earlier beat about one period back, less a penalty for how far that gap is from the period.
//! Following the best chain back from the end gives beats that sit on the onsets and keep to the
//! tempo between them, bending with the song where it bends.

/// How hard a gap away from the period is penalised, against an onset's (normalised) strength.
/// Ellis's value: high enough that the grid holds through bars with nothing on the beat, low
/// enough to follow a drifting tempo.
const TIGHTNESS: f64 = 100.0;

/// Half-width of the moving mean taken off the onset envelope, in seconds, as the tempo tracker
/// does: a song getting louder is not a beat.
const ADAPT_HALF_SECONDS: f64 = 0.5;

/// Beat times in seconds, from an onset envelope (`rate` values per second, as
/// [`crate::TempoTracker::history`] gives it) and the song's tempo.
pub fn track(onset: &[f32], rate: f64, bpm: f64) -> Vec<f64> {
    let n = onset.len();
    if n == 0 || !(bpm > 0.0) || !(rate > 0.0) {
        return Vec::new();
    }
    let period = rate * 60.0 / bpm;
    if period < 2.0 || (n as f64) < 2.0 * period {
        return Vec::new();
    }

    // What rises above the local average, scaled to unit spread so TIGHTNESS means the same in a
    // quiet song as a loud one.
    let mut prefix = vec![0.0f64; n + 1];
    for (i, &v) in onset.iter().enumerate() {
        prefix[i + 1] = prefix[i] + v as f64;
    }
    let half = (ADAPT_HALF_SECONDS * rate) as usize;
    let mut detail: Vec<f64> = (0..n)
        .map(|i| {
            let lo = i.saturating_sub(half);
            let hi = (i + half + 1).min(n);
            (onset[i] as f64 - (prefix[hi] - prefix[lo]) / (hi - lo) as f64).max(0.0)
        })
        .collect();
    let mean = detail.iter().sum::<f64>() / n as f64;
    let spread = (detail.iter().map(|d| (d - mean).powi(2)).sum::<f64>() / n as f64).sqrt();
    if spread <= f64::EPSILON {
        return Vec::new();
    }
    for d in &mut detail {
        *d /= spread;
    }

    // score[t]: the best chain of beats ending in a beat at t. back[t]: the beat before it.
    let reach_lo = (period / 2.0).round().max(1.0) as usize;
    let reach_hi = (period * 2.0).round() as usize;
    let mut score = vec![0.0f64; n];
    let mut back = vec![usize::MAX; n];
    for t in 0..n {
        let mut best = 0.0;
        let mut from = usize::MAX;
        if t >= reach_lo {
            let first = t.saturating_sub(reach_hi);
            for tau in first..=t - reach_lo {
                let gap = (t - tau) as f64 / period;
                let s = score[tau] - TIGHTNESS * gap.ln().powi(2);
                if from == usize::MAX || s > best {
                    best = s;
                    from = tau;
                }
            }
        }
        // A chain may also start here, from nothing.
        if best < 0.0 {
            best = 0.0;
            from = usize::MAX;
        }
        score[t] = detail[t] + best;
        back[t] = from;
    }

    // End on the best beat in the last period, then walk back.
    let tail = n.saturating_sub(period.ceil() as usize);
    let mut at = (tail..n)
        .max_by(|&a, &b| score[a].total_cmp(&score[b]))
        .unwrap_or(n - 1);
    let mut beats = vec![at];
    while back[at] != usize::MAX {
        at = back[at];
        beats.push(at);
    }
    beats.reverse();
    beats.into_iter().map(|i| i as f64 / rate).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::TempoTracker;

    const RATE: u32 = 16_000;

    /// A click (a short burst of noise) at each of `times`, `seconds` long, mono.
    fn clicks(times: &[f64], seconds: f64) -> Vec<i16> {
        let mut pcm = vec![0i16; (seconds * RATE as f64) as usize];
        let mut seed = 0x1234_5678u32;
        for &t in times {
            let at = (t * RATE as f64) as usize;
            for s in pcm.iter_mut().skip(at).take(RATE as usize / 50) {
                seed ^= seed << 13;
                seed ^= seed >> 17;
                seed ^= seed << 5;
                *s = ((seed >> 16) as i16) / 2;
            }
        }
        pcm
    }

    fn beats_of(pcm: &[i16]) -> (f32, Vec<f64>) {
        let mut tracker = TempoTracker::new(RATE, 1).keep_history();
        tracker.push(pcm);
        let bpm = tracker.tempo().expect("a tempo").bpm;
        (
            bpm,
            track(tracker.history(), tracker.envelope_rate(), bpm as f64),
        )
    }

    /// How far the nearest found beat is from each true one, worst case, over the middle of the
    /// song (the first and last beats can fall either side of the ends).
    fn worst_miss(truth: &[f64], found: &[f64]) -> f64 {
        truth[2..truth.len() - 2]
            .iter()
            .map(|t| {
                found
                    .iter()
                    .map(|f| (f - t).abs())
                    .fold(f64::INFINITY, f64::min)
            })
            .fold(0.0, f64::max)
    }

    #[test]
    fn a_steady_pulse_is_found_beat_for_beat() {
        let truth: Vec<f64> = (0..120).map(|k| 0.37 + k as f64 * 0.5).collect();
        let (bpm, found) = beats_of(&clicks(&truth, 61.0));
        assert!((bpm - 120.0).abs() < 1.0, "{bpm}");
        let miss = worst_miss(&truth, &found);
        assert!(miss < 0.015, "worst miss {miss:.3} s");
        // One found beat per true beat, give or take the ends.
        assert!(
            (found.len() as i64 - truth.len() as i64).abs() <= 2,
            "{}",
            found.len()
        );
    }

    /// A band speeding up from 116 to 124 BPM over two minutes. A grid laid from one tempo and
    /// phase would be most of a beat out by the end; tracked beats stay on the clicks.
    #[test]
    fn a_drifting_tempo_is_followed() {
        let mut truth = vec![0.2];
        while *truth.last().unwrap() < 118.0 {
            let t = *truth.last().unwrap();
            let bpm = 116.0 + 8.0 * t / 120.0;
            truth.push(t + 60.0 / bpm);
        }
        let (_, found) = beats_of(&clicks(&truth, 120.0));
        let miss = worst_miss(&truth, &found);
        assert!(miss < 0.02, "worst miss {miss:.3} s");
    }

    /// Bars with nothing on the beat (a break) keep the grid going at the tempo.
    #[test]
    fn a_gap_in_the_drums_keeps_the_grid() {
        let all: Vec<f64> = (0..100).map(|k| 0.1 + k as f64 * 0.6).collect();
        let played: Vec<f64> = all
            .iter()
            .copied()
            .filter(|t| !(25.0..31.0).contains(t))
            .collect();
        let (_, found) = beats_of(&clicks(&played, 60.5));
        let in_gap: Vec<_> = found.iter().filter(|t| (25.0..31.0).contains(*t)).collect();
        assert!((9..=11).contains(&in_gap.len()), "{in_gap:?}");
        let miss = worst_miss(&all, &found);
        assert!(miss < 0.03, "worst miss {miss:.3} s");
    }

    #[test]
    fn nothing_to_track_gives_no_beats() {
        assert!(track(&[], 200.0, 120.0).is_empty());
        assert!(track(&[0.0; 4000], 200.0, 120.0).is_empty());
        assert!(track(&[1.0; 4000], 200.0, 0.0).is_empty());
    }
}
