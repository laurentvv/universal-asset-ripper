//! Locale-aware formatting: sizes, numbers, dates. The pure functions take the locale explicitly
//! (testable without global state); the wrappers read the language chosen in the GUI.

use crate::settings::Units;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Loc {
    En,
    Fr,
}

static FRENCH: AtomicBool = AtomicBool::new(false);

/// Select the formatting locale from the catalogue code in effect ("fr", "fr-ca", "en", ...).
pub fn set_locale(code: &str) {
    FRENCH.store(code.to_ascii_lowercase().starts_with("fr"), Ordering::Relaxed);
}

pub fn loc() -> Loc {
    if FRENCH.load(Ordering::Relaxed) {
        Loc::Fr
    } else {
        Loc::En
    }
}

fn dec_sep(l: Loc) -> char {
    if l == Loc::Fr {
        ','
    } else {
        '.'
    }
}

fn group_sep(l: Loc) -> char {
    if l == Loc::Fr {
        '\u{a0}'
    } else {
        ','
    }
}

/// `1234567` -> "1,234,567" (en) / "1 234 567" with a no-break space (fr).
pub fn group_int_in(n: u64, l: Loc) -> String {
    let s = n.to_string();
    let mut out = String::with_capacity(s.len() + s.len() / 3);
    for (i, ch) in s.chars().enumerate() {
        if i > 0 && (s.len() - i).is_multiple_of(3) {
            out.push(group_sep(l));
        }
        out.push(ch);
    }
    out
}

pub fn group_int(n: u64) -> String {
    group_int_in(n, loc())
}

/// Fixed-decimals number with the locale's separators ("1 234,5" / "1,234.5").
pub fn decimal_in(v: f64, decimals: usize, l: Loc) -> String {
    let s = format!("{:.*}", decimals, v.max(0.0));
    let (int, frac) = s.split_once('.').unwrap_or((s.as_str(), ""));
    let int = group_int_in(int.parse().unwrap_or(0), l);
    if frac.is_empty() {
        int
    } else {
        format!("{int}{}{frac}", dec_sep(l))
    }
}

fn unit_names(l: Loc) -> [&'static str; 5] {
    match l {
        Loc::Fr => ["Octets", "Ko", "Mo", "Go", "To"],
        Loc::En => ["Bytes", "KB", "MB", "GB", "TB"],
    }
}

/// Format a size (`Auto` picks the largest unit that keeps the value >= 1), one decimal like TreeSize.
static DECIMALS: std::sync::atomic::AtomicU8 = std::sync::atomic::AtomicU8::new(1);

/// Decimals used for sizes (clamped to 0..=3).
pub fn set_decimals(n: u8) {
    DECIMALS.store(n.min(3), std::sync::atomic::Ordering::Relaxed);
}

fn decimals() -> usize {
    DECIMALS.load(std::sync::atomic::Ordering::Relaxed) as usize
}

pub fn format_bytes_in(bytes: u64, units: Units, l: Loc) -> String {
    format_bytes_dec(bytes, units, l, decimals())
}

/// `format_bytes_in` with an explicit number of decimals.
pub fn format_bytes_dec(bytes: u64, units: Units, l: Loc, dec: usize) -> String {
    let names = unit_names(l);
    let fixed = match units {
        Units::Auto => None,
        Units::Bytes => return format!("{} {}", group_int_in(bytes, l), names[0]),
        Units::KB => Some(1),
        Units::MB => Some(2),
        Units::GB => Some(3),
        Units::TB => Some(4),
    };
    match fixed {
        Some(i) => format!("{} {}", decimal_in(bytes as f64 / 1024f64.powi(i), dec, l), names[i as usize]),
        None => {
            if bytes < 1024 {
                return format!("{} {}", group_int_in(bytes, l), names[0]);
            }
            let mut v = bytes as f64;
            let mut i = 0;
            while v >= 1024.0 && i < names.len() - 1 {
                v /= 1024.0;
                i += 1;
            }
            format!("{} {}", decimal_in(v, dec, l), names[i])
        }
    }
}

