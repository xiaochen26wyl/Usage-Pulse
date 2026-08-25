import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { app, type WebContents } from "electron";

/**
 * Process-wide lockdown for every web contents this app ever creates.
 *
 * The renderers only ever load their own four bundled pages and talk to the
 * main process over the preload bridge — they have no legitimate reason to
 * navigate anywhere, spawn a window, or attach a webview. Saying so explicitly
 * means a stray `target="_blank"`, or any string that ever manages to become
 * markup, cannot turn into a live renderer carrying the `usagePulse` API.
 *
 * Registered from module scope rather than inside `whenReady()` so it is in
 * place before menubar builds its preloaded window.
 */

const rendererDevOrigin = (): string | null => {
  const url = process.env.ELECTRON_RENDERER_URL;
  if (!url) {
    return null;
  }
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};

const packagedRendererPrefix = (): string => pathToFileURL(join(app.getAppPath(), "dist/renderer/")).href;

export const isAllowedNavigationTarget = (target: string): boolean => {
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return false;
  }

  const devOrigin = rendererDevOrigin();
  if (devOrigin && parsed.origin === devOrigin) {
    return true;
  }

  // Packaged: only the app's own bundled pages, and only below dist/renderer —
  // `startsWith` on the directory URL is what keeps `../` out.
  return parsed.protocol === "file:" && parsed.href.startsWith(packagedRendererPrefix());
};

export const hardenWebContents = (contents: WebContents): void => {
  contents.setWindowOpenHandler(() => ({ action: "deny" }));

  contents.on("will-navigate", (event, url) => {
    if (!isAllowedNavigationTarget(url)) {
      event.preventDefault();
      console.warn("[Usage-Pulse] blocked navigation attempt");
    }
  });

  contents.on("will-attach-webview", (event) => {
    event.preventDefault();
  });
};

export const installWebContentsHardening = (): void => {
  app.on("web-contents-created", (_event, contents) => hardenWebContents(contents));
};
