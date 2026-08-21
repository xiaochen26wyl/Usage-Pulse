import { BrowserWindow, nativeImage, type NativeImage } from "electron";

// macOS's Tray.setTitle() can't reliably fit two stacked lines: on the
// classic ~22pt menu bar row (external displays, non-notched Macs) the
// system font is too tall and the top line renders off the top edge of the
// screen. Rendering the two lines ourselves onto a small canvas and handing
// Tray.setImage() the resulting bitmap gives full control over layout so it
// always fits, regardless of the host Mac's menu bar height. Text only, no
// icon glyph — at menu-bar scale any icon derived from the app's artwork
// either loses legibility or leaves an oversized gap before the text.
const CANVAS_WIDTH = 190;
const CANVAS_HEIGHT = 40;
const SCALE_FACTOR = 2;
const PADDING = 6;

let rendererWindow: BrowserWindow | null = null;
let loadPromise: Promise<void> | null = null;

const RENDERER_HTML = `<!DOCTYPE html>
<html><body style="margin:0">
<canvas id="c" width="${CANVAS_WIDTH}" height="${CANVAS_HEIGHT}"></canvas>
<script>
window.renderTray = (line1, line2) => {
  const canvas = document.getElementById("c");
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  // Most menu bars render dark/translucent regardless of the system's
  // light/dark setting, so white text (matching other menu bar utilities)
  // is legible far more often than following nativeTheme would be.
  ctx.fillStyle = "#ffffff";
  ctx.textBaseline = "middle";

  const padding = ${PADDING};
  const textStartX = padding;

  const maxWidth = canvas.width - textStartX - padding;
  const textCenterX = textStartX + maxWidth / 2;
  ctx.textAlign = "center";

  const fitFontSize = (text, weight, maxSize, minSize) => {
    let size = maxSize;
    while (size > minSize) {
      ctx.font = weight + " " + size + "px -apple-system, BlinkMacSystemFont, sans-serif";
      if (ctx.measureText(text).width <= maxWidth) {
        break;
      }
      size -= 1;
    }
    return size;
  };

  const size1 = fitFontSize(line1, "600", 15, 8);
  ctx.font = "600 " + size1 + "px -apple-system, BlinkMacSystemFont, sans-serif";
  ctx.fillText(line1, textCenterX, canvas.height * 0.28);

  const size2 = fitFontSize(line2, "bold", 20, 9);
  ctx.font = "bold " + size2 + "px -apple-system, BlinkMacSystemFont, sans-serif";
  ctx.fillText(line2, textCenterX, canvas.height * 0.74);

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
    width: CANVAS_WIDTH,
    height: CANVAS_HEIGHT,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  loadPromise = rendererWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(RENDERER_HTML)}`);
  await loadPromise;
  return rendererWindow;
};

export const renderTrayImage = async (line1: string, line2: string): Promise<NativeImage> => {
  const win = await ensureRendererWindow();
  const dataUrl = (await win.webContents.executeJavaScript(
    `window.renderTray(${JSON.stringify(line1)}, ${JSON.stringify(line2)})`
  )) as string;
  const base64 = dataUrl.split(",")[1] ?? "";
  return nativeImage.createFromBuffer(Buffer.from(base64, "base64"), { scaleFactor: SCALE_FACTOR });
};

export const destroyTrayRenderer = (): void => {
  if (rendererWindow && !rendererWindow.isDestroyed()) {
    rendererWindow.destroy();
  }
  rendererWindow = null;
  loadPromise = null;
};
