//! DFM-driven window chrome: command mapping, menu bar / toolbar pruning and Delphi shortcuts.

use crate::dfm::Item;
use crate::settings::{SortKey, Units, ViewKind};
use eframe::egui::{Key, KeyboardShortcut, Modifiers};

/// Everything the menu bar and the toolbar can trigger.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Cmd {
    ParentFolder,
    ScanDir,
    Stop,
    Refresh,
    OpenLocation,
    SortBy(SortKey),
    SetUnits(Units),
    ToggleDetails,
    Exit,
    NewInstance,
    Filter,
    Options,
    About,
    ExpandLevel(u8),
    ExpandFull,
    ExcludeSelected,
    SetView(ViewKind),
    ToggleFast,
    RescanSelected,
    SnapshotSave,
    SnapshotCompare,
    NewFolder,
    RestartAdmin,
}

/// Map a DFM menu/toolbar item to a command, `None` when the clone has no equivalent.
pub fn cmd_for(item: &Item) -> Option<Cmd> {
    if let Some(a) = item.action.as_deref() {
        let c = match a {
            "ParentFolderAction" => Cmd::ParentFolder,
            "ScanDirectoryAction" => Cmd::ScanDir,
            "StopScanAction" => Cmd::Stop,
            "RefreshAction" => Cmd::Refresh,
            "OpenContainingFolderAction" => Cmd::OpenLocation,
            "SizeAction" | "SortBySizeAction" => Cmd::SortBy(SortKey::Size),
            "AllocatedAction" => Cmd::SortBy(SortKey::Alloc),
            "PercentAction" => Cmd::SortBy(SortKey::Percent),
            "FilesAction" => Cmd::SortBy(SortKey::Files),
            "SortByNameAction" => Cmd::SortBy(SortKey::Name),
            "ShowDetailsColumnsAction" => Cmd::ToggleDetails,
            "ExitAction" => Cmd::Exit,
            "NewInstanceAction" => Cmd::NewInstance,
            "FilterAction" => Cmd::Filter,
            "OptionsAction" => Cmd::Options,
            "AboutAction" => Cmd::About,
            "ExpandFullAction" => Cmd::ExpandFull,
            "ExcludePermanentlyAction" | "ExcludeTempAction" => Cmd::ExcludeSelected,
            _ => {
                let n = a.strip_prefix("ExpandLevel")?.strip_suffix("Action")?;
                Cmd::ExpandLevel(n.parse().ok()?)
            }
        };
        return Some(c);
    }
    let cap = crate::i18n::strip_accel(&item.caption);
    match cap.as_str() {
        "Values in Byte" => Some(Cmd::SetUnits(Units::Bytes)),
        "Values in KB" => Some(Cmd::SetUnits(Units::KB)),
        "Values in MB" => Some(Cmd::SetUnits(Units::MB)),
        "Values in GB" => Some(Cmd::SetUnits(Units::GB)),
        "Automatic Units" => Some(Cmd::SetUnits(Units::Auto)),
        _ => None,
    }
}

/// Keep only items that map to a command (or hold such items), dropping leading, trailing and
/// doubled separators.
pub fn pruned(items: &[Item]) -> Vec<Item> {
    let mut out: Vec<Item> = Vec::new();
    for it in items {
        if it.separator {
            if out.last().is_some_and(|l| !l.separator) {
                out.push(it.clone());
            }
            continue;
        }
        if it.children.is_empty() {
            if cmd_for(it).is_some() {
                out.push(it.clone());
            }
        } else {
            let kids = pruned(&it.children);
            if !kids.is_empty() {
                let mut c = it.clone();
                c.children = kids;
                out.push(c);
            }
        }
    }
    while out.last().is_some_and(|l| l.separator) {
        out.pop();
    }
    out
}

/// Delphi `TShortCut` (modifier bits | key) as egui shortcut. Only letters, digits, F1-F12 and
/// arrows/Delete/Backspace are translated.
pub fn to_egui_shortcut(sc: i64) -> Option<KeyboardShortcut> {
    if sc <= 0 {
        return None;
    }
    let vk = (sc & 0x0fff) as u32;
    let mods = Modifiers { shift: sc & 0x2000 != 0, ctrl: sc & 0x4000 != 0, alt: sc & 0x8000 != 0, ..Default::default() };
    let key = match vk {
        0x30..=0x39 | 0x41..=0x5a => Key::from_name(&char::from_u32(vk)?.to_string())?,
        0x70..=0x7b => Key::from_name(&format!("F{}", vk - 0x6f))?,
        0x25 => Key::ArrowLeft,
        0x26 => Key::ArrowUp,
        0x27 => Key::ArrowRight,
        0x28 => Key::ArrowDown,
        0x2e => Key::Delete,
        0x08 => Key::Backspace,
        _ => return None,
    };
    Some(KeyboardShortcut::new(mods, key))
}

