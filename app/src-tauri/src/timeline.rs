//! What the lyric editor's timeline draws besides the lyrics: how loud the song is, moment by
//! moment, and the words the speech engine heard in it. Lines are timed by eye against both — a
//! line starts where the singing does, and a verse ends where the loudness drops away.
//! See `plans/lyrics-timeline.md` and `plans/lyric-sublines.md`.

use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Manager};

/// Loudness values per second. Fine enough to place a word by eye at full zoom.
pub const RATE: u32 = 100;

/// The quietest level drawn, in dB below full scale. Anything quieter is silence on screen.
const FLOOR_DB: f64 = 60.0;

/// The last envelope worked out, so reopening the editor on the same song is instant.
#[derive(Default)]
pub struct TimelineCtl {
    last: Mutex<Option<(String, Arc<Envelope>)>>,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Envelope {
    /// The track it belongs to, so the editor can tell it is still the one it is editing.
    pub title: String,
    pub artist: String,
    /// Values per second.
    pub rate: u32,
    /// Loudness, 0 = the floor or below, 255 = full scale, on a decibel scale.
    pub levels: Vec<u8>,
    /// The same, of the vocal range only ([`VOICE_LOW_HZ`]–[`VOICE_HIGH_HZ`]): the kick, the
    /// bass and the cymbals filtered out, so the bumps are mostly the singing.
    pub voice: Vec<u8>,
    /// Seconds where the vocal range gets sharply louder: where sung words tend to start.
    pub voice_onsets: Vec<f32>,
    /// The song's tempo, when it has a steady one.
    pub bpm: Option<f32>,
    /// Seconds of every beat, tracked through the song (empty without a tempo).
    pub beats: Vec<f32>,
}

/// The loudness of the song playing now. Decoding a whole song takes a second or two, from
/// the song cache when it is there and from its stream otherwise.
#[tauri::command]
pub async fn track_envelope(app: AppHandle) -> Result<Arc<Envelope>, String> {
    let engine = app
        .state::<crate::native::NativeEngine>()
        .try_engine()
        .ok_or("Nothing is playing")?;
    let track = engine.now_playing().await.ok_or("Nothing is playing")?;
    let ctl = app.state::<TimelineCtl>();
    if let Some((id, env)) = ctl.last.lock().unwrap().as_ref() {
        if *id == track.pandora_id {
            return Ok(env.clone());
        }
    }
    let src = engine
        .cached_file(&track.pandora_id)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| track.audio_url.clone());
    let (title, artist) = (track.song_title.clone(), track.artist_name.clone());
    let env = tokio::task::spawn_blocking(move || {
        crate::autosync::decode_16k(&src).map(|pcm| analyse(title, artist, &samples(&pcm)))
    })
    .await
    .map_err(|e| e.to_string())??;
    let env = Arc::new(env);
    *ctl.last.lock().unwrap() = Some((track.pandora_id.clone(), env.clone()));
    Ok(env)
}

/// One word the speech engine heard.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HeardWord {
    pub text: String,
    pub start: f64,
    pub end: f64,
    /// Its confidence, 0–1; 1 where it wasn't kept.
    pub p: f32,
}

/// What the speech engine heard in a track, or nothing if it hasn't heard it.
#[tauri::command]
pub fn heard_words(
    app: AppHandle,
    artist: String,
    track: String,
    album: Option<String>,
) -> Vec<HeardWord> {
    let key = crate::lyrics::key_for(&artist, &track, album.as_deref());
    crate::autosync::heard(&app, &key)
        .unwrap_or_default()
        .into_iter()
        .map(|(text, start, end, p)| HeardWord {
            text,
            start,
            end,
            p,
        })
        .collect()
}

/// The sample rate everything here is worked at (what `decode_16k` gives).
const SAMPLE_RATE: u32 = 16_000;

/// The vocal range: below it the kick and the bass, above it the hats and cymbals. Snares and
/// guitars overlap it and partly stay; nothing short of separating the sources removes them.
pub const VOICE_LOW_HZ: f64 = 250.0;
pub const VOICE_HIGH_HZ: f64 = 3500.0;

