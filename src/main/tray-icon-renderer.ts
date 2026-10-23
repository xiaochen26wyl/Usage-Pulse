import { createCanvas } from "@napi-rs/canvas";
import { nativeImage, type NativeImage } from "electron";
import type { TrayColumn } from "@shared/tray-display";
import { TRAY_BACKGROUND_COLOR, TRAY_VALUE_COLOR } from "@shared/tray-value-color";

// Drawn in the main process with @napi-rs/canvas: a hidden BrowserWindow just
// for one canvas costs a whole renderer process (50-80MB), this costs a few MB.
//
// macOS's Tray.setTitle() can't reliably fit two stacked lines: on the
// classic ~22pt menu bar row (external displays, non-notched Macs) the
// system font is too tall and the top line renders off the top edge of the
// screen. Rendering the two lines ourselves onto a small canvas and handing
// Tray.setImage() the resulting bitmap gives full control over layout so it
// always fits, regardless of the host Mac's menu bar height. Text only, no
// icon glyph — at menu-bar scale any icon derived from the app's artwork
// either loses legibility or leaves an oversized gap before the text.
const CANVAS_HEIGHT = 40;
const SCALE_FACTOR = 2;
const MAX_CANVAS_WIDTH = 320;
// Room between the background edge and the text. The corner radius is small on
// purpose: the image should still read as a rectangle, not a pill.
const PADDING_X = 8;
const CORNER_RADIUS = 6;
const TOKEN_GAP = 14;
// Tighter than TOKEN_GAP so the weekly figure visibly belongs to its column.
const WEEKLY_GAP = 5;
const LINE1_SIZE = 15;
const LINE2_SIZE = 22;
// No name above the weekly figure, so it takes the full height.
const WEEKLY_SIZE = 30;
const LINE1_Y_RATIO = 0.28;
const LINE2_Y_RATIO = 0.74;

// Skia cannot resolve "-apple-system"; Helvetica Neue is on every macOS and
// PingFang covers CJK should a label ever need it.
const FONT_STACK = '"Helvetica Neue", "PingFang TC", Arial, sans-serif';
const MIN_LINE1_SIZE = 8;
const MIN_LINE2_SIZE = 9;
const MIN_WEEKLY_SIZE = 12;

interface FontSizes {
  label: number;
  value: number;
  weekly: number;
}

export const renderTrayImage = async (columns: TrayColumn[]): Promise<NativeImage> => {
  // Measuring needs a context before the final width is known.
  const probe = createCanvas(1, 1).getContext("2d");
  const measure = (text: string, weight: string, size: number): number => {
    probe.font = `${weight} ${size}px ${FONT_STACK}`;
    return probe.measureText(text).width;
  };

  const layout = (sizes: FontSizes) => {
    let x = PADDING_X;
    const placed = columns.map((column, i) => {
      const columnX = x;
      const columnWidth = Math.max(measure(column.label, "600", sizes.label), measure(column.value, "bold", sizes.value));
      x += columnWidth;
      let weeklyX: number | null = null;
      if (column.weekly) {
        x += WEEKLY_GAP;
        weeklyX = x;
        x += measure(column.weekly.value, "bold", sizes.weekly);
      }
      if (i < columns.length - 1) {
        x += TOKEN_GAP;
      }
      return { column, columnX, weeklyX };
    });
    return { placed, width: x + PADDING_X };
  };

  const sizes: FontSizes = { label: LINE1_SIZE, value: LINE2_SIZE, weekly: WEEKLY_SIZE };
  let result = layout(sizes);
  while (
    result.width > MAX_CANVAS_WIDTH &&
    (sizes.label > MIN_LINE1_SIZE || sizes.value > MIN_LINE2_SIZE || sizes.weekly > MIN_WEEKLY_SIZE)
  ) {
    sizes.label = Math.max(MIN_LINE1_SIZE, sizes.label - 1);
    sizes.value = Math.max(MIN_LINE2_SIZE, sizes.value - 1);
    sizes.weekly = Math.max(MIN_WEEKLY_SIZE, sizes.weekly - 1);
    result = layout(sizes);
  }

  const width = Math.max(1, Math.min(MAX_CANVAS_WIDTH, Math.ceil(result.width)));
  const canvas = createCanvas(width, CANVAS_HEIGHT);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = TRAY_BACKGROUND_COLOR;
  ctx.beginPath();
  ctx.roundRect(0, 0, width, CANVAS_HEIGHT, CORNER_RADIUS);
  ctx.fill();
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";

  const draw = (text: string, weight: string, size: number, x: number, y: number, color: string): void => {
    ctx.font = `${weight} ${size}px ${FONT_STACK}`;
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  };

  for (const { column, columnX, weeklyX } of result.placed) {
    draw(column.label, "600", sizes.label, columnX, CANVAS_HEIGHT * LINE1_Y_RATIO, column.labelColor);
    draw(column.value, "bold", sizes.value, columnX, CANVAS_HEIGHT * LINE2_Y_RATIO, TRAY_VALUE_COLOR);
    if (column.weekly && weeklyX !== null) {
      // "middle" baseline centres on the em box, which leaves digits visibly off
      // centre; centre the glyphs' own ink bounds instead.
      // The bounds are relative to the current baseline, so measure on the alphabetic one.
      ctx.textBaseline = "alphabetic";
      ctx.font = `bold ${sizes.weekly}px ${FONT_STACK}`;
      const ink = ctx.measureText(column.weekly.value);
      const centerY = CANVAS_HEIGHT / 2 + (ink.actualBoundingBoxAscent - ink.actualBoundingBoxDescent) / 2;
      draw(column.weekly.value, "bold", sizes.weekly, weeklyX, centerY, column.weekly.color);
      ctx.textBaseline = "middle";
    }
  }

  return nativeImage.createFromBuffer(canvas.toBuffer("image/png"), { scaleFactor: SCALE_FACTOR });
};

// Kept for the quit path in index.ts; nothing is held between renders anymore.
export const destroyTrayRenderer = (): void => {};
