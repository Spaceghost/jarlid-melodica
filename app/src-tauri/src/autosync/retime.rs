//! "Time the rest" in the lyric editor: every line and word of the edit on screen timed from what
//! the speech engine heard, the listener's own line times taken as strong hints
//! (`autosync::retime`), then word starts placed (`autosync::words`) and, with the forced aligner
//! installed and on, sharpened on the song's audio (`autosync::refine`).
//!
//! Nothing is saved here: the editor shows the result as an edit of its own, to review, undo or
//! save. See `plans/retime-lyrics.md`.

use std::time::Instant;

use autosync::retime::{Hinted, How};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use super::{component, decode_16k, file_stem, heard_words, sidecar, threads, work_dir, write_wav};
use super::{AutoSyncCtl, JobEvent};

/// One editor line, as it stands.
#[derive(Deserialize)]
pub struct EditorLine {
    pub text: String,
    pub t: Option<f64>,
}

/// One editor line, retimed.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetimedLine {
    pub t: Option<f64>,
    /// `hint`, `moved`, `heard`, `placed` or `none` (see `autosync::retime::How`).
    pub how: &'static str,
    /// Each word's start, by position in its whitespace-separated words; absent for a line of
    /// one word or none.
    pub words: Option<Vec<f64>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Retimed {
    pub lines: Vec<RetimedLine>,
    /// Seconds added to heard line starts to match how the listener stamps lines.
    pub offset: f64,
    /// Share of the lyric words found in what was heard.
    pub coverage: f64,
    /// Lines the forced aligner sharpened the words of, or `None` when it wasn't used, and why.
    pub sharpened: Option<usize>,
    pub unsharpened_why: Option<String>,
}

/// How long the last line is taken to last when the song's length isn't known.
const LAST_LINE_SECONDS: f64 = 6.0;

#[tauri::command]
pub async fn autosync_retime(
    app: AppHandle,
    artist: String,
    track: String,
    album: Option<String>,
    duration: Option<f64>,
    lines: Vec<EditorLine>,
) -> Result<Retimed, String> {
    let key = crate::lyrics::key_for(&artist, &track, album.as_deref());
    let heard = heard_words(&app, &key).ok_or(
        "The speech engine hasn't heard this song yet. With auto-sync on, play it through once, \
         then try again.",
    )?;
    let texts: Vec<String> = lines
        .iter()
        .map(|l| autosync::lookalike::fold(&l.text))
        .collect();
    let hinted: Vec<Hinted> = texts
        .iter()
        .zip(&lines)
        .map(|(text, l)| Hinted { text, hint: l.t })
        .collect();
    let duration = duration.filter(|d| *d > 0.0).unwrap_or(0.0);
    let r = autosync::retime::retime(&hinted, &heard, duration, &Default::default());
    let last_end = if duration > 0.0 {
        duration
    } else {
        r.lines.iter().filter_map(|l| l.t).fold(0.0, f64::max) + LAST_LINE_SECONDS
    };
    let spans = autosync::retime::spans(&hinted, &r, last_end);
    let word_lines: Vec<autosync::words::Line> = spans.iter().map(|(_, l)| l.clone()).collect();
    let mut placed =
        autosync::words::time_words(&word_lines, &heard, &autosync::words::Params::default());

    let (sharpened, why) = match sharpen(&app, &key, &word_lines, &placed, duration).await {
        Ok((refined, n)) => {
            placed = refined;
            (Some(n), None)
        }
        Err(why) => (None, Some(why)),
    };

    let mut out: Vec<RetimedLine> = r
        .lines
        .iter()
        .map(|l| RetimedLine {
            t: l.t,
            how: match l.how {
                How::Hint => "hint",
                How::Moved => "moved",
                How::Heard => "heard",
                How::Placed => "placed",
                How::None => "none",
            },
            words: None,
        })
        .collect();
    for ((i, line), lw) in spans.iter().zip(&placed) {
        if line.text.split_whitespace().nth(1).is_some() {
            out[*i].words = Some(lw.starts.clone());
        }
    }
    Ok(Retimed {
        lines: out,
        offset: r.offset,
        coverage: r.coverage,
        sharpened,
        unsharpened_why: why,
    })
}

