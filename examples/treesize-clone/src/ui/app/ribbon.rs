//! Compact tabbed ribbon (File / Home / Scan / View / Options / Help). Tab, group and command
//! names follow the original `MAIN_RIBBON` markup (`TabHomeTitleAction`, `GrpModeTitleAction`,
//! `GrpUnitTitleAction`, `GrpFolderOperationsAction`, `GrpToolsTitleAction`, ...); the icons are
//! vector glyphs from `paint`.

use super::*;

fn cap(action: &str, english: &str) -> String {
    i18n::strip_accel(&tr_ctx(&format!("TMainForm.{action}.Caption"), english))
}

/// Split a button caption on a space so that it fits in two centred lines.
fn split_caption(ui: &egui::Ui, text: &str, font: &egui::FontId, max_w: f32) -> Vec<String> {
    let width = |t: &str| ui.painter().layout_no_wrap(t.to_string(), font.clone(), Color32::WHITE).size().x;
    if width(text) <= max_w {
        return vec![text.to_string()];
    }
    let mut best: Option<(f32, usize)> = None;
    for (i, ch) in text.char_indices() {
        if ch == ' ' {
            let w = width(&text[..i]).max(width(&text[i + 1..]));
            if best.is_none_or(|(bw, _)| w < bw) {
                best = Some((w, i));
            }
        }
    }
    match best {
        Some((_, i)) => vec![text[..i].to_string(), text[i + 1..].to_string()],
        None => {
            // No space to break at (CJK, long single words): split between characters.
            let mut cut: Option<(f32, usize)> = None;
            for (i, _) in text.char_indices().skip(1) {
                let w = width(&text[..i]).max(width(&text[i..]));
                if cut.is_none_or(|(bw, _)| w < bw) {
                    cut = Some((w, i));
                }
            }
            match cut {
                Some((_, i)) => vec![text[..i].to_string(), text[i..].to_string()],
                None => vec![text.to_string()],
            }
        }
    }
}

/// Big icon button with a caption underneath.
fn big_button(ui: &mut egui::Ui, ic: Icon, label: &str, enabled: bool, checked: bool) -> egui::Response {
    let (rect, resp) = ui.allocate_exact_size(egui::vec2(68.0, 64.0), if enabled { Sense::click() } else { Sense::hover() });
    let vis = ui.visuals();
    if checked {
        ui.painter().rect_filled(rect, 2.0, vis.selection.bg_fill);
    } else if resp.hovered() && enabled {
        ui.painter().rect_filled(rect, 2.0, vis.widgets.hovered.weak_bg_fill);
    }
    let col = if enabled { vis.text_color() } else { vis.weak_text_color() };
    paint::icon(ui.painter(), egui::Rect::from_center_size(egui::pos2(rect.center().x, rect.top() + 19.0), egui::vec2(28.0, 28.0)), ic, enabled);
    let font = egui::FontId::proportional(11.5);
    for (i, line) in split_caption(ui, label, &font, rect.width() - 2.0).iter().take(2).enumerate() {
        ui.painter().with_clip_rect(rect).text(egui::pos2(rect.center().x, rect.top() + 37.0 + i as f32 * 12.5), egui::Align2::CENTER_TOP, line, font.clone(), col);
    }
    resp
}

/// A named group: content on top, the group caption centred underneath, a separator after it.
fn group(ui: &mut egui::Ui, title: &str, content: impl FnOnce(&mut egui::Ui)) {
    ui.vertical(|ui| {
        let inner = ui.horizontal(|ui| {
            ui.spacing_mut().item_spacing.x = 1.0;
            content(ui);
        });
        let w = inner.response.rect.width().max(40.0);
        ui.allocate_ui_with_layout(egui::vec2(w, 14.0), egui::Layout::top_down(egui::Align::Center), |ui| {
            ui.label(RichText::new(title).small().weak());
        });
    });
    ui.separator();
}