/// Whole-number size in the best unit ("101 GB"), as in the status bar's free-space text.
pub fn format_bytes_short_in(bytes: u64, l: Loc) -> String {
    let names = unit_names(l);
    let mut v = bytes as f64;
    let mut i = 0;
    while v >= 1024.0 && i < names.len() - 1 {
        v /= 1024.0;
        i += 1;
    }
    format!("{} {}", group_int_in(v.round() as u64, l), names[i])
}

/// Percentage with the locale's decimal separator ("40,7 %" / "40.7%").
pub fn percent_in(frac: f64, l: Loc) -> String {
    let v = decimal_in(frac * 100.0, 1, l);
    if l == Loc::Fr {
        format!("{v} %")
    } else {
        format!("{v}%")
    }
}

pub fn percent(frac: f64) -> String {
    percent_in(frac, loc())
}

/// Convert a Windows short-date pattern ("M/d/yyyy", "dd.MM.yyyy") to a chrono format string.
pub fn short_date_to_chrono(pat: &str) -> String {
    let c: Vec<char> = pat.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < c.len() {
        let ch = c[i];
        let mut n = 1;
        while i + n < c.len() && c[i + n] == ch {
            n += 1;
        }
        match ch {
            'd' => out.push_str(match n {
                1 => "%-d",
                2 => "%d",
                3 => "%a",
                _ => "%A",
            }),
            'M' => out.push_str(match n {
                1 => "%-m",
                2 => "%m",
                3 => "%b",
                _ => "%B",
            }),
            'y' => out.push_str(if n <= 2 { "%y" } else { "%Y" }),
            '\'' => {
                let mut j = i + 1;
                while j < c.len() && c[j] != '\'' {
                    out.push(c[j]);
                    j += 1;
                }
                n = j + 1 - i;
            }
            '%' => out.push_str("%%"),
            _ => out.extend(std::iter::repeat_n(ch, n)),
        }
        i += n;
    }
    out
}

#[cfg(windows)]
fn system_short_date() -> Option<String> {
    use windows_sys::Win32::Globalization::GetLocaleInfoEx;
    const LOCALE_SSHORTDATE: u32 = 0x1F;
    let mut buf = [0u16; 80];
    // SAFETY: a null locale name means the user default; `buf` is valid for its length.
    let n = unsafe { GetLocaleInfoEx(std::ptr::null(), LOCALE_SSHORTDATE, buf.as_mut_ptr(), buf.len() as i32) };
    (n > 1).then(|| String::from_utf16_lossy(&buf[..n as usize - 1]))
}

#[cfg(not(windows))]
fn system_short_date() -> Option<String> {
    None
}

fn system_date_format() -> &'static str {
    static F: OnceLock<String> = OnceLock::new();
    F.get_or_init(|| system_short_date().map(|p| short_date_to_chrono(&p)).unwrap_or_else(|| "%Y-%m-%d".into()))
}

/// Date only: dd/mm/yyyy in French, the system short date otherwise.
pub fn format_date_with<Tz: chrono::TimeZone>(secs: i64, tz: &Tz, l: Loc, system_fmt: &str) -> String
where
    Tz::Offset: std::fmt::Display,
{
    if secs == 0 {
        return String::new();
    }
    let f = if l == Loc::Fr { "%d/%m/%Y" } else { system_fmt };
    tz.timestamp_opt(secs, 0).single().map(|t| t.format(f).to_string()).unwrap_or_default()
}

pub fn format_date(secs: i64) -> String {
    format_date_with(secs, &chrono::Local, loc(), system_date_format())
}

