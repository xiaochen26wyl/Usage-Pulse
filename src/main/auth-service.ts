import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { BrowserWindow, app } from "electron";
import type { ServiceType } from "@shared/types";
import { SERVICE_LABELS, SERVICE_URLS } from "@main/config";

type SameSite = "Strict" | "Lax" | "None";

const loginWindows = new Map<ServiceType, BrowserWindow>();

const mapSameSite = (value: string): SameSite => {
  if (value === "strict") {
    return "Strict";
  }
  if (value === "lax") {
    return "Lax";
  }
  return "None";
};

const ensureAuthDir = async (): Promise<string> => {
  const dir = join(app.getPath("userData"), "auth");
  await mkdir(dir, { recursive: true });
  return dir;
};

export const getAuthFilePath = async (service: ServiceType): Promise<string> => {
  const dir = await ensureAuthDir();
  return join(dir, `${service}.auth.json`);
};

const exists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

export const getAuthStatus = async (): Promise<Record<ServiceType, boolean>> => {
  const [cursorPath, claudePath] = await Promise.all([
    getAuthFilePath("cursor"),
    getAuthFilePath("claude")
  ]);
  const [cursor, claude] = await Promise.all([exists(cursorPath), exists(claudePath)]);
  return { cursor, claude };
};

export const clearLoginSession = async (service: ServiceType): Promise<boolean> => {
  const filePath = await getAuthFilePath(service);
  await rm(filePath, { force: true });
  return true;
};

export const openLoginWindow = async (service: ServiceType): Promise<void> => {
  const existing = loginWindows.get(service);
  if (existing && !existing.isDestroyed()) {
    existing.focus();
    return;
  }

  const window = new BrowserWindow({
    width: 1200,
    height: 900,
    autoHideMenuBar: true,
    title: `Usage-Pulse ${SERVICE_LABELS[service]} Login`
  });

  loginWindows.set(service, window);
  window.on("closed", () => {
    loginWindows.delete(service);
  });

  await window.loadURL(SERVICE_URLS[service]);
};

export const saveLoginSession = async (service: ServiceType): Promise<boolean> => {
  const win = loginWindows.get(service);
  if (!win || win.isDestroyed()) {
    throw new Error(`找不到 ${SERVICE_LABELS[service]} 登入視窗，請先開啟登入視窗。`);
  }

  const authFilePath = await getAuthFilePath(service);
  await mkdir(dirname(authFilePath), { recursive: true });

  const targetUrl = SERVICE_URLS[service];
  const origin = new URL(targetUrl).origin;
  const cookies = await win.webContents.session.cookies.get({ url: targetUrl });
  const localStorageItems = (await win.webContents
    .executeJavaScript(
      "Object.entries(localStorage).map(([name, value]) => ({ name, value }))",
      true
    )
    .catch(() => [])) as Array<{ name: string; value: string }>;

  const state = {
    cookies: cookies.map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path,
      expires: cookie.expirationDate || -1,
      httpOnly: cookie.httpOnly,
      secure: cookie.secure,
      sameSite: mapSameSite(cookie.sameSite)
    })),
    origins: [
      {
        origin,
        localStorage: localStorageItems
      }
    ]
  };

  await writeFile(authFilePath, JSON.stringify(state, null, 2), "utf-8");
  win.close();
  return true;
};
