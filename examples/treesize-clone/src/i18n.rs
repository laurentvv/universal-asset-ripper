//! Translation layer on top of the gettext catalogues extracted from the original program
//! (`assets/rcdata/data_LOCALE_*_DEFAULT.bin`, one GNU `.mo` per language).
//!
//! The catalogues are Delphi-style: most msgids carry a context separated by `\x04`, either a
//! resource-string number (`63203\x04Add new`) or `Form.Component.Property` (for example
//! `TMainForm.RefreshAction.Caption\x04&Refresh`). `tr` looks a plain English label up first by its
//! exact msgid and then by its text without context and without `&` accelerators; `tr_ctx` looks the
//! full contextual msgid up first (used for labels that come from the DFM). Anything missing falls
//! back to the English text, so labels invented by this clone simply stay English.

use std::collections::HashMap;
use std::sync::{Arc, RwLock};

macro_rules! loc {
    ($code:literal, $name:literal, $file:literal) => {
        Locale {
            code: $code,
            name: $name,
            data: include_bytes!(concat!("../assets/rcdata/data_LOCALE_", $file, "_DEFAULT.bin")),
        }
    };
}

/// One embedded catalogue.
pub struct Locale {
    pub code: &'static str,
    pub name: &'static str,
    pub data: &'static [u8],
}

pub static LOCALES: &[Locale] = &[
    loc!("af", "Afrikaans", "AF"),
    loc!("ar", "Arabic", "AR"),
    loc!("bg", "Bulgarian", "BG"),
    loc!("ca", "Catalan", "CA"),
    loc!("cs", "Czech", "CS"),
    loc!("da", "Danish", "DA"),
    loc!("de", "German", "DE"),
    loc!("el", "Greek", "EL"),
    loc!("es", "Spanish", "ES"),
    loc!("fi", "Finnish", "FI"),
    loc!("fr", "French", "FR"),
    loc!("gu", "Gujarati", "GU"),
    loc!("he", "Hebrew", "HE"),
    loc!("hi", "Hindi", "HI"),
    loc!("hr", "Croatian", "HR"),
    loc!("hu", "Hungarian", "HU"),
    loc!("id", "Indonesian", "ID"),
    loc!("it", "Italian", "IT"),
    loc!("ja", "Japanese", "JA"),
    loc!("ko", "Korean", "KO"),
    loc!("lt", "Lithuanian", "LT"),
    loc!("lv", "Latvian", "LV"),
    loc!("nl", "Dutch", "NL"),
    loc!("no", "Norwegian", "NO"),
    loc!("pl", "Polish", "PL"),
    loc!("pt-br", "Portuguese (Brazil)", "PT-BR"),
    loc!("pt", "Portuguese", "PT"),
    loc!("ro", "Romanian", "RO"),
    loc!("ru", "Russian", "RU"),
    loc!("sk", "Slovak", "SK"),
    loc!("sl", "Slovenian", "SL"),
    loc!("sq", "Albanian", "SQ"),
    loc!("sr", "Serbian", "SR"),
    loc!("sv", "Swedish", "SV"),
    loc!("th", "Thai", "TH"),
    loc!("tr", "Turkish", "TR"),
    loc!("uk", "Ukrainian", "UK"),
    loc!("vi", "Vietnamese", "VI"),
    loc!("zh-hans", "Chinese (Simplified)", "ZH-HANS"),
    loc!("zh-hant", "Chinese (Traditional)", "ZH-HANT"),
];

#[derive(Debug, Default)]
pub struct Catalog {
    exact: HashMap<String, String>,
    by_text: HashMap<String, String>,
    /// `nplurals` from the header (only recorded; plural msgids use their first form).
    pub nplurals: u32,
}

/// Remove Delphi `&` accelerators (`&&` is a literal ampersand). East-Asian catalogues write the
/// accelerator as a trailing `(&X)` (for example `ファイル(&F)`): that whole group is dropped.
pub fn strip_accel(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '(' && chars.get(i + 1) == Some(&'&') && chars.get(i + 2).is_some_and(|k| *k != '&' && !k.is_whitespace()) && chars.get(i + 3) == Some(&')') {
            i += 4;
            continue;
        }
        if c == '&' {
            if chars.get(i + 1) == Some(&'&') {
                out.push('&');
                i += 1;
            }
        } else {
            out.push(c);
        }
        i += 1;
    }
    out
}