/// `placed` refined by the forced aligner on the song's audio, and how many lines it had audio
/// for; or why it couldn't be.
async fn sharpen(
    app: &AppHandle,
    key: &str,
    lines: &[autosync::words::Line<'_>],
    placed: &[autosync::words::LineWords],
    duration: f64,
) -> Result<(Vec<autosync::words::LineWords>, usize), String> {
    let setting = crate::settings::get(app).auto_sync;
    if !setting.aligner {
        return Err("sharper word timing is off".into());
    }
    let installed = component::installed(app).ok_or("the speech engine isn't installed")?;
    let aligner = component::aligner_installed(app).ok_or("the aligner isn't installed")?;
    let (id, src) = audio_for(app, key)
        .await
        .ok_or("the song's audio isn't on this machine: play it, then try again")?;

    // One job per track at a time, shared with auto-sync's own.
    {
        let ctl = app.state::<AutoSyncCtl>();
        let mut jobs = ctl.jobs.lock().unwrap();
        if jobs.contains_key(&id) {
            return Err("auto-sync is busy with this song: try again in a moment".into());
        }
        jobs.insert(id.clone(), ());
    }
    let result = emit_and_refine(
        app,
        &installed,
        &aligner,
        &id,
        &src,
        lines,
        placed,
        duration,
        setting.gpu,
    )
    .await;
    app.state::<AutoSyncCtl>().jobs.lock().unwrap().remove(&id);
    result
}

#[allow(clippy::too_many_arguments)]
async fn emit_and_refine(
    app: &AppHandle,
    installed: &component::Installed,
    aligner: &component::AlignerInstalled,
    id: &str,
    src: &str,
    lines: &[autosync::words::Line<'_>],
    placed: &[autosync::words::LineWords],
    duration: f64,
    gpu: bool,
) -> Result<(Vec<autosync::words::LineWords>, usize), String> {
    let todo: Vec<usize> = (0..lines.len())
        .filter(|&i| lines[i].text.split_whitespace().nth(1).is_some())
        .collect();
    if todo.is_empty() {
        return Ok((placed.to_vec(), 0));
    }
    let dir = work_dir(app).ok_or("no cache directory")?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let wav = dir.join(format!("{}.retime.wav", file_stem(id)));
    {
        let (src, wav) = (src.to_string(), wav.clone());
        tokio::task::spawn_blocking(move || write_wav(&decode_16k(&src)?, &wav))
            .await
            .map_err(|e| e.to_string())??;
    }
    let spans: Vec<(f64, f64)> = todo
        .iter()
        .map(|&i| autosync::refine::window(&lines[i], duration))
        .collect();
    let began = Instant::now();
    let result = async {
        let sidecar = sidecar(app, installed, gpu).await?;
        {
            let (s, a) = (sidecar.clone(), aligner.clone());
            tokio::task::spawn_blocking(move || s.load_aligner(&a, threads()))
                .await
                .map_err(|e| e.to_string())??;
        }
        let mut rx = sidecar.emit(id, &wav, &spans)?;
        let mut emissions: Vec<Option<autosync::refine::LineEmission>> = vec![None; lines.len()];
        loop {
            match rx.recv().await {
                Some(JobEvent::Emission { k, emission }) => {
                    if let Some(&i) = todo.get(k) {
                        emissions[i] = emission;
                    }
                }
                Some(JobEvent::Done) => break,
                Some(JobEvent::Cancelled) => return Err("cancelled".to_string()),
                Some(JobEvent::Error(e)) => return Err(e),
                Some(JobEvent::Words { .. }) => {}
                None => return Err("the speech engine went away".into()),
            }
        }
        let n = emissions.iter().filter(|e| e.is_some()).count();
        let refined = autosync::refine::refine(
            lines,
            placed,
            &emissions,
            &autosync::refine::Params::default(),
        );
        Ok((refined, n))
    }
    .await;
    let _ = std::fs::remove_file(&wav);
    if let Ok((_, n)) = &result {
        eprintln!(
            "[autosync] retime: words sharpened on {n} of {} lines in {:.0} s",
            todo.len(),
            began.elapsed().as_secs_f64()
        );
    }
    result
}

/// The Pandora id and audio (a cached file, or the stream while it plays) of the song filed
/// under `key`: the one playing, or one in the song cache.
async fn audio_for(app: &AppHandle, key: &str) -> Option<(String, String)> {
    let engine = app.state::<crate::native::NativeEngine>().try_engine()?;
    if let Some(t) = engine.now_playing().await {
        let k = crate::lyrics::key_for(&t.artist_name, &t.song_title, Some(&t.album_title));
        if k == key && !t.pandora_id.is_empty() {
            let src = engine
                .cached_file(&t.pandora_id)
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or(t.audio_url);
            return Some((t.pandora_id, src));
        }
    }
    engine.all_saved_songs().await.into_iter().find_map(|l| {
        let s = l.song;
        let k = crate::lyrics::key_for(&s.artist, &s.title, Some(&s.album));
        (k == key)
            .then(|| engine.cached_file(&s.id))
            .flatten()
            .map(|p| (s.id, p.to_string_lossy().into_owned()))
    })
}