/// Date and time for lists and exports.
pub fn format_datetime_in<Tz: chrono::TimeZone>(secs: i64, tz: &Tz, l: Loc) -> String
where
    Tz::Offset: std::fmt::Display,
{
    if secs == 0 {
        return String::new();
    }
    let f = if l == Loc::Fr { "%d/%m/%Y %H:%M" } else { "%Y-%m-%d %H:%M" };
    tz.timestamp_opt(secs, 0).single().map(|t| t.format(f).to_string()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terabyte_unit_and_configurable_decimals() {
        let tb = 3 * 1024u64.pow(4) + 512 * 1024u64.pow(3);
        assert_eq!(format_bytes_dec(tb, Units::TB, Loc::En, 1), "3.5 TB");
        assert_eq!(format_bytes_dec(tb, Units::TB, Loc::Fr, 2), "3,50 To");
        assert_eq!(format_bytes_dec(tb, Units::GB, Loc::En, 0), "3,584 GB");
        assert_eq!(format_bytes_dec(1536, Units::Auto, Loc::En, 3), "1.500 KB");
        assert_eq!(format_bytes_dec(1536, Units::KB, Loc::En, 0), "2 KB");
        assert_eq!(format_bytes_dec(900, Units::Auto, Loc::En, 3), "900 Bytes");
    }

    #[test]
    fn grouping_and_decimals() {
        assert_eq!(group_int_in(104_671, Loc::En), "104,671");
        assert_eq!(group_int_in(104_671, Loc::Fr), "104\u{a0}671");
        assert_eq!(group_int_in(12, Loc::Fr), "12");
        assert_eq!(decimal_in(18.64, 1, Loc::Fr), "18,6");
        assert_eq!(decimal_in(18874.44, 1, Loc::En), "18,874.4");
        assert_eq!(percent_in(0.407, Loc::Fr), "40,7 %");
        assert_eq!(percent_in(0.407, Loc::En), "40.7%");
    }

    #[test]
    fn bytes_follow_the_language() {
        assert_eq!(format_bytes_in(512, Units::Auto, Loc::En), "512 Bytes");
        assert_eq!(format_bytes_in(512, Units::Auto, Loc::Fr), "512 Octets");
        assert_eq!(format_bytes_in(1536, Units::Auto, Loc::En), "1.5 KB");
        assert_eq!(format_bytes_in(1536, Units::Auto, Loc::Fr), "1,5 Ko");
        let g = (18.6 * 1024.0 * 1024.0 * 1024.0) as u64;
        assert_eq!(format_bytes_in(g, Units::Auto, Loc::Fr), "18,6 Go");
        assert_eq!(format_bytes_in(1536, Units::Bytes, Loc::En), "1,536 Bytes");
        assert_eq!(format_bytes_in(3 * 1024 * 1024, Units::KB, Loc::En), "3,072.0 KB");
        assert_eq!(format_bytes_in(1024 * 1024 * 1024, Units::MB, Loc::Fr), "1\u{a0}024,0 Mo");
        assert_eq!(format_bytes_in(1536 * 1024 * 1024, Units::GB, Loc::En), "1.5 GB");
        assert_eq!(format_bytes_in(10, Units::MB, Loc::En), "0.0 MB");
    }

    #[test]
    fn short_sizes_have_no_decimals() {
        let gb = 1024u64.pow(3);
        assert_eq!(format_bytes_short_in(101 * gb + gb / 3, Loc::En), "101 GB");
        assert_eq!(format_bytes_short_in(930 * gb, Loc::Fr), "930 Go");
        assert_eq!(format_bytes_short_in(10, Loc::Fr), "10 Octets");
    }

    #[test]
    fn windows_date_patterns() {
        assert_eq!(short_date_to_chrono("dd/MM/yyyy"), "%d/%m/%Y");
        assert_eq!(short_date_to_chrono("M/d/yyyy"), "%-m/%-d/%Y");
        assert_eq!(short_date_to_chrono("yyyy-MM-dd"), "%Y-%m-%d");
        assert_eq!(short_date_to_chrono("d. MMMM yyyy"), "%-d. %B %Y");
        assert_eq!(short_date_to_chrono("dd 'de' MMM"), "%d de %b");
    }

    #[test]
    fn dates_by_locale() {
        let t = 1_700_000_000;
        assert_eq!(format_date_with(t, &chrono::Utc, Loc::Fr, "%m/%d/%Y"), "14/11/2023");
        assert_eq!(format_date_with(t, &chrono::Utc, Loc::En, "%m/%d/%Y"), "11/14/2023");
        assert_eq!(format_date_with(0, &chrono::Utc, Loc::Fr, "%Y"), "");
        assert_eq!(format_datetime_in(t, &chrono::Utc, Loc::En), "2023-11-14 22:13");
        assert_eq!(format_datetime_in(t, &chrono::Utc, Loc::Fr), "14/11/2023 22:13");
    }
}