fn rd32(d: &[u8], off: usize, big: bool) -> Result<u32, String> {
    let end = off.checked_add(4).ok_or("offset overflow")?;
    let b: [u8; 4] = d
        .get(off..end)
        .ok_or_else(|| format!("truncated at {off}"))?
        .try_into()
        .map_err(|_| "truncated")?;
    Ok(if big { u32::from_be_bytes(b) } else { u32::from_le_bytes(b) })
}

fn string_at(d: &[u8], table: usize, i: usize, big: bool) -> Result<&[u8], String> {
    let e = table.checked_add(i.checked_mul(8).ok_or("overflow")?).ok_or("overflow")?;
    let len = rd32(d, e, big)? as usize;
    let off = rd32(d, e + 4, big)? as usize;
    d.get(off..off.checked_add(len).ok_or("overflow")?).ok_or_else(|| format!("string {i} out of range"))
}

impl Catalog {
    /// Parse a GNU gettext `.mo` file (either byte order).
    pub fn parse(d: &[u8]) -> Result<Catalog, String> {
        if d.len() < 20 {
            return Err("too short for a .mo header".into());
        }
        let big = match u32::from_le_bytes([d[0], d[1], d[2], d[3]]) {
            0x9504_12de => false,
            0xde12_0495 => true,
            m => return Err(format!("bad magic 0x{m:08x}")),
        };
        let n = rd32(d, 8, big)? as usize;
        let orig = rd32(d, 12, big)? as usize;
        let trans = rd32(d, 16, big)? as usize;
        if n > d.len() / 8 {
            return Err("string count larger than the file".into());
        }
        let mut cat = Catalog { nplurals: 2, ..Default::default() };
        for i in 0..n {
            let key_raw = string_at(d, orig, i, big)?;
            let val_raw = string_at(d, trans, i, big)?;
            let first = |b: &[u8]| String::from_utf8_lossy(b.split(|&c| c == 0).next().unwrap_or(b)).into_owned();
            let (key, val) = (first(key_raw), first(val_raw));
            if key.is_empty() {
                // Header entry: only nplurals is of interest.
                let header = String::from_utf8_lossy(val_raw).into_owned();
                if let Some(p) = header.lines().find_map(|l| l.strip_prefix("Plural-Forms:")) {
                    if let Some(v) = p.split(';').find_map(|kv| kv.trim().strip_prefix("nplurals=")) {
                        cat.nplurals = v.trim().parse().unwrap_or(2);
                    }
                }
                continue;
            }
            if val.is_empty() {
                continue;
            }
            let text = key.rsplit('\u{4}').next().unwrap_or(&key);
            cat.by_text.entry(strip_accel(text)).or_insert_with(|| strip_accel(&val));
            cat.exact.insert(key, val);
        }
        Ok(cat)
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.exact.len()
    }

    /// Exact msgid (with its context, if any); accelerators removed from the result.
    pub fn get_exact(&self, msgid: &str) -> Option<String> {
        self.exact.get(msgid).map(|v| strip_accel(v))
    }

    /// Plain English label, matched without context and without accelerators.
    pub fn get_text(&self, text: &str) -> Option<String> {
        self.by_text.get(&strip_accel(text)).cloned()
    }
}

static CURRENT: RwLock<Option<Arc<Catalog>>> = RwLock::new(None);
static CURRENT_CODE: RwLock<String> = RwLock::new(String::new());

/// Find an embedded locale by (case-insensitive) code.
pub fn find_locale(code: &str) -> Option<&'static Locale> {
    LOCALES.iter().find(|l| l.code.eq_ignore_ascii_case(code))
}

