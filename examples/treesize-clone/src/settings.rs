//! Persistent settings, stored as JSON in the user config dir.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum SortKey {
    Name,
    #[default]
    Size,
    Alloc,
    Percent,
    Files,
    Folders,
    Modified,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum ViewKind {
    #[default]
    Tree,
    Treemap,
    Chart,
    Types,
    Largest,
    Oldest,
    Duplicates,
}

/// Unit used to display sizes everywhere (tree, status bar, views, exports).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum Units {
    #[default]
    Auto,
    Bytes,
    KB,
    MB,
    GB,
}

impl Units {
    pub const ALL: [Units; 5] = [Units::Auto, Units::Bytes, Units::KB, Units::MB, Units::GB];

    pub fn to_u8(self) -> u8 {
        self as u8
    }

    pub fn from_u8(v: u8) -> Units {
        Units::ALL.get(v as usize).copied().unwrap_or_default()
    }
}

/// Which size drives the "% of parent" bar and the default sort.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum SizeMode {
    #[default]
    Size,
    Allocated,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum Theme {
    /// Follow the Windows app theme (light elsewhere).
    #[default]
    Auto,
    Light,
    Dark,
}

impl Theme {
    /// Effective darkness given the system preference.
    pub fn is_dark(self, system_dark: bool) -> bool {
        match self {
            Theme::Auto => system_dark,
            Theme::Light => false,
            Theme::Dark => true,
        }
    }
}

/// Windows "apps use dark theme" preference (`AppsUseLightTheme` == 0); false when unknown.
#[cfg(windows)]
pub fn system_dark() -> bool {
    use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD};
    let key: Vec<u16> = "Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize\0".encode_utf16().collect();
    let val: Vec<u16> = "AppsUseLightTheme\0".encode_utf16().collect();
    let (mut data, mut size) = (1u32, 4u32);
    // SAFETY: both names are NUL-terminated; `data`/`size` are valid out pointers for a DWORD.
    let rc = unsafe { RegGetValueW(HKEY_CURRENT_USER, key.as_ptr(), val.as_ptr(), RRF_RT_REG_DWORD, std::ptr::null_mut(), &mut data as *mut u32 as *mut _, &mut size) };
    rc == 0 && data == 0
}

#[cfg(not(windows))]
pub fn system_dark() -> bool {
    false
}

/// Last window geometry (logical points); `None` until the first save.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Default)]
pub struct WindowGeom {
    pub w: f32,
    pub h: f32,
    pub x: Option<f32>,
    pub y: Option<f32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub last_path: String,
    /// Excluded paths (absolute).
    pub excludes: Vec<String>,
    pub sort: SortKey,
    pub sort_desc: bool,
    pub view: ViewKind,
    /// Catalogue code ("fr", "pt-br", "en") or "auto" to follow the system language.
    pub language: String,
    pub fast_ntfs: bool,
    pub units: Units,
    pub show_allocated: bool,
    /// Show the Files / Folders / Last Modified columns.
    pub details: bool,
    pub size_mode: SizeMode,
    pub theme: Theme,
    pub window: Option<WindowGeom>,
    /// Tree column widths by column (the last, flexible column is not stored).
    pub col_widths: Vec<(SortKey, f32)>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            last_path: String::new(),
            excludes: Vec::new(),
            sort: SortKey::Size,
            sort_desc: true,
            view: ViewKind::Tree,
            language: "auto".into(),
            fast_ntfs: false,
            units: Units::Auto,
            show_allocated: true,
            details: true,
            size_mode: SizeMode::Size,
            theme: Theme::Auto,
            window: None,
            col_widths: Vec::new(),
        }
    }
}

/// `%APPDATA%\treesize-clone` on Windows, `$XDG_CONFIG_HOME` or `~/.config` elsewhere.
pub fn config_dir() -> Option<PathBuf> {
    let base = if cfg!(windows) {
        std::env::var_os("APPDATA").map(PathBuf::from)
    } else {
        std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))
    };
    base.map(|b| b.join("treesize-clone"))
}

pub fn default_path() -> Option<PathBuf> {
    config_dir().map(|d| d.join("settings.json"))
}

/// Load settings; a missing or corrupt file yields the defaults.
pub fn load_from(path: &Path) -> Settings {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save_to(path: &Path, s: &Settings) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let json = serde_json::to_string_pretty(s).map_err(std::io::Error::other)?;
    // Write then rename so a crash never leaves a truncated file.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json)?;
    std::fs::rename(&tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("sub/settings.json");
        let s = Settings {
            last_path: "C:\\Data".into(),
            excludes: vec!["C:\\Data\\tmp".into()],
            sort: SortKey::Modified,
            sort_desc: false,
            view: ViewKind::Treemap,
            language: "fr".into(),
            fast_ntfs: true,
            units: Units::MB,
            show_allocated: false,
            details: false,
            size_mode: SizeMode::Allocated,
            theme: Theme::Dark,
            window: Some(WindowGeom { w: 900.0, h: 600.0, x: Some(10.0), y: None }),
            col_widths: vec![(SortKey::Name, 321.0), (SortKey::Size, 77.5)],
        };
        save_to(&p, &s).unwrap();
        assert_eq!(load_from(&p), s);
    }

    #[test]
    fn missing_corrupt_and_partial_files_fall_back() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("s.json");
        assert_eq!(load_from(&p), Settings::default());
        std::fs::write(&p, "{ not json").unwrap();
        assert_eq!(load_from(&p), Settings::default());
        std::fs::write(&p, r#"{"last_path":"X:\\","unknown_future_field":1}"#).unwrap();
        let s = load_from(&p);
        assert_eq!(s.last_path, "X:\\");
        assert_eq!(s.language, "auto");
        assert_eq!(s.units, Units::Auto);
        assert!(s.show_allocated);
        assert!(s.sort_desc);
    }

    #[test]
    fn theme_auto_follows_the_system() {
        assert_eq!(Settings::default().theme, Theme::Auto);
        assert!(Theme::Auto.is_dark(true) && !Theme::Auto.is_dark(false));
        assert!(Theme::Dark.is_dark(false) && !Theme::Light.is_dark(true));
        let _ = system_dark(); // must not panic whatever the registry holds
    }

    #[test]
    fn units_u8_roundtrip() {
        for u in Units::ALL {
            assert_eq!(Units::from_u8(u.to_u8()), u);
        }
        assert_eq!(Units::from_u8(200), Units::Auto);
    }

    #[test]
    fn config_dir_is_app_specific() {
        if let Some(d) = config_dir() {
            assert!(d.ends_with("treesize-clone"));
        }
    }
}
