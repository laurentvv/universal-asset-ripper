//! Extracted assets embedded into the binary and decoded at startup.

use eframe::egui::{self, ColorImage, TextureHandle, TextureOptions};

static MAIN_ICON: &[u8] = include_bytes!("../../assets/icons/icon_MAINICON.ico");
static CHEVRON_CLOSED: &[u8] = include_bytes!("../../assets/bitmaps/bitmap_CHEVRON_CLOSED_22.bmp");
static CHEVRON_CLOSED_HOT: &[u8] = include_bytes!("../../assets/bitmaps/bitmap_CHEVRON_CLOSED_HOT_22.bmp");
static CHEVRON_OPENED: &[u8] = include_bytes!("../../assets/bitmaps/bitmap_CHEVRON_OPENED_22.bmp");
static CHEVRON_OPENED_HOT: &[u8] = include_bytes!("../../assets/bitmaps/bitmap_CHEVRON_OPENED_HOT_22.bmp");

/// Decode the window icon (largest image of the .ico) to RGBA.
pub fn window_icon() -> Option<egui::IconData> {
    let img = image::load_from_memory_with_format(MAIN_ICON, image::ImageFormat::Ico).ok()?.to_rgba8();
    let (width, height) = img.dimensions();
    Some(egui::IconData { rgba: img.into_raw(), width, height })
}

/// The chevron bitmaps are opaque 24-bit BMPs drawn on a black background.
/// Convert luminance to alpha so they can be tinted and drawn on any theme.
fn chevron_image(bytes: &[u8], tint: [u8; 3]) -> Option<ColorImage> {
    let img = image::load_from_memory_with_format(bytes, image::ImageFormat::Bmp).ok()?.to_rgba8();
    let (w, h) = img.dimensions();
    let max = img.pixels().map(|p| p[0].max(p[1]).max(p[2])).max().unwrap_or(255).max(1) as u32;
    let mut px = Vec::with_capacity((w * h) as usize);
    for p in img.pixels() {
        let lum = p[0].max(p[1]).max(p[2]) as u32;
        let a = (lum * 255 / max) as u8;
        px.push(egui::Color32::from_rgba_unmultiplied(tint[0], tint[1], tint[2], a));
    }
    Some(ColorImage { size: [w as usize, h as usize], source_size: egui::vec2(w as f32, h as f32), pixels: px })
}

pub struct Chevrons {
    pub closed: TextureHandle,
    pub closed_hot: TextureHandle,
    pub opened: TextureHandle,
    pub opened_hot: TextureHandle,
}

impl Chevrons {
    pub fn load(ctx: &egui::Context, dark: bool) -> Option<Self> {
        let normal = if dark { [200, 200, 200] } else { [70, 70, 70] };
        let hot = if dark { [90, 170, 255] } else { [0, 102, 204] };
        let mk = |name: &str, bytes: &[u8], tint: [u8; 3]| {
            chevron_image(bytes, tint).map(|i| ctx.load_texture(name, i, TextureOptions::LINEAR))
        };
        Some(Self {
            closed: mk("chev_closed", CHEVRON_CLOSED, normal)?,
            closed_hot: mk("chev_closed_hot", CHEVRON_CLOSED_HOT, hot)?,
            opened: mk("chev_opened", CHEVRON_OPENED, normal)?,
            opened_hot: mk("chev_opened_hot", CHEVRON_OPENED_HOT, hot)?,
        })
    }
}

/// Texture of the program icon (About box).
pub fn icon_texture(ctx: &egui::Context) -> Option<TextureHandle> {
    let icon = window_icon()?;
    let img = ColorImage::from_rgba_unmultiplied([icon.width as usize, icon.height as usize], &icon.rgba);
    Some(ctx.load_texture("app_icon", img, TextureOptions::LINEAR))
}

/// Windows system fonts that cover the scripts egui's built-in fonts lack, for a catalogue code.
pub fn fonts_for_language(code: &str) -> &'static [&'static str] {
    match code {
        "zh-hans" => &["msyh.ttc", "simsun.ttc"],
        "zh-hant" => &["msjh.ttc", "mingliu.ttc"],
        "ja" => &["YuGothR.ttc", "meiryo.ttc", "msgothic.ttc"],
        "ko" => &["malgun.ttf", "batang.ttc"],
        "th" => &["LeelawUI.ttf", "tahoma.ttf"],
        "hi" | "gu" => &["Nirmala.ttf", "Nirmala.ttc"],
        "ar" | "he" | "vi" => &["segoeui.ttf", "tahoma.ttf"],
        _ => &[],
    }
}

/// Install (or reset) the fallback fonts for the active language. Font files are read from the
/// Windows fonts folder at runtime, nothing is embedded; other platforms keep egui's defaults.
pub fn install_language_fonts(ctx: &egui::Context, code: &str) {
    let mut fonts = egui::FontDefinitions::default();
    if let Some(win) = std::env::var_os("WINDIR") {
        let dir = std::path::Path::new(&win).join("Fonts");
        for file in fonts_for_language(code) {
            if let Ok(bytes) = std::fs::read(dir.join(file)) {
                let name = format!("sys-{file}");
                fonts.font_data.insert(name.clone(), std::sync::Arc::new(egui::FontData::from_owned(bytes)));
                for fam in [egui::FontFamily::Proportional, egui::FontFamily::Monospace] {
                    fonts.families.entry(fam).or_default().push(name.clone());
                }
                break;
            }
        }
    }
    ctx.set_fonts(fonts);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn language_font_table() {
        assert!(fonts_for_language("ja").contains(&"YuGothR.ttc"));
        assert!(fonts_for_language("fr").is_empty());
    }

    #[test]
    fn embedded_assets_decode() {
        let icon = window_icon().expect("ico decodes");
        assert!(icon.width >= 16 && icon.rgba.len() == (icon.width * icon.height * 4) as usize);
        for b in [CHEVRON_CLOSED, CHEVRON_CLOSED_HOT, CHEVRON_OPENED, CHEVRON_OPENED_HOT] {
            let c = chevron_image(b, [0, 0, 0]).expect("bmp decodes");
            assert!(c.pixels.iter().any(|p| p.a() > 0), "glyph has visible pixels");
        }
    }
}
