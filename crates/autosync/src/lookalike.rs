//! Letters that only look Latin, made Latin.
//!
//! Lyrics copied from the web sometimes carry Cyrillic or Greek letters that look exactly like
//! Latin ones (`mе` with a Cyrillic `е`), fullwidth letters, or invisible characters some sites
//! scatter through their text. On screen nothing is wrong; to anything that compares words
//! ("me" against what the speech engine heard, or a search) the word is a different one.
//!
//! [`fold`] replaces them with the plain letter. Real Cyrillic and Greek text is left alone: a
//! lookalike is only folded where it sits in Latin text, which is told by the line. A line with
//! any Cyrillic or Greek letter that has no Latin twin (`д`, `л`, `λ`) is in that script, and only
//! words that mix a lookalike into Latin letters are folded in it. In any other line every
//! lookalike is folded.

/// Cyrillic and Greek letters drawn the same as a Latin letter, and that letter.
const TWINS: &[(char, char)] = &[
    // Cyrillic, lowercase.
    ('а', 'a'),
    ('е', 'e'),
    ('о', 'o'),
    ('р', 'p'),
    ('с', 'c'),
    ('у', 'y'),
    ('х', 'x'),
    ('і', 'i'),
    ('ј', 'j'),
    ('ѕ', 's'),
    ('һ', 'h'),
    ('ԁ', 'd'),
    ('ԛ', 'q'),
    ('ԝ', 'w'),
    ('ӏ', 'l'),
    ('ɡ', 'g'),
    // Cyrillic, uppercase.
    ('А', 'A'),
    ('В', 'B'),
    ('Е', 'E'),
    ('К', 'K'),
    ('М', 'M'),
    ('Н', 'H'),
    ('О', 'O'),
    ('Р', 'P'),
    ('С', 'C'),
    ('Т', 'T'),
    ('Х', 'X'),
    ('У', 'Y'),
    ('І', 'I'),
    ('Ј', 'J'),
    ('Ѕ', 'S'),
    ('Ԛ', 'Q'),
    ('Ԝ', 'W'),
    // Greek.
    ('Α', 'A'),
    ('Β', 'B'),
    ('Ε', 'E'),
    ('Ζ', 'Z'),
    ('Η', 'H'),
    ('Ι', 'I'),
    ('Κ', 'K'),
    ('Μ', 'M'),
    ('Ν', 'N'),
    ('Ο', 'O'),
    ('Ρ', 'P'),
    ('Τ', 'T'),
    ('Υ', 'Y'),
    ('Χ', 'X'),
    ('ο', 'o'),
    ('ι', 'i'),
    ('κ', 'k'),
    ('ν', 'v'),
    ('υ', 'u'),
];

fn twin(c: char) -> Option<char> {
    TWINS.iter().find(|(from, _)| *from == c).map(|(_, to)| *to)
}

/// Characters with nothing to show, which some sites hide in their lyrics.
fn invisible(c: char) -> bool {
    matches!(
        c,
        '\u{200B}' | '\u{200C}' | '\u{200D}' | '\u{2060}' | '\u{FEFF}' | '\u{00AD}'
    )
}

/// Cyrillic or Greek, by block.
fn foreign(c: char) -> bool {
    matches!(c as u32, 0x0370..=0x03FF | 0x0400..=0x052F | 0x1F00..=0x1FFF)
}

/// Fullwidth letters and digits (`Ａ`, `ｅ`, `７`) as ASCII. Fullwidth punctuation and the
/// ideographic space stay: in Japanese or Chinese lyrics they are the right characters
/// (`何を騒いでるの？`), not lookalikes.
fn narrow(c: char) -> char {
    match c as u32 {
        0xFF10..=0xFF19 | 0xFF21..=0xFF3A | 0xFF41..=0xFF5A => {
            char::from_u32(c as u32 - 0xFF01 + 0x21).unwrap_or(c)
        }
        _ => c,
    }
}

/// `text` with lookalike letters made Latin, fullwidth ASCII made ASCII and invisible
/// characters removed, line by line (see the module docs). Unchanged text comes back as it was.
pub fn fold(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for (i, line) in text.split('\n').enumerate() {
        if i > 0 {
            out.push('\n');
        }
        fold_line(line, &mut out);
    }
    out
}

/// Whether [`fold`] would change `text`.
pub fn needs_fold(text: &str) -> bool {
    text.chars()
        .any(|c| invisible(c) || narrow(c) != c || twin(c).is_some())
        && fold(text) != text
}

fn fold_line(line: &str, out: &mut String) {
    let line: String = line
        .chars()
        .filter(|&c| !invisible(c))
        .map(narrow)
        .collect();
    // A letter of Cyrillic or Greek with no Latin twin: this line is in that script.
    let script = line
        .chars()
        .any(|c| c.is_alphabetic() && foreign(c) && twin(c).is_none());
    if !script {
        out.extend(line.chars().map(|c| twin(c).unwrap_or(c)));
        return;
    }
    // Only words that mix lookalikes into Latin letters.
    let mut word = String::new();
    let flush = |word: &mut String, out: &mut String| {
        let latin = word.chars().any(|c| c.is_ascii_alphabetic());
        let other = word
            .chars()
            .any(|c| c.is_alphabetic() && foreign(c) && twin(c).is_none());
        if latin && !other {
            out.extend(word.chars().map(|c| twin(c).unwrap_or(c)));
        } else {
            out.push_str(word);
        }
        word.clear();
    };
    for c in line.chars() {
        if c.is_alphabetic() {
            word.push(c);
        } else {
            flush(&mut word, out);
            out.push(c);
        }
    }
    flush(&mut word, out);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cyrillic_lookalikes_in_english_become_latin() {
        // Both from a real paste: "next to mе", "my livеr" with Cyrillic е (U+0435).
        assert_eq!(
            fold("Can't sleep if you’re not next to m\u{0435}"),
            "Can't sleep if you’re not next to me"
        );
        assert_eq!(
            fold("Dick goes up to my liv\u{0435}r"),
            "Dick goes up to my liver"
        );
        // A whole lookalike word in a Latin line: the article "а".
        assert_eq!(fold("I'm \u{0430} diamond"), "I'm a diamond");
    }

    #[test]
    fn real_cyrillic_and_greek_stay() {
        for s in ["Я тебя люблю", "Очи чёрные", "Σ' αγαπώ", "Он сказал: да"]
        {
            assert_eq!(fold(s), s);
        }
    }

    #[test]
    fn a_mixed_word_in_a_cyrillic_line_is_folded() {
        // The line is Russian; "lov\u{0435}" is an English word with one lookalike in it.
        assert_eq!(fold("люблю lov\u{0435} тебя"), "люблю love тебя");
    }

    #[test]
    fn invisible_and_fullwidth_characters() {
        assert_eq!(fold("ni\u{200B}ce gu\u{FEFF}ys"), "nice guys");
        assert_eq!(fold("ＮＩＣＥ ７"), "NICE 7");
        // From a real LRCLIB record: fullwidth punctuation is right in Japanese.
        let ja = "こんな風にしたの？ 決まってたことなの？";
        assert_eq!(fold(ja), ja);
    }

    #[test]
    fn line_by_line_and_unchanged_otherwise() {
        let s = "señorita, don’t go\nдай мне\n[00:01.00] fine";
        assert_eq!(fold(s), s);
        assert!(!needs_fold(s));
        assert!(needs_fold("m\u{0435}"));
        assert_eq!(fold("m\u{0435}\nдай"), "me\nдай");
    }
}