/// How sharply the vocal range has to rise to count as an onset: about 6 dB within
/// [`ONSET_RISE_FRAMES`] (one level is 60/255 dB).
const ONSET_RISE: u8 = 26;
const ONSET_RISE_FRAMES: usize = 5;
/// Two onsets closer than this are one syllable's attack, not two.
const ONSET_MIN_GAP: f64 = 0.1;

/// Everything the timeline draws, from a song's 16 kHz mono samples.
fn analyse(title: String, artist: String, pcm: &[i16]) -> Envelope {
    let full: Vec<f64> = pcm.iter().map(|&s| s as f64 / 32768.0).collect();
    let voice = levels(&band_pass(&full, SAMPLE_RATE), SAMPLE_RATE);
    let mut tracker = audio::TempoTracker::new(SAMPLE_RATE, 1).keep_history();
    tracker.push(pcm);
    let tempo = tracker.tempo();
    let beats = tempo
        .map(|t| audio::beats::track(tracker.history(), tracker.envelope_rate(), t.bpm as f64))
        .unwrap_or_default();
    Envelope {
        title,
        artist,
        rate: RATE,
        levels: levels(&full, SAMPLE_RATE),
        voice_onsets: onsets(&voice),
        voice,
        bpm: tempo.map(|t| t.bpm),
        beats: beats.into_iter().map(|b| b as f32).collect(),
    }
}

/// 16-bit little-endian PCM as samples.
fn samples(pcm: &[u8]) -> Vec<i16> {
    pcm.as_chunks::<2>()
        .0
        .iter()
        .map(|&b| i16::from_le_bytes(b))
        .collect()
}

/// The RMS loudness of 16-bit little-endian mono `pcm`, [`RATE`] values per second, each mapped
/// from `-FLOOR_DB`..0 dBFS onto 0..255. (The app works from samples via [`analyse`].)
#[cfg(test)]
fn envelope(pcm: &[u8], sample_rate: u32) -> Vec<u8> {
    let x: Vec<f64> = samples(pcm).iter().map(|&s| s as f64 / 32768.0).collect();
    levels(&x, sample_rate)
}

/// [`envelope`] of samples already scaled to -1..1.
fn levels(x: &[f64], sample_rate: u32) -> Vec<u8> {
    let per = (sample_rate / RATE).max(1) as usize;
    x.chunks(per)
        .map(|w| {
            let rms = (w.iter().map(|s| s * s).sum::<f64>() / w.len() as f64).sqrt();
            let db = 20.0 * rms.max(1e-9).log10();
            (((db + FLOOR_DB) / FLOOR_DB).clamp(0.0, 1.0) * 255.0).round() as u8
        })
        .collect()
}

/// `x` through a 4th-order Butterworth high-pass at [`VOICE_LOW_HZ`] and a 4th-order
/// Butterworth low-pass at [`VOICE_HIGH_HZ`]: each a pair of biquads at the two Q values a
/// 4th-order Butterworth splits into.
fn band_pass(x: &[f64], sample_rate: u32) -> Vec<f64> {
    const QS: [f64; 2] = [0.541_196_1, 1.306_563];
    let mut y = x.to_vec();
    for q in QS {
        Biquad::new(VOICE_LOW_HZ, q, sample_rate, true).run(&mut y);
        Biquad::new(VOICE_HIGH_HZ, q, sample_rate, false).run(&mut y);
    }
    y
}

/// A second-order section (the RBJ cookbook's high- or low-pass), normalised so `a0` is 1.
struct Biquad {
    b: [f64; 3],
    a: [f64; 2],
}

impl Biquad {
    fn new(hz: f64, q: f64, sample_rate: u32, high: bool) -> Self {
        let w = 2.0 * std::f64::consts::PI * hz / sample_rate as f64;
        let (sin, cos) = w.sin_cos();
        let alpha = sin / (2.0 * q);
        let a0 = 1.0 + alpha;
        let (b0, b1) = if high {
            ((1.0 + cos) / 2.0, -(1.0 + cos))
        } else {
            ((1.0 - cos) / 2.0, 1.0 - cos)
        };
        Biquad {
            b: [b0 / a0, b1 / a0, b0 / a0],
            a: [-2.0 * cos / a0, (1.0 - alpha) / a0],
        }
    }

