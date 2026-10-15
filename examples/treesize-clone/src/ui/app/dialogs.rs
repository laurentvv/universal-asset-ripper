//! Options and About dialogs.

use super::{assets, App};
use crate::dfm;
use crate::i18n::{self, tr, tr_ctx};
use crate::settings::{SizeMode, Theme, Units};
use eframe::egui::{self, Color32, RichText};
use std::path::PathBuf;

fn units_label(u: Units) -> String {
    match u {
        Units::Auto => tr("Automatic Units"),
        Units::Bytes => tr("Values in Byte"),
        Units::KB => tr("Values in KB"),
        Units::MB => tr("Values in MB"),
        Units::GB => tr("Values in GB"),
        Units::TB => tr("Values in TB"),
    }
}

/// The selectable languages (system default, English, every catalogue), shared by the Options
/// dialog and the ribbon.
pub(super) fn language_choices(ui: &mut egui::Ui, current: &mut String) {
    let cur = current.clone();
    if ui.selectable_label(cur == "auto", language_label("auto")).clicked() {
        *current = "auto".into();
    }
    if ui.selectable_label(cur == "en", "English (en)").clicked() {
        *current = "en".into();
    }
    for l in i18n::LOCALES {
        if ui.selectable_label(cur.eq_ignore_ascii_case(l.code), format!("{} ({})", l.name, l.code)).clicked() {
            *current = l.code.to_string();
        }
    }
}

/// Text of the language combo for the current setting.
fn language_label(setting: &str) -> String {
    if setting.eq_ignore_ascii_case("auto") || setting.is_empty() {
        return format!("{} ({})", tr("Detect automatically"), i18n::resolve_language(setting));
    }
    match i18n::find_locale(setting) {
        Some(l) => format!("{} ({})", l.name, l.code),
        None => "English (en)".to_string(),
    }
}

impl App {
    pub(super) fn options_window(&mut self, ctx: &egui::Context) {
        if !self.show_options {
            return;
        }
        let mut open = true;
        egui::Window::new(tr("Options")).open(&mut open).collapsible(false).resizable(false).show(ctx, |ui| {
            egui::Grid::new("options_grid").num_columns(2).spacing([12.0, 8.0]).show(ui, |ui| {
                ui.label(tr("Language"));
                egui::ComboBox::from_id_salt("lang").width(260.0).selected_text(language_label(&self.settings.language)).show_ui(ui, |ui| {
                    language_choices(ui, &mut self.settings.language);
                });
                ui.end_row();

                ui.label(tr("Unit"));
                ui.horizontal_wrapped(|ui| {
                    for u in Units::ALL {
                        ui.selectable_value(&mut self.settings.units, u, units_label(u));
                    }
                });
                ui.end_row();

                ui.label(tr("Decimals"));
                ui.horizontal(|ui| {
                    for n in 0..=3u8 {
                        ui.selectable_value(&mut self.settings.decimals, n, n.to_string());
                    }
                });
                ui.end_row();

                ui.label(tr("Percent"));
                ui.horizontal(|ui| {
                    ui.selectable_value(&mut self.settings.size_mode, SizeMode::Size, tr("Size"));
                    ui.selectable_value(&mut self.settings.size_mode, SizeMode::Allocated, tr("Allocated Space"));
                });
                ui.end_row();

                ui.label(tr("Style"));
                ui.horizontal(|ui| {
                    ui.selectable_value(&mut self.settings.theme, Theme::Auto, tr("Detect automatically"));
                    ui.selectable_value(&mut self.settings.theme, Theme::Light, tr("Light"));
                    ui.selectable_value(&mut self.settings.theme, Theme::Dark, tr("Dark"));
                });
                ui.end_row();

                ui.label(tr("Columns"));
                ui.vertical(|ui| {
                    ui.checkbox(&mut self.settings.show_allocated, tr("Allocated"));
                    ui.checkbox(&mut self.settings.details, tr("Show Details"));
                    ui.checkbox(&mut self.settings.show_map, tr("Proportional map"));
                });
                ui.end_row();

                ui.label(tr("Scan"));
                ui.checkbox(&mut self.fast_ntfs, tr("Fast NTFS scan (admin)"));
                ui.checkbox(&mut self.settings.always_admin, tr("Always start as administrator"));
                ui.end_row();
            });
            ui.separator();
            ui.label(RichText::new(tr("Excluded folders")).strong());
            ui.label(tr("Applied at the next scan."));
            let mut remove = None;
            egui::ScrollArea::vertical().max_height(120.0).id_salt("excl").show(ui, |ui| {
                if self.excludes.is_empty() {
                    ui.weak(tr("(none)"));
                }
                for (i, e) in self.excludes.iter().enumerate() {
                    ui.horizontal(|ui| {
                        if ui.small_button("x").on_hover_text(tr("Remove")).clicked() {
                            remove = Some(i);
                        }
                        ui.add(egui::Label::new(e.display().to_string()).truncate());
                    });
                }
            });
            if let Some(i) = remove {
                self.excludes.remove(i);
            }
            ui.horizontal(|ui| {
                ui.add(egui::TextEdit::singleline(&mut self.exclude_input).desired_width(260.0).hint_text(tr("Path to scan")));
                if ui.button(tr("Add new")).clicked() && !self.exclude_input.trim().is_empty() {
                    self.excludes.push(PathBuf::from(self.exclude_input.trim()));
                    self.exclude_input.clear();
                }
                if ui.button("...").clicked() {
                    if let Some(d) = rfd::FileDialog::new().pick_folder() {
                        self.excludes.push(d);
                    }
                }
            });
        });
        self.show_options = open;
    }