/// Human readable shortcut ("Ctrl+Shift+B"), empty when the key is not translatable.
pub fn shortcut_text(sc: i64) -> String {
    let Some(s) = to_egui_shortcut(sc) else { return String::new() };
    let mut parts = Vec::new();
    if s.modifiers.ctrl {
        parts.push("Ctrl".to_string());
    }
    if s.modifiers.alt {
        parts.push("Alt".to_string());
    }
    if s.modifiers.shift {
        parts.push("Shift".to_string());
    }
    parts.push(match s.logical_key {
        Key::ArrowUp => "Up".to_string(),
        Key::ArrowDown => "Down".to_string(),
        Key::ArrowLeft => "Left".to_string(),
        Key::ArrowRight => "Right".to_string(),
        k => k.name().to_string(),
    });
    parts.join("+")
}

/// "Short|Long hint" (Delphi) to the displayed text.
pub fn hint_text(h: &str) -> &str {
    h.rsplit('|').next().unwrap_or(h)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dfm;

    #[test]
    fn pruned_menu_only_has_mapped_items_and_clean_separators() {
        let menu = pruned(&dfm::main_spec().menu);
        let tops: Vec<&str> = menu.iter().map(|m| m.caption.as_str()).collect();
        assert!(tops.contains(&"&File") && tops.contains(&"&View") && tops.contains(&"&Help"));
        fn check(items: &[Item]) {
            assert!(items.first().is_none_or(|i| !i.separator));
            assert!(items.last().is_none_or(|i| !i.separator));
            for w in items.windows(2) {
                assert!(!(w[0].separator && w[1].separator));
            }
            for i in items {
                if i.children.is_empty() && !i.separator {
                    assert!(cmd_for(i).is_some(), "{} unmapped", i.name);
                }
                check(&i.children);
            }
        }
        check(&menu);
        let file = menu.iter().find(|m| m.caption == "&File").unwrap();
        assert_eq!(cmd_for(&file.children[0]), Some(Cmd::Refresh));
        assert!(file.children.iter().any(|c| cmd_for(c) == Some(Cmd::Exit)));
    }

    #[test]
    fn toolbar_pruning_keeps_the_original_order() {
        let tb = pruned(&dfm::main_spec().toolbar);
        let cmds: Vec<Cmd> = tb.iter().filter_map(cmd_for).collect();
        assert_eq!(&cmds[..4], [Cmd::ParentFolder, Cmd::ScanDir, Cmd::Stop, Cmd::Refresh]);
        assert!(cmds.contains(&Cmd::SetUnits(Units::KB)));
        assert!(cmds.contains(&Cmd::SetUnits(Units::Auto)));
        assert!(cmds.contains(&Cmd::SortBy(SortKey::Alloc)));
    }

    #[test]
    fn expand_levels_parse() {
        let it = Item { action: Some("ExpandLevel3Action".into()), ..Default::default() };
        assert_eq!(cmd_for(&it), Some(Cmd::ExpandLevel(3)));
        let bad = Item { action: Some("ExpandLevelXAction".into()), ..Default::default() };
        assert_eq!(cmd_for(&bad), None);
    }

    #[test]
    fn delphi_shortcuts() {
        assert_eq!(shortcut_text(16464), "Ctrl+P");
        assert_eq!(shortcut_text(32883), "Alt+F4");
        assert_eq!(shortcut_text(32806), "Alt+Up");
        assert_eq!(shortcut_text(24642), "Ctrl+Shift+B");
        assert_eq!(shortcut_text(16433), "Ctrl+1");
        assert_eq!(shortcut_text(0), "");
        let s = to_egui_shortcut(32883).unwrap();
        assert!(s.modifiers.alt && s.logical_key == Key::F4);
    }

    #[test]
    fn hints_use_the_long_part() {
        assert_eq!(hint_text("File Count|Shows the number of files"), "Shows the number of files");
        assert_eq!(hint_text("Stop scanning"), "Stop scanning");
    }
}
