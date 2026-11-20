use pandora::models::Track;
use serde_json::json;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

#[derive(Default)]
pub struct Listens {
    current: String,
    previous: Option<(Instant, f64)>,
    started: u64,
    heard: f64,
    now_sent: bool,
    final_sent: bool,
}

impl Listens {
    pub fn tick(&mut self, track: Option<&Track>, position: f64, paused: bool) {
        let Some(track) = track.filter(|t| {
            !t.track_token.is_empty() && !t.artist_name.is_empty() && !t.song_title.is_empty()
        }) else {
            *self = Self::default();
            return;
        };
        let Ok(token) = std::env::var("MELODICA_SCROBBLE_TOKEN") else {
            return;
        };
        if token.trim().is_empty() {
            return;
        }
        let now = Instant::now();
        if self.current != track.track_token {
            *self = Self {
                current: track.track_token.clone(),
                started: SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs(),
                ..Self::default()
            };
        }
        let previous = self.previous.replace((now, position));
        if paused || position <= 0.0 {
            return;
        }
        if let Some((when, old)) = previous {
            let elapsed = now.duration_since(when).as_secs_f64();
            let step = position - old;
            if step > 0.0 && elapsed < 8.0 && step <= elapsed + 0.5 {
                self.heard += step.min(elapsed);
            }
        }
        let duration = track.track_length as f64;
        let kind = if !self.now_sent {
            self.now_sent = true;
            "playing_now"
        } else if !self.final_sent && duration > 30.0 && self.heard >= (duration / 2.0).min(240.0) {
            self.final_sent = true;
            "single"
        } else {
            return;
        };
        let mut listen = json!({"track_metadata":{"artist_name":track.artist_name,"track_name":track.song_title,
            "release_name":track.album_title,"additional_info":{"submission_client":"Jarlid Melodica",
            "music_service":"pandora.com","duration_ms":track.track_length*1000}}});
        if kind == "single" {
            listen["listened_at"] = json!(self.started);
        }
        let body = json!({"listen_type":kind,"payload":[listen]});
        tauri::async_runtime::spawn(async move {
            let Ok(client) = reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(std::time::Duration::from_secs(8))
                .build()
            else {
                return;
            };
            let _ = client
                .post("https://spacegho.st/scrobble/1/submit-listens")
                .header("Authorization", format!("Token {}", token.trim()))
                .json(&body)
                .send()
                .await;
        });
    }
}