    /// About box laid out from `TJamAboutForm`: same client size, black background, labels at their DFM positions.
    pub(super) fn about_window(&mut self, ctx: &egui::Context) {
        if !self.show_about {
            return;
        }
        if self.about_icon.is_none() {
            self.about_icon = assets::icon_texture(ctx);
        }
        let spec = dfm::about_spec();
        let ver = dfm::version_info();
        let product = ver.get("ProductName").cloned().unwrap_or_else(|| "TreeSize Free".into());
        let mut open = true;
        let mut close = false;
        egui::Window::new(tr_ctx("TMainForm.AboutAction.Caption", "&About"))
            .open(&mut open)
            .collapsible(false)
            .resizable(false)
            .frame(egui::Frame::window(&ctx.global_style()).fill(Color32::BLACK).inner_margin(0.0))
            .show(ctx, |ui| {
                let (rect, _) = ui.allocate_exact_size(egui::vec2(spec.client_w, spec.client_h), egui::Sense::hover());
                let painter = ui.painter_at(rect);
                let at = |name: &str| spec.positions.iter().find(|(n, _, _)| n == name).map(|(_, x, y)| rect.min + egui::vec2(*x, *y)).unwrap_or(rect.min);
                let text = |pos: egui::Pos2, s: String, size: f32, col: Color32| {
                    painter.text(pos, egui::Align2::LEFT_TOP, s, egui::FontId::proportional(size), col);
                };
                let about = tr_ctx("TJamAboutForm.AboutLabel.Caption", spec.labels.get("AboutLabel").map_or("About %s", String::as_str));
                text(at("AboutLabel"), about.replace("%s", &product), 15.0, Color32::WHITE);
                text(at("ProductNameLabel"), product.clone(), 18.0, Color32::WHITE);
                text(at("EditionLabel"), "Rust clone".into(), 18.0, Color32::from_rgb(120, 200, 120));
                let orig = ver.get("ProductVersion").cloned().unwrap_or_default();
                text(at("VersionLabel"), format!("{} {} ({})", tr("Version"), env!("CARGO_PKG_VERSION"), orig), 14.0, Color32::WHITE);
                text(
                    at("BitnessLabel"),
                    format!("{} {}", tr("Based on the layout of"), product),
                    13.0,
                    Color32::LIGHT_GRAY,
                );
                if let Some(c) = ver.get("LegalCopyright") {
                    text(at("Copyright"), c.clone(), 13.0, Color32::LIGHT_GRAY);
                }
                text(
                    at("ProductIsLicensedToLabel"),
                    "Built from assets extracted by Universal Asset Ripper.".into(),
                    13.0,
                    Color32::LIGHT_GRAY,
                );
                text(
                    at("LabelInstKey"),
                    "Not affiliated with the original publisher.".into(),
                    13.0,
                    Color32::GRAY,
                );
                if let Some(tex) = &self.about_icon {
                    let p = at("ProgramIcon");
                    painter.image(tex.id(), egui::Rect::from_min_size(p, egui::vec2(102.0, 102.0)), egui::Rect::from_min_max(egui::pos2(0.0, 0.0), egui::pos2(1.0, 1.0)), Color32::WHITE);
                }
                let close_pos = at("ClosePanel");
                let btn = egui::Rect::from_min_size(close_pos, egui::vec2(106.0, 27.0));
                let resp = ui.interact(btn, ui.id().with("about_close"), egui::Sense::click());
                painter.rect_filled(btn, 0.0, if resp.hovered() { Color32::from_rgb(0, 160, 0) } else { Color32::from_rgb(0, 128, 0) });
                painter.text(
                    btn.center(),
                    egui::Align2::CENTER_CENTER,
                    tr_ctx("TJamAboutForm.ClosePanel.Caption", "Close"),
                    egui::FontId::proportional(14.0),
                    Color32::WHITE,
                );
                close = resp.clicked();
            });
        self.show_about = open && !close;
    }
}
