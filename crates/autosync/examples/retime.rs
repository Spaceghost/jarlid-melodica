//! Retime a saved lyrics edit against what the engine heard ([`autosync::retime`]), and print
//! every line: its hint, the new time, where that came from, and the word starts.
//!
//! Run: cargo run --release -p autosync --example retime -- <override.json> <heard.json>
//! (`lyrics-overrides\<hash>.json` in the app's data dir, `lyrics-heard\<hash>.json` in its cache).

use autosync::retime::{retime, spans, Hinted, Params};
use autosync::words::{time_words, Params as WordParams};
use autosync::Heard;
use serde_json::Value;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [edit, heard] = &args[..] else {
        eprintln!("usage: retime <override.json> <heard.json>");
        std::process::exit(2);
    };
    let edit: Value = serde_json::from_str(&std::fs::read_to_string(edit).unwrap()).unwrap();
    let heard: Value = serde_json::from_str(&std::fs::read_to_string(heard).unwrap()).unwrap();
    let heard: Vec<Heard> = heard["heard"]
        .as_array()
        .unwrap()
        .iter()
        .map(|w| Heard {
            text: w[0].as_str().unwrap().into(),
            start: w[1].as_f64().unwrap(),
            end: w[2].as_f64().unwrap(),
            p: w[3].as_f64().unwrap_or(1.0) as f32,
        })
        .collect();
    let duration = edit["duration"].as_f64().unwrap_or(0.0);
    let synced = autosync::lookalike::fold(edit["synced"].as_str().unwrap());

    let raw: Vec<(Option<f64>, String)> = synced
        .lines()
        .map(|l| {
            let l = l.trim();
            match l.strip_prefix('[').and_then(|r| r.split_once(']')) {
                Some((stamp, rest)) => {
                    let (m, s) = stamp.split_once(':').unwrap();
                    let t = m.parse::<f64>().unwrap() * 60.0 + s.parse::<f64>().unwrap();
                    (Some(t), rest.trim().to_string())
                }
                None => (None, l.to_string()),
            }
        })
        .collect();
    let lines: Vec<Hinted> = raw
        .iter()
        .map(|(t, text)| Hinted { text, hint: *t })
        .collect();
    let r = retime(&lines, &heard, duration, &Params::default());
    let sp = spans(&lines, &r, duration);
    let w: Vec<_> = sp.iter().map(|(_, l)| l.clone()).collect();
    let placed = time_words(&w, &heard, &WordParams::default());
    println!(
        "offset {:+.2} s, coverage {:.0}%",
        r.offset,
        r.coverage * 100.0
    );
    let fmt = |t: Option<f64>| t.map_or("     -".into(), |t| format!("{t:6.2}"));
    for (i, (l, out)) in lines.iter().zip(&r.lines).enumerate() {
        let words = sp
            .iter()
            .position(|(k, _)| *k == i)
            .map(|k| {
                l.text
                    .split_whitespace()
                    .zip(&placed[k].starts)
                    .zip(&placed[k].heard)
                    .map(|((w, t), h)| format!("{w}@{t:.2}{}", if *h { "" } else { "~" }))
                    .collect::<Vec<_>>()
                    .join(" ")
            })
            .unwrap_or_else(|| l.text.to_string());
        println!(
            "{} -> {} {:<7} {}",
            fmt(l.hint),
            fmt(out.t),
            format!("{:?}", out.how),
            words
        );
    }
}