fn find_label(items: &[Item], cmd: Cmd) -> Option<String> {
    for it in items {
        if cmd_for(it) == Some(cmd) {
            return Some(App::item_label(it));
        }
        if let Some(l) = find_label(&it.children, cmd) {
            return Some(l);
        }
    }
    None
}

impl App {
    /// Caption of a command: the (translated) caption of the original menu/toolbar item.
    fn cmd_label(&self, cmd: Cmd, fallback: &str) -> String {
        find_label(&self.toolbar_items, cmd).or_else(|| find_label(&self.menu_items, cmd)).map(|s| i18n::strip_accel(&s)).unwrap_or_else(|| tr(fallback))
    }

    fn big(&self, ui: &mut egui::Ui, out: &mut Option<Cmd>, cmd: Cmd, ic: Icon, fallback: &str) {
        let label = self.cmd_label(cmd, fallback);
        self.big_labeled(ui, out, cmd, ic, &label);
    }

    fn big_labeled(&self, ui: &mut egui::Ui, out: &mut Option<Cmd>, cmd: Cmd, ic: Icon, label: &str) {
        if big_button(ui, ic, label, self.cmd_enabled(cmd), self.cmd_checked(cmd)).clicked() {
            *out = Some(cmd);
        }
    }

    pub(super) fn ribbon(&mut self, ui: &mut egui::Ui) -> Option<Cmd> {
        let mut out: Option<Cmd> = None;
        let names = [
            cap("FileMenu", "&File"),
            cap("TabHomeTitleAction", "&Home"),
            cap("ScanTabTitleAction", "&Scan"),
            cap("TabViewTitleAction", "&View"),
            cap("TabOptionsTitleAction", "&Options"),
            cap("HelpTabTitleAction", "Hel&p"),
        ];
        let accent = Color32::from_rgb(0, 120, 215);
        ui.horizontal(|ui| {
            ui.spacing_mut().item_spacing.x = 2.0;
            for (i, n) in names.iter().enumerate() {
                let active = self.ribbon_tab == i;
                let text = if i == 0 { RichText::new(n).color(Color32::WHITE) } else { RichText::new(n) };
                let resp = ui.add(egui::Label::new(text).sense(Sense::click()));
                let r = resp.rect.expand2(egui::vec2(8.0, 3.0));
                if i == 0 {
                    ui.painter().rect_filled(r, 0.0, accent);
                    ui.painter().text(resp.rect.center(), egui::Align2::CENTER_CENTER, n, egui::FontId::proportional(14.0), Color32::WHITE);
                } else if active {
                    ui.painter().line_segment([r.left_bottom(), r.right_bottom()], Stroke::new(2.0, accent));
                }
                if resp.clicked() {
                    self.ribbon_tab = i;
                }
                ui.add_space(10.0);
            }
        });
        ui.add_space(2.0);
        ui.separator();
        let scanning = self.handle.is_some();
        ui.horizontal(|ui| {
            ui.set_min_height(88.0);
            ui.spacing_mut().item_spacing.x = 4.0;
            match self.ribbon_tab {
                0 => {
                    out = out.or(self.menu_bar(ui));
                }
                1 => {
                    group(ui, &cap("ScanTabTitleAction", "&Scan"), |ui| {
                        self.big_labeled(ui, &mut out, Cmd::ScanDir, Icon::Folder, &cap("ScanListRibbonCollectionAction", "Select &Directory"));
                        self.big(ui, &mut out, Cmd::Stop, Icon::Stop, "Stop Scan");
                        self.big(ui, &mut out, Cmd::Refresh, Icon::Refresh, "Refresh");
                    });
                    group(ui, &cap("GrpModeTitleAction", "Mode"), |ui| {
                        self.big(ui, &mut out, Cmd::SortBy(SortCol::Size), Icon::Bars, "Size");
                        self.big(ui, &mut out, Cmd::SortBy(SortCol::Alloc), Icon::Drive, "Allocated Space");
                        self.big(ui, &mut out, Cmd::SortBy(SortCol::Files), Icon::Files, "File Count");
                        self.big(ui, &mut out, Cmd::SortBy(SortCol::Percent), Icon::Percent, "Percent");
                    });
                    group(ui, &cap("GrpUnitTitleAction", "Unit"), |ui| {
                        self.big(ui, &mut out, Cmd::SetUnits(Units::Auto), Icon::Units, "Automatic Units");
                        ui.vertical(|ui| {
                            for (u, l) in [(Units::TB, "TB"), (Units::GB, "GB"), (Units::MB, "MB"), (Units::KB, "KB"), (Units::Bytes, "B")] {
                                if ui.add(egui::Button::new(RichText::new(l).small().strong()).selected(self.settings.units == u).min_size(egui::vec2(30.0, 18.0))).clicked() {
                                    out = Some(Cmd::SetUnits(u));
                                }
                            }
                        });
                    });
                    group(ui, &cap("GrpFolderOperationsAction", "Folder Operations"), |ui| {
                        self.big(ui, &mut out, Cmd::ParentFolder, Icon::Up, "Parent Folder");
                        self.big(ui, &mut out, Cmd::OpenLocation, Icon::Open, "Open Location");
                        self.big(ui, &mut out, Cmd::ExcludeSelected, Icon::Exclude, "Exclude");
                        self.big(ui, &mut out, Cmd::RescanSelected, Icon::Refresh, "Rescan Folder");
                        let resp = big_button(ui, Icon::Expand, &tr("Expand"), self.loaded.is_some(), false);
                        egui::Popup::menu(&resp).show(|ui| {
                            for n in 1..=3u8 {
                                if ui.button(format!("{} {n}", tr("Level"))).clicked() {
                                    out = Some(Cmd::ExpandLevel(n));
                                    ui.close();
                                }
                            }
                            if ui.button(tr("Expand all")).clicked() {
                                out = Some(Cmd::ExpandFull);
                                ui.close();
                            }
                        });
                        self.big(ui, &mut out, Cmd::NewFolder, Icon::Folder, "New folder");
                    });
                    group(ui, &cap("GrpToolsTitleAction", "Tools"), |ui| {
                        self.big(ui, &mut out, Cmd::Filter, Icon::Filter, "Filter");
                        self.big(ui, &mut out, Cmd::ClearFilter, Icon::Exclude, "Clear filter");
                        self.big(ui, &mut out, Cmd::ToggleHideEmpty, Icon::Folder, "Hide empty folders");
                        self.big(ui, &mut out, Cmd::Find, Icon::Types, "Find in tree");
                        self.big(ui, &mut out, Cmd::RestartAdmin, Icon::Bolt, "Restart as Administrator");
                        let resp = big_button(ui, Icon::Export, &tr("Export"), self.loaded.is_some() && !scanning, false);
                        egui::Popup::menu(&resp).show(|ui| {
                            for (label, fmt) in [("CSV...", export::Format::Csv), ("HTML report...", export::Format::Html), ("JSON...", export::Format::Json)] {
                                if ui.button(tr(label)).clicked() {
                                    self.export(fmt);
                                    ui.close();
                                }
                            }
                        });
                    });
                }
                2 => {
                    group(ui, &tr("Views"), |ui| {
                        for (v, ic, l) in [
                            (ViewKind::Tree, Icon::Tree, "Tree"),
                            (ViewKind::Treemap, Icon::Treemap, "Treemap"),
                            (ViewKind::Chart, Icon::Chart, "Chart"),
                            (ViewKind::Types, Icon::Types, "File types"),
                            (ViewKind::Largest, Icon::Top, "Top 100 files"),
                            (ViewKind::Oldest, Icon::Oldest, "Oldest files"),
                            (ViewKind::Duplicates, Icon::Dupes, "Duplicates"),
                            (ViewKind::Cleanup, Icon::Exclude, "Clean-up"),
                            (ViewKind::Age, Icon::Oldest, "File age"),
                        ] {
                            self.big(ui, &mut out, Cmd::SetView(v), ic, l);
                        }
                    });
                    group(ui, &tr("History"), |ui| {
                        self.big(ui, &mut out, Cmd::SetView(ViewKind::Compare), Icon::Oldest, "Changes since last scan");
                        self.big(ui, &mut out, Cmd::SnapshotCompare, Icon::Open, "Compare with snapshot...");
                        self.big(ui, &mut out, Cmd::SnapshotSave, Icon::Export, "Save snapshot...");
                    });
                    group(ui, &tr("Scan"), |ui| {
                        if big_button(ui, Icon::Bolt, &tr("Fast NTFS scan (admin)"), !scanning, self.fast_ntfs).clicked() {
                            out = Some(Cmd::ToggleFast);
                        }
                    });
                }
                3 => {
                    group(ui, &cap("GrpViewTitleAction", "View"), |ui| {
                        self.big(ui, &mut out, Cmd::ToggleDetails, Icon::Details, "Show Details");
                        let resp = big_button(ui, Icon::Details, &tr("Configure columns"), true, false);
                        egui::Popup::menu(&resp).show(|ui| {
                            for (c, label) in [(SortCol::Size, "Size"), (SortCol::Alloc, "Allocated"), (SortCol::Percent, "% of Parent"), (SortCol::Files, "Files"), (SortCol::Folders, "Folders"), (SortCol::Modified, "Last Modified")] {
                                let mut on = self.column_visible(c);
                                if ui.checkbox(&mut on, tr(label)).clicked() {
                                    self.toggle_column(c);
                                }
                            }
                        });
                        let resp = big_button(ui, Icon::Percent, &tr("Decimals"), true, false);
                        egui::Popup::menu(&resp).show(|ui| {
                            for n in 0..=3u8 {
                                if ui.selectable_label(self.settings.decimals == n, n.to_string()).clicked() {
                                    self.settings.decimals = n;
                                    ui.close();
                                }
                            }
                        });
                        self.big(ui, &mut out, Cmd::ToggleMap, Icon::Treemap, "Proportional map");
                        self.big(ui, &mut out, Cmd::ExpandFull, Icon::Expand, "Expand all");
                    });
                    group(ui, &tr("Proportional map"), |ui| {
                        self.big(ui, &mut out, Cmd::MapRight(false), Icon::Treemap, "Map at the bottom");
                        self.big(ui, &mut out, Cmd::MapRight(true), Icon::Treemap, "Map on the right");
                        let resp = big_button(ui, Icon::Tree, &tr("Level of detail"), self.settings.show_map, false);
                        egui::Popup::menu(&resp).show(|ui| {
                            for n in 1..=4u8 {
                                if ui.selectable_label(self.settings.map_levels == n, format!("{} {n}", tr("Level"))).clicked() {
                                    self.settings.map_levels = n;
                                    ui.close();
                                }
                            }
                        });
                        ui.vertical(|ui| {
                            ui.checkbox(&mut self.settings.map_unique_files, tr("Show unique files"));
                            ui.checkbox(&mut self.settings.map_headers, tr("Show hierarchy"));
                            ui.checkbox(&mut self.settings.map_legend, tr("Show legend"));
                            ui.checkbox(&mut self.settings.map_labels, tr("Show labels"));
                            ui.checkbox(&mut self.settings.map_free, tr("Show free space on the drive"));
                        });
                    });
                    group(ui, &tr("Expand"), |ui| {
                        for n in 1..=3u8 {
                            self.big(ui, &mut out, Cmd::ExpandLevel(n), Icon::Tree, &format!("Level {n}"));
                        }
                    });
                }
                4 => group(ui, &tr("Options"), |ui| {
                    self.big(ui, &mut out, Cmd::Options, Icon::Options, "Options");
                }),
                _ => group(ui, &cap("GrpHelpTitleAction", "Help"), |ui| {
                    self.big(ui, &mut out, Cmd::About, Icon::About, "About");
                }),
            }
        });
        out
    }
}
