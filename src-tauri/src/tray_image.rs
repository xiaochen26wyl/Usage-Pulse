// Draws the menu-bar image: a dark rounded rectangle with, per service, its
// name over its value and an optional second figure beside it. A port of
// src/main/tray-icon-renderer.ts, using the system's own fonts.
use std::sync::OnceLock;

use ab_glyph::{Font, FontRef, PxScale, ScaleFont, point};
use tiny_skia::{FillRule, Paint, PathBuilder, Pixmap, Transform};

use crate::tray_display::{BACKGROUND, Column, Rgb, VALUE_COLOR};

const CANVAS_HEIGHT: f32 = 40.0;
const MAX_CANVAS_WIDTH: f32 = 320.0;
const PADDING_X: f32 = 8.0;
const CORNER_RADIUS: f32 = 6.0;
const TOKEN_GAP: f32 = 14.0;
const WEEKLY_GAP: f32 = 5.0;
const LABEL_Y_RATIO: f32 = 0.28;
const VALUE_Y_RATIO: f32 = 0.74;

#[derive(Clone, Copy)]
struct Sizes {
    label: f32,
    value: f32,
    weekly: f32,
}

// Bold faces first, then fallbacks that cover CJK for the "未知" placeholder.
// (path, face index inside a .ttc)
#[cfg(target_os = "macos")]
const FONT_CANDIDATES: &[(&str, u32)] = &[
    ("/System/Library/Fonts/Supplemental/Arial Bold.ttf", 0),
    ("/System/Library/Fonts/Supplemental/Arial Unicode.ttf", 0),
    ("/System/Library/Fonts/Hiragino Sans GB.ttc", 0),
    ("/System/Library/Fonts/AppleSDGothicNeo.ttc", 0),
];
#[cfg(target_os = "windows")]
const FONT_CANDIDATES: &[(&str, u32)] = &[
    ("C:\\Windows\\Fonts\\segoeuib.ttf", 0),
    ("C:\\Windows\\Fonts\\msjhbd.ttc", 0),
    ("C:\\Windows\\Fonts\\malgunbd.ttf", 0),
    ("C:\\Windows\\Fonts\\YuGothB.ttc", 0),
];
#[cfg(all(unix, not(target_os = "macos")))]
const FONT_CANDIDATES: &[(&str, u32)] = &[
    ("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 0),
    ("/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc", 0),
];

// One slot per candidate, filled the first time that font is needed. Loading
// them all up front cost ~98 MB of heap (the CJK fonts are tens of MB each) for
// text that is nearly always digits, which the first font covers.
static SLOTS: [OnceLock<Option<FontRef<'static>>>; 4] = [const { OnceLock::new() }; 4];

fn font_at(index: usize) -> Option<&'static FontRef<'static>> {
    let (path, face) = FONT_CANDIDATES.get(index)?;
    SLOTS
        .get(index)?
        .get_or_init(|| {
            // Read once and kept for the life of the process.
            let bytes: &'static [u8] = Box::leak(std::fs::read(path).ok()?.into_boxed_slice());
            FontRef::try_from_slice_and_index(bytes, *face).ok()
        })
        .as_ref()
}

fn first_font() -> Option<&'static FontRef<'static>> {
    (0..FONT_CANDIDATES.len()).find_map(font_at)
}

fn font_for(character: char) -> Option<&'static FontRef<'static>> {
    (0..FONT_CANDIDATES.len())
        .filter_map(font_at)
        .find(|font| font.glyph_id(character).0 != 0)
        .or_else(first_font)
}

fn measure(text: &str, size: f32) -> f32 {
    text.chars()
        .filter_map(|character| {
            let font = font_for(character)?;
            Some(font.as_scaled(font.pt_to_px_scale(size)?).h_advance(font.glyph_id(character)))
        })
        .sum()
}

/// Ink bounds of `text` relative to its alphabetic baseline: (ascent, descent).
fn ink(text: &str, size: f32) -> (f32, f32) {
    let (mut top, mut bottom) = (0.0f32, 0.0f32);
    let mut x = 0.0;
    for character in text.chars() {
        let Some(font) = font_for(character) else { continue };
        let Some(scale) = font.pt_to_px_scale(size) else { continue };
        let id = font.glyph_id(character);
        if let Some(outlined) = font.outline_glyph(id.with_scale_and_position(scale, point(x, 0.0))) {
            let bounds = outlined.px_bounds();
            top = top.min(bounds.min.y);
            bottom = bottom.max(bounds.max.y);
        }
        x += font.as_scaled(scale).h_advance(id);
    }
    (-top, bottom)
}

fn draw_text(pixmap: &mut Pixmap, text: &str, size: f32, mut x: f32, baseline: f32, color: Rgb) {
    let (width, height) = (pixmap.width() as i32, pixmap.height() as i32);
    for character in text.chars() {
        let Some(font) = font_for(character) else { continue };
        let Some(scale) = font.pt_to_px_scale(size) else { continue };
        let id = font.glyph_id(character);
        if let Some(outlined) = font.outline_glyph(id.with_scale_and_position(scale, point(x, baseline))) {
            let bounds = outlined.px_bounds();
            let data = pixmap.data_mut();
            outlined.draw(|gx, gy, coverage| {
                let (px, py) = (bounds.min.x as i32 + gx as i32, bounds.min.y as i32 + gy as i32);
                if px < 0 || py < 0 || px >= width || py >= height || coverage <= 0.0 {
                    return;
                }
                // Premultiplied RGBA over the existing (opaque) background.
                let offset = ((py * width + px) * 4) as usize;
                let blend = |source: u8, target: u8| (source as f32 * coverage + target as f32 * (1.0 - coverage)).round() as u8;
                data[offset] = blend(color.0, data[offset]);
                data[offset + 1] = blend(color.1, data[offset + 1]);
                data[offset + 2] = blend(color.2, data[offset + 2]);
                data[offset + 3] = blend(255, data[offset + 3]);
            });
        }
        x += font.as_scaled(scale).h_advance(id);
    }
}

// Where each column and its second figure start, and the total width.
fn layout(columns: &[Column], sizes: Sizes) -> (Vec<(f32, Option<f32>)>, f32) {
    let mut x = PADDING_X;
    let mut placed = Vec::new();
    for (index, column) in columns.iter().enumerate() {
        let column_x = x;
        x += measure(column.label, sizes.label).max(measure(&column.value, sizes.value));
        let mut weekly_x = None;
        if let Some((text, _)) = &column.weekly {
            x += WEEKLY_GAP;
            weekly_x = Some(x);
            x += measure(text, sizes.weekly);
        }
        if index + 1 < columns.len() {
            x += TOKEN_GAP;
        }
        placed.push((column_x, weekly_x));
    }
    (placed, x + PADDING_X)
}

/// RGBA pixels plus width and height, or None when no system font is usable.
pub fn render(columns: &[Column]) -> Option<(Vec<u8>, u32, u32)> {
    if first_font().is_none() || columns.is_empty() {
        return None;
    }
    let mut sizes = Sizes { label: 15.0, value: 22.0, weekly: 30.0 };
    let (mut placed, mut total) = layout(columns, sizes);
    while total > MAX_CANVAS_WIDTH && (sizes.label > 8.0 || sizes.value > 9.0 || sizes.weekly > 12.0) {
        sizes = Sizes { label: (sizes.label - 1.0).max(8.0), value: (sizes.value - 1.0).max(9.0), weekly: (sizes.weekly - 1.0).max(12.0) };
        (placed, total) = layout(columns, sizes);
    }
    let width = total.ceil().clamp(1.0, MAX_CANVAS_WIDTH) as u32;
    let height = CANVAS_HEIGHT as u32;
    let mut pixmap = Pixmap::new(width, height)?;

    let (w, h, r) = (width as f32, CANVAS_HEIGHT, CORNER_RADIUS);
    let mut path = PathBuilder::new();
    path.move_to(r, 0.0);
    path.line_to(w - r, 0.0);
    path.quad_to(w, 0.0, w, r);
    path.line_to(w, h - r);
    path.quad_to(w, h, w - r, h);
    path.line_to(r, h);
    path.quad_to(0.0, h, 0.0, h - r);
    path.line_to(0.0, r);
    path.quad_to(0.0, 0.0, r, 0.0);
    path.close();
    let mut paint = Paint::default();
    paint.set_color_rgba8(BACKGROUND.0, BACKGROUND.1, BACKGROUND.2, 255);
    paint.anti_alias = true;
    pixmap.fill_path(&path.finish()?, &paint, FillRule::Winding, Transform::identity(), None);

    // Canvas "middle" baseline: centre of the em box.
    let middle_baseline = |centre_y: f32, size: f32| -> f32 {
        first_font()
            .and_then(|font| font.pt_to_px_scale(size).map(|scale| font.as_scaled(PxScale::from(scale)).clone()))
            .map_or(centre_y, |scaled| centre_y + (scaled.ascent() + scaled.descent()) / 2.0)
    };

    for (column, (column_x, weekly_x)) in columns.iter().zip(placed) {
        draw_text(&mut pixmap, column.label, sizes.label, column_x, middle_baseline(h * LABEL_Y_RATIO, sizes.label), column.label_color);
        draw_text(&mut pixmap, &column.value, sizes.value, column_x, middle_baseline(h * VALUE_Y_RATIO, sizes.value), VALUE_COLOR);
        if let (Some((text, color)), Some(weekly_x)) = (&column.weekly, weekly_x) {
            // Centre the digits' own ink, not the em box.
            let (ascent, descent) = ink(text, sizes.weekly);
            draw_text(&mut pixmap, text, sizes.weekly, weekly_x, h / 2.0 + (ascent - descent) / 2.0, *color);
        }
    }

    // tiny-skia is premultiplied; the tray wants straight RGBA.
    let mut data = pixmap.take();
    for pixel in data.chunks_exact_mut(4) {
        let alpha = pixel[3] as f32 / 255.0;
        if alpha > 0.0 && alpha < 1.0 {
            for channel in &mut pixel[..3] {
                *channel = (*channel as f32 / alpha).round().min(255.0) as u8;
            }
        }
    }
    Some((data, width, height))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_columns_with_second_figures() {
        let columns = vec![
            Column { label: "Cursor", label_color: (0xC0, 0x84, 0xFC), value: "62%".into(), weekly: Some(("100%".into(), (0xFA, 0xCC, 0x15))) },
            Column { label: "Claude", label_color: (0xE8, 0x94, 0x5A), value: "3.2h".into(), weekly: Some(("4%".into(), (0xFF, 0x5A, 0x5A))) },
            Column { label: "Codex", label_color: (0x3F, 0x87, 0xF7), value: "未知".into(), weekly: None },
        ];
        let Some((rgba, width, height)) = render(&columns) else { return };
        assert_eq!(rgba.len(), (width * height * 4) as usize);
        if let Ok(path) = std::env::var("TRAY_PREVIEW_PNG") {
            let mut pixmap = Pixmap::new(width, height).unwrap();
            pixmap.data_mut().copy_from_slice(&rgba);
            pixmap.save_png(path).unwrap();
        }
    }
}
