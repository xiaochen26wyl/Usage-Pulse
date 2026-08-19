import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { BrowserWindow, nativeImage, type NativeImage } from "electron";

// macOS's Tray.setTitle() can't reliably fit two stacked lines: on the
// classic ~22pt menu bar row (external displays, non-notched Macs) the
// system font is too tall and the top line renders off the top edge of the
// screen. Rendering the icon and the two lines ourselves onto a small canvas
// and handing Tray.setImage() the resulting bitmap gives full control over
// layout so it always fits, regardless of the host Mac's menu bar height.
const CANVAS_WIDTH = 190;
const CANVAS_HEIGHT = 40;
const SCALE_FACTOR = 2;
const ICON_SIZE = 26;
const PADDING = 6;

let rendererWindow: BrowserWindow | null = null;
let loadPromise: Promise<void> | null = null;
let iconLoadPromise: Promise<void> | null = null;

const RENDERER_HTML = `<!DOCTYPE html>
<html><body style="margin:0">
<canvas id="c" width="${CANVAS_WIDTH}" height="${CANVAS_HEIGHT}"></canvas>
<script>
let iconImg = null;

window.loadIcon = (dataUrl) => new Promise((resolve) => {
  const img = new Image();
  img.onload = () => { iconImg = img; resolve(true); };
  img.onerror = () => { iconImg = null; resolve(false); };
  img.src = dataUrl;
});

window.renderTray = (line1, line2, dark) => {
  const canvas = document.getElementById("c");
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = dark ? "#ffffff" : "#000000";
  ctx.textBaseline = "middle";

  const padding = ${PADDING};
  const iconSize = ${ICON_SIZE};
  let textStartX = padding;
  if (iconImg) {
    const iconY = (canvas.height - iconSize) / 2;
    ctx.drawImage(iconImg, padding, iconY, iconSize, iconSize);
    textStartX = padding + iconSize + padding;
  }

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

  const size2 = fitFontSize(line2, "bold", 17, 9);
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

const mimeTypeFor = (path: string): string => {
  const ext = extname(path).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") {
    return "image/jpeg";
  }
  if (ext === ".gif") {
    return "image/gif";
  }
  return "image/png";
};

// Preloads the app's tray icon into the offscreen canvas once so every
// renderTray() call afterwards can draw it synchronously alongside the text.
export const initTrayRenderer = async (iconPath: string): Promise<void> => {
  const win = await ensureRendererWindow();
  const buffer = readFileSync(iconPath);
  const dataUrl = `data:${mimeTypeFor(iconPath)};base64,${buffer.toString("base64")}`;
  iconLoadPromise = win.webContents
    .executeJavaScript(`window.loadIcon(${JSON.stringify(dataUrl)})`)
    .then(() => undefined);
  await iconLoadPromise.catch((error) => {
    console.error("[Usage-Pulse] tray icon preload failed", error);
  });
};

export const renderTrayImage = async (line1: string, line2: string, dark: boolean): Promise<NativeImage> => {
  const win = await ensureRendererWindow();
  if (iconLoadPromise) {
    await iconLoadPromise.catch(() => undefined);
  }
  const dataUrl = (await win.webContents.executeJavaScript(
    `window.renderTray(${JSON.stringify(line1)}, ${JSON.stringify(line2)}, ${dark})`
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
  iconLoadPromise = null;
};