/// Select the active language. "en" or an unknown code clears the catalogue (English).
/// Returns the code actually in effect.
pub fn set_language(code: &str) -> String {
    let (cat, eff) = match find_locale(code) {
        Some(l) => match Catalog::parse(l.data) {
            Ok(c) => (Some(Arc::new(c)), l.code.to_string()),
            Err(_) => (None, "en".to_string()),
        },
        None => (None, "en".to_string()),
    };
    if let Ok(mut g) = CURRENT.write() {
        *g = cat;
    }
    if let Ok(mut g) = CURRENT_CODE.write() {
        g.clone_from(&eff);
    }
    eff
}

pub fn current_language() -> String {
    CURRENT_CODE.read().map(|g| if g.is_empty() { "en".into() } else { g.clone() }).unwrap_or_else(|_| "en".into())
}

fn with_catalog<R>(f: impl FnOnce(&Catalog) -> Option<R>) -> Option<R> {
    let guard = CURRENT.read().ok()?;
    f(guard.as_deref()?)
}

/// Translate a plain English label; unknown labels (and the English language) return the input
/// without accelerators.
pub fn tr(s: &str) -> String {
    with_catalog(|c| c.get_exact(s).or_else(|| c.get_text(s)))
        .or_else(|| if current_language().starts_with("fr") { crate::i18n_fr::lookup(s).map(str::to_string) } else { None })
        .unwrap_or_else(|| strip_accel(s))
}

/// Translate with a catalogue context (`TMainForm.RefreshAction.Caption`), falling back to `tr`.
pub fn tr_ctx(ctx: &str, s: &str) -> String {
    with_catalog(|c| c.get_exact(&format!("{ctx}\u{4}{s}"))).unwrap_or_else(|| tr(s))
}

/// Does the given catalogue know this plain English label? (README audit)
#[cfg(test)]
pub fn is_translated(code: &str, s: &str) -> bool {
    find_locale(code)
        .and_then(|l| Catalog::parse(l.data).ok())
        .is_some_and(|c| c.get_exact(s).or_else(|| c.get_text(s)).is_some())
}

/// Map a raw locale string (`fr-FR`, `pt_BR.UTF-8`, `zh-TW`, `nb_NO`) to a catalogue code or "en".
pub fn match_locale(raw: &str) -> String {
    let lower = raw.trim().to_ascii_lowercase();
    let base = lower.split(['.', '@']).next().unwrap_or("").replace('_', "-");
    if base.is_empty() || base == "c" || base == "posix" {
        return "en".into();
    }
    let mut parts = base.split('-');
    let lang = parts.next().unwrap_or("");
    let rest: Vec<&str> = parts.collect();
    let cand = match lang {
        "zh" => {
            if rest.iter().any(|p| ["hant", "tw", "hk", "mo"].contains(p)) {
                "zh-hant"
            } else {
                "zh-hans"
            }
        }
        "pt" => {
            if rest.contains(&"br") {
                "pt-br"
            } else {
                "pt"
            }
        }
        "nb" | "nn" | "no" => "no",
        "iw" => "he",
        "in" => "id",
        other => other,
    };
    find_locale(cand).map_or_else(|| "en".to_string(), |l| l.code.to_string())
}

/// System UI language as a catalogue code or "en".
pub fn detect_system_language() -> String {
    #[cfg(windows)]
    {
        let mut buf = [0u16; 85];
        // SAFETY: the buffer is valid for 85 u16 and we pass its exact length.
        let n = unsafe { windows_sys::Win32::Globalization::GetUserDefaultLocaleName(buf.as_mut_ptr(), buf.len() as i32) };
        if n > 1 {
            return match_locale(&String::from_utf16_lossy(&buf[..(n as usize - 1)]));
        }
        "en".into()
    }
    #[cfg(not(windows))]
    {
        for k in ["LC_ALL", "LC_MESSAGES", "LANG"] {
            if let Ok(v) = std::env::var(k) {
                if !v.is_empty() {
                    return match_locale(&v);
                }
            }
        }
        "en".into()
    }
}

