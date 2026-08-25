/**
 * The only external destinations Usage-Pulse ever opens on the user's behalf.
 *
 * Shared by the renderer (which renders them as footer links) and the main
 * process (whose `app:open-external` handler will only hand `shell.openExternal`
 * a member of this set), so the allowlist and the UI can never drift apart. A
 * renderer asking for anything else is refused rather than trusted.
 */
export const THREADS_URL = "https://www.threads.com/@xiaochen26wyl";
export const LINE_URL = "https://lin.ee/6XYi49XZ";
export const INSTAGRAM_URL = "https://www.instagram.com/xiaochen26wyl/";
export const WHATSAPP_URL = "https://wa.me/message/ZENT2RTQIGPEI1";
export const LINKEDIN_URL = "https://www.linkedin.com/in/wenyu-li-1a9868bb/";

export const SUPPORT_LINKS = [
  THREADS_URL,
  LINE_URL,
  INSTAGRAM_URL,
  WHATSAPP_URL,
  LINKEDIN_URL
] as const;

export type SupportLink = (typeof SUPPORT_LINKS)[number];

const ALLOWED: ReadonlySet<string> = new Set(SUPPORT_LINKS);

export const isSupportLink = (url: unknown): url is SupportLink =>
  typeof url === "string" && ALLOWED.has(url);
