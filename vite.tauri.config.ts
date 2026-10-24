import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// The HTML entry points ship a CSP that suits Electron's file:// pages
// (`connect-src 'none'`). Tauri's IPC runs over ipc: / http://ipc.localhost, so
// the policy is rewritten for this build; the dev server also needs inline
// script and a websocket for HMR / React Refresh. Never removed, only swapped,
// so a violation still shows up.
const BASE_POLICY =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src ipc: http://ipc.localhost; base-uri 'none'; form-action 'none'";
const DEV_POLICY =
  "default-src 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' ws: wss: ipc: http://ipc.localhost; base-uri 'none'; form-action 'none'";

const tauriCspPlugin = (): Plugin => ({
  name: "usage-pulse-tauri-csp",
  transformIndexHtml: (html, context) =>
    html.replace(
      /(<meta http-equiv="Content-Security-Policy" content=")([^"]*)(")/,
      (_match, open: string, _policy: string, close: string) =>
        `${open}${context.server ? DEV_POLICY : BASE_POLICY}${close}`
    )
});

// Used by `pnpm tauri:dev` (scripts/tauri-dev.mjs picks the port and passes it
// on the command line) and by `tauri build` through beforeBuildCommand.
export default defineConfig({
  root: ".",
  plugins: [react(), tauriCspPlugin()],
  clearScreen: false,
  server: {
    port: Number.isInteger(Number(process.env.PORT)) && Number(process.env.PORT) > 0 ? Number(process.env.PORT) : undefined,
    strictPort: false
  },
  build: {
    outDir: "dist/renderer-tauri",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve("index.html"),
        alarm: resolve("alarm.html")
      }
    }
  },
  resolve: {
    alias: {
      "@shared": resolve("src/shared")
    }
  }
});