/// Settings value ("auto", "", "fr", unknown...) to the code that will be applied.
pub fn resolve_language(setting: &str) -> String {
    let s = setting.trim();
    if s.is_empty() || s.eq_ignore_ascii_case("auto") {
        detect_system_language()
    } else {
        match_locale(s)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a minimal .mo in the requested byte order.
    fn build_mo(entries: &[(&str, &str)], big: bool) -> Vec<u8> {
        let w = |v: u32| if big { v.to_be_bytes() } else { v.to_le_bytes() };
        let n = entries.len() as u32;
        let (orig_tab, trans_tab) = (28u32, 28 + 8 * n);
        let mut data_off = 28 + 16 * n;
        let mut out = Vec::new();
        out.extend_from_slice(&w(0x9504_12de));
        for v in [0, n, orig_tab, trans_tab, 0, 0] {
            out.extend_from_slice(&w(v));
        }
        let mut blob = Vec::new();
        let mut tabs = [Vec::new(), Vec::new()];
        for (i, tab) in tabs.iter_mut().enumerate() {
            for e in entries {
                let s = if i == 0 { e.0 } else { e.1 };
                tab.extend_from_slice(&w(s.len() as u32));
                tab.extend_from_slice(&w(data_off));
                blob.extend_from_slice(s.as_bytes());
                blob.push(0);
                data_off += s.len() as u32 + 1;
            }
        }
        out.extend_from_slice(&tabs[0]);
        out.extend_from_slice(&tabs[1]);
        out.extend_from_slice(&blob);
        out
    }

    const SAMPLE: [(&str, &str); 4] = [
        ("", "Plural-Forms: nplurals=3; plural=n;\n"),
        ("Ctx.Btn.Caption\u{4}&Save", "&Sauver"),
        ("Hello", "Bonjour"),
        ("Empty", ""),
    ];

    #[test]
    fn parses_both_byte_orders() {
        for big in [false, true] {
            let mo = build_mo(&SAMPLE, big);
            if big {
                assert_eq!(&mo[..4], &[0x95, 0x04, 0x12, 0xde], "big-endian magic");
            } else {
                assert_eq!(&mo[..4], &[0xde, 0x12, 0x04, 0x95], "little-endian magic");
            }
            let c = Catalog::parse(&mo).unwrap_or_else(|e| panic!("big={big}: {e}"));
            assert_eq!(c.nplurals, 3);
            assert_eq!(c.get_exact("Hello").as_deref(), Some("Bonjour"));
            assert_eq!(c.get_exact("Ctx.Btn.Caption\u{4}&Save").as_deref(), Some("Sauver"));
            assert_eq!(c.get_text("Save").as_deref(), Some("Sauver"));
            assert_eq!(c.get_text("&Save").as_deref(), Some("Sauver"));
            assert!(c.get_exact("Empty").is_none(), "untranslated entries are ignored");
            assert_eq!(c.len(), 2);
        }
    }

    #[test]
    fn rejects_malformed_files() {
        assert!(Catalog::parse(b"short").is_err());
        let mut bad = build_mo(&SAMPLE, false);
        bad[0] = 0;
        assert!(Catalog::parse(&bad).unwrap_err().contains("magic"));
        let mut trunc = build_mo(&SAMPLE, false);
        trunc.truncate(60);
        assert!(Catalog::parse(&trunc).is_err());
        let mut huge = build_mo(&SAMPLE, false);
        huge[8..12].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(Catalog::parse(&huge).is_err());
    }

    #[test]
    fn plural_msgids_use_their_first_form() {
        let mo = build_mo(&[("one file\0%d files", "un fichier\0%d fichiers")], false);
        let c = Catalog::parse(&mo).unwrap();
        assert_eq!(c.get_exact("one file").as_deref(), Some("un fichier"));
    }

    #[test]
    fn strip_accel_handles_ampersands() {
        assert_eq!(strip_accel("&File"), "File");
        assert_eq!(strip_accel("A&nd && more"), "And & more");
        assert_eq!(strip_accel("plain"), "plain");
        assert_eq!(strip_accel("ファイル(&F)"), "ファイル");
        assert_eq!(strip_accel("Save (&& more)"), "Save (& more)");
        assert_eq!(strip_accel("Edit (&Ab)"), "Edit (Ab)");
    }

    #[test]
    fn every_embedded_locale_parses() {
        assert_eq!(LOCALES.len(), 40);
        let mut total = 0;
        for l in LOCALES {
            let c = Catalog::parse(l.data).unwrap_or_else(|e| panic!("{}: {e}", l.code));
            assert!(c.nplurals >= 1, "{}", l.code);
            total += c.len();
            // Some catalogues of the original program are partial (Thai is header-only).
            if ["fr", "de", "es", "it", "ja", "ru", "zh-hans"].contains(&l.code) {
                assert!(c.len() > 1500, "{} has only {} entries", l.code, c.len());
            }
        }
        assert!(total > 50_000, "{total}");
    }

    #[test]
    fn known_msgids_in_french_and_german() {
        let fr = Catalog::parse(find_locale("fr").unwrap().data).unwrap();
        assert_eq!(fr.get_exact("TMainForm.RefreshAction.Caption\u{4}&Refresh").as_deref(), Some("Rafraîchir"));
        assert_eq!(fr.get_exact("TMainForm.FileMenu.Caption\u{4}&File").as_deref(), Some("Fichier"));
        assert_eq!(fr.get_text("Name").as_deref(), Some("Nom"));
        assert_eq!(fr.get_text("Folders").as_deref(), Some("Dossiers"));
        let de = Catalog::parse(find_locale("de").unwrap().data).unwrap();
        assert_eq!(de.get_exact("TMainForm.RefreshAction.Caption\u{4}&Refresh").as_deref(), Some("Aktualisieren"));
        assert_eq!(de.get_exact("TMainForm.FileMenu.Caption\u{4}&File").as_deref(), Some("Datei"));
        assert!(de.get_text("Size").is_some());
    }

    #[test]
    fn global_tr_with_fallback() {
        // The only test touching the global language, to stay race-free.
        assert_eq!(set_language("en"), "en");
        assert_eq!(tr("Name"), "Name");
        assert_eq!(tr("&Refresh"), "Refresh");
        assert_eq!(set_language("FR"), "fr");
        assert_eq!(current_language(), "fr");
        assert_eq!(tr("Name"), "Nom");
        assert_eq!(tr_ctx("TMainForm.RefreshAction.Caption", "&Refresh"), "Rafraîchir");
        assert_eq!(tr("Totally invented label 42"), "Totally invented label 42");
        assert_eq!(tr_ctx("Nope.Nope.Caption", "Name"), "Nom");
        assert_eq!(set_language("xx"), "en");
        assert_eq!(tr("Name"), "Name");
    }

    #[test]
    fn locale_matching() {
        assert_eq!(match_locale("fr-FR"), "fr");
        assert_eq!(match_locale("fr_CA.UTF-8"), "fr");
        assert_eq!(match_locale("pt-BR"), "pt-br");
        assert_eq!(match_locale("pt_PT"), "pt");
        assert_eq!(match_locale("zh-CN"), "zh-hans");
        assert_eq!(match_locale("zh-Hans-CN"), "zh-hans");
        assert_eq!(match_locale("zh-TW"), "zh-hant");
        assert_eq!(match_locale("zh-Hant-HK"), "zh-hant");
        assert_eq!(match_locale("nb_NO"), "no");
        assert_eq!(match_locale("en-US"), "en");
        assert_eq!(match_locale("C"), "en");
        assert_eq!(match_locale(""), "en");
        assert_eq!(match_locale("xx-YY"), "en");
        assert_eq!(resolve_language("de"), "de");
        assert_eq!(resolve_language("garbage"), "en");
        assert!(!resolve_language("auto").is_empty());
    }

    #[test]
    fn translation_audit_of_ui_labels() {
        // Labels used by the UI that exist in the original catalogue (so they are translated).
        for l in ["Name", "Size", "Files", "Folders", "Options", "Export", "Refresh", "About"] {
            assert!(is_translated("fr", l), "{l}");
        }
        // Labels invented by this clone stay English.
        assert!(!is_translated("fr", "Totally invented label 42"));
    }
}