    /// Filter `x` in place (direct form I).
    fn run(&self, x: &mut [f64]) {
        let (mut x1, mut x2, mut y1, mut y2) = (0.0, 0.0, 0.0, 0.0);
        for s in x.iter_mut() {
            let y =
                self.b[0] * *s + self.b[1] * x1 + self.b[2] * x2 - self.a[0] * y1 - self.a[1] * y2;
            x2 = x1;
            x1 = *s;
            y2 = y1;
            y1 = y;
            *s = y;
        }
    }
}

/// Seconds where `levels` ([`RATE`] per second) rise by [`ONSET_RISE`] or more within
/// [`ONSET_RISE_FRAMES`]. Each is placed where the sound starts (just after the foot of its
/// rise), not at its top; of several within [`ONSET_MIN_GAP`], the sharpest is kept.
pub fn onsets(levels: &[u8]) -> Vec<f32> {
    // The rise into each frame from the quietest of the frames just before it, and where that was.
    let rise: Vec<(u8, usize)> = (0..levels.len())
        .map(|i| {
            let from = i.saturating_sub(ONSET_RISE_FRAMES);
            // The latest of equally quiet frames: the sound starts after it.
            let foot = (from..=i)
                .min_by_key(|&k| (levels[k], std::cmp::Reverse(k)))
                .unwrap_or(i);
            (levels[i] - levels[foot], foot)
        })
        .collect();
    let gap = (ONSET_MIN_GAP * RATE as f64).round() as usize;
    let mut out: Vec<(usize, u8)> = Vec::new();
    for (i, &(r, foot)) in rise.iter().enumerate() {
        if r < ONSET_RISE {
            continue;
        }
        // Only the top of each rise: the strongest in its neighbourhood, the first of a tie.
        let lo = i.saturating_sub(ONSET_RISE_FRAMES);
        let hi = (i + ONSET_RISE_FRAMES + 1).min(rise.len());
        if (lo..hi).any(|k| rise[k].0 > r || (rise[k].0 == r && k < i)) {
            continue;
        }
        match out.last_mut() {
            Some(last) if foot < last.0 + gap => {
                if r > last.1 {
                    *last = (foot, r);
                }
            }
            _ => out.push((foot, r)),
        }
    }
    out.into_iter()
        .map(|(foot, _)| (foot + 1) as f32 / RATE as f32)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pcm(samples: impl IntoIterator<Item = i16>) -> Vec<u8> {
        samples.into_iter().flat_map(i16::to_le_bytes).collect()
    }

    #[test]
    fn silence_is_the_floor_and_full_scale_is_the_top() {
        let quiet = pcm(std::iter::repeat_n(0, 160));
        assert_eq!(envelope(&quiet, 16_000), [0]);
        // A full-scale square wave has an RMS of full scale.
        let loud = pcm((0..160).map(|i| if i % 2 == 0 { i16::MAX } else { -i16::MAX }));
        assert_eq!(envelope(&loud, 16_000), [255]);
    }

    /// A real song through Media Foundation: `JARLID_AUTOSYNC_TEST_AUDIO=<file.m4a> cargo test
    /// -- --ignored real_song`. Its quiet intro and loud chorus should both show.
    #[test]
    #[ignore = "needs an audio file; see the doc comment"]
    fn a_real_song_has_quiet_and_loud_parts() {
        let src =
            std::env::var("JARLID_AUTOSYNC_TEST_AUDIO").expect("set JARLID_AUTOSYNC_TEST_AUDIO");
        let levels = envelope(&crate::autosync::decode_16k(&src).unwrap(), 16_000);
        let mut sorted = levels.clone();
        sorted.sort();
        let (p10, p90) = (sorted[sorted.len() / 10], sorted[sorted.len() * 9 / 10]);
        eprintln!("{} values, p10 {p10}, p90 {p90}", levels.len());
        assert!(levels.len() > 60 * RATE as usize);
        assert!(p90 > 150 && p90 - p10 > 30, "p10 {p10}, p90 {p90}");
    }

    /// The whole analysis on a real song (same variable as above): a tempo, a beat about every
    /// 60/bpm seconds, and a few vocal onsets a second at most.
    #[test]
    #[ignore = "needs an audio file; see a_real_song_has_quiet_and_loud_parts"]
    fn a_real_song_has_a_beat_and_onsets() {
        let src =
            std::env::var("JARLID_AUTOSYNC_TEST_AUDIO").expect("set JARLID_AUTOSYNC_TEST_AUDIO");
        let pcm = samples(&crate::autosync::decode_16k(&src).unwrap());
        let began = std::time::Instant::now();
        let env = analyse(String::new(), String::new(), &pcm);
        let seconds = pcm.len() as f32 / SAMPLE_RATE as f32;
        eprintln!(
            "{seconds:.0} s analysed in {:?}: {:?} BPM, {} beats, {} vocal onsets",
            began.elapsed(),
            env.bpm,
            env.beats.len(),
            env.voice_onsets.len()
        );
        let bpm = env.bpm.expect("a tempo");
        let expected = seconds * bpm / 60.0;
        assert!((env.beats.len() as f32 - expected).abs() < expected * 0.1);
        assert!(env.voice_onsets.len() as f32 / seconds < 5.0);
    }

    /// A sine at `hz`, half a second, at half scale.
    fn tone(hz: f64) -> Vec<f64> {
        (0..SAMPLE_RATE as usize / 2)
            .map(|i| 0.5 * (2.0 * std::f64::consts::PI * hz * i as f64 / SAMPLE_RATE as f64).sin())
            .collect()
    }

    /// RMS past the filters' settling.
    fn rms(x: &[f64]) -> f64 {
        let x = &x[x.len() / 4..];
        (x.iter().map(|s| s * s).sum::<f64>() / x.len() as f64).sqrt()
    }

    #[test]
    fn the_voice_band_keeps_the_voice_and_drops_kick_and_cymbals() {
        let db = |hz: f64| {
            let x = tone(hz);
            20.0 * (rms(&band_pass(&x, SAMPLE_RATE)) / rms(&x)).log10()
        };
        for hz in [400.0, 1000.0, 2500.0] {
            assert!(db(hz) > -1.5, "{hz} Hz: {:.1} dB", db(hz));
        }
        // A kick's thump and a hi-hat's hiss are both well down.
        assert!(db(60.0) < -30.0, "60 Hz: {:.1} dB", db(60.0));
        assert!(db(7500.0) < -20.0, "7.5 kHz: {:.1} dB", db(7500.0));
    }

    #[test]
    fn an_onset_is_where_the_sound_starts() {
        // Quiet, then a word at 0.50 s that swells over 20 ms and holds; another at 1.20 s.
        let mut levels = vec![40u8; 200];
        for (at, top) in [(50usize, 200u8), (120, 180)] {
            levels[at] = 120;
            levels[at + 1] = 170;
            for l in levels.iter_mut().skip(at + 2).take(20) {
                *l = top;
            }
        }
        assert_eq!(onsets(&levels), [0.5, 1.2]);
    }

    #[test]
    fn a_wobble_is_not_an_onset_and_one_attack_is_one_onset() {
        let wobble: Vec<u8> = (0..300).map(|i| 150 + (i % 7) as u8 * 3).collect();
        assert!(onsets(&wobble).is_empty());
        // A rise in two steps 40 ms apart is one attack.
        let mut steps = vec![30u8; 100];
        for (i, l) in steps.iter_mut().enumerate().skip(20) {
            *l = if i < 24 { 90 } else { 200 };
        }
        assert_eq!(onsets(&steps), [0.2]);
    }

    #[test]
    fn one_value_per_hundredth_of_a_second() {
        let second = pcm(std::iter::repeat_n(1000, 16_000));
        let levels = envelope(&second, 16_000);
        assert_eq!(levels.len(), RATE as usize);
        // 1000/32768 is about -30 dBFS: halfway up a 60 dB scale.
        assert!((levels[0] as i32 - 128).abs() <= 2, "{}", levels[0]);
    }
}
