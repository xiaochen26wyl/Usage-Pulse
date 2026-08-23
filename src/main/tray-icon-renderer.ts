import { BrowserWindow, nativeImage, type NativeImage } from "electron";
import { SERVICE_ACCENT } from "@shared/line-templates";

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
const PADDING = 6;
const MAX_CANVAS_WIDTH = 190;
const PADDING_X = PADDING;
const TOKEN_GAP = 6;
const LINE1_SIZE = 13;
const LINE2_SIZE = 17;

let rendererWindow: BrowserWindow | null = null;
let loadPromise: Promise<void> | null = null;

const RENDERER_HTML = `<!DOCTYPE html>
<html><body style="margin:0">
<canvas id="c" width="${MAX_CANVAS_WIDTH}" height="${CANVAS_HEIGHT}"></canvas>
<script>
window.renderTray = (line1, line2, valueColor) => {
  const canvas = document.getElementById("c");
  const ctx = canvas.getContext("2d");
  const paddingX = ${PADDING_X};
  const tokenGap = ${TOKEN_GAP};
  const line1Size = ${LINE1_SIZE};
  const line2Size = ${LINE2_SIZE};
  const maxCanvasWidth = ${MAX_CANVAS_WIDTH};
  const line1Colors = [valueColor || "#ffffff", ${JSON.stringify(SERVICE_ACCENT.claude)}];
  const fontStack = "-apple-system, BlinkMacSystemFont, sans-serif";

  const tokensOf = (line) => String(line || "").trim().split(/\\s+/).filter(Boolean);

  const measureLine = (tokens, weight, size) => {
    ctx.font = weight + " " + size + "px " + fontStack;
    if (tokens.length === 0) {
      return 0;
    }
    let width = 0;
    for (let i = 0; i < tokens.length; i++) {
      width += ctx.measureText(tokens[i]).width;
      if (i < tokens.length - 1) {
        width += tokenGap;
      }
    }
    return width;
  };

  let size1 = line1Size;
  let size2 = line2Size;
  let tokens1 = tokensOf(line1);
  let tokens2 = tokensOf(line2);
  let contentWidth = Math.max(measureLine(tokens1, "600", size1), measureLine(tokens2, "bold", size2));

  while (contentWidth + paddingX * 2 > maxCanvasWidth && (size1 > 8 || size2 > 9)) {
    if (size1 > 8) {
      size1 -= 1;
    }
    if (size2 > 9) {
      size2 -= 1;
    }
    contentWidth = Math.max(measureLine(tokens1, "600", size1), measureLine(tokens2, "bold", size2));
  }

  canvas.width = Math.min(maxCanvasWidth, Math.ceil(contentWidth + paddingX * 2));
  canvas.height = ${CANVAS_HEIGHT};
  // Resizing the canvas resets the context; re-apply drawing state.
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";

  const drawLine = (tokens, weight, size, y, colors) => {
    ctx.font = weight + " " + size + "px " + fontStack;
    let x = paddingX;
    for (let i = 0; i < tokens.length; i++) {
      ctx.fillStyle = colors[i] || colors[colors.length - 1] || "#ffffff";
      ctx.fillText(tokens[i], x, y);
      x += ctx.measureText(tokens[i]).width;
      if (i < tokens.length - 1) {
        x += tokenGap;
      }
    }
  };

  drawLine(tokens1, "600", size1, canvas.height * 0.28, line1Colors);
  drawLine(
    tokens2,
    "bold",
    size2,
    canvas.height * 0.74,
    tokens2.map(() => valueColor || "#ffffff")
  );

  return canvas.toDataURL("image/png");
};
</script>
</body></html>`;

const ensureRendererWindow = async (): Promise<BrowserWindow> => {
  if (rendererWindow && !rendererWindow.isDestroyed()) {
    if (loadPromise) {
      await loadPromise;
    }
    return rendererWindow;
  }

  rendererWindow = new BrowserWindow({
    show: false,
    width: MAX_CANVAS_WIDTH,
    height: CANVAS_HEIGHT,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  loadPromise = rendererWindow.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(RENDERER_HTML)}`,
  );
  await loadPromise;
  return rendererWindow;
};

export const renderTrayImage = async (
  line1: string,
  line2: string,
  valueColor: string,
): Promise<NativeImage> => {
  const win = await ensureRendererWindow();
  const dataUrl = (await win.webContents.executeJavaScript(
    `window.renderTray(${JSON.stringify(line1)}, ${JSON.stringify(line2)}, ${JSON.stringify(valueColor)})`,
  )) as string;
  const base64 = dataUrl.split(",")[1] ?? "";
  return nativeImage.createFromBuffer(Buffer.from(base64, "base64"), {
    scaleFactor: SCALE_FACTOR,
  });
};

export const destroyTrayRenderer = (): void => {
  if (rendererWindow && !rendererWindow.isDestroyed()) {
    rendererWindow.destroy();
  }
  rendererWindow = null;
  loadPromise = null;
};
