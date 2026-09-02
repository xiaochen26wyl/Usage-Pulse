import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";

// The four HTML entry points ship a strict CSP so the packaged file:// pages
// cannot run injected script or reach the network (every request is made from
// the main process). The dev server cannot live with it: HMR and React Refresh
// inject inline <script> blocks and open a websocket back to vite, so the meta
// tag is relaxed — never removed, so a violation still shows up in dev — while
// `electron-vite dev` is serving.
const devCspPlugin = (): Plugin => ({
  name: "usage-pulse-dev-csp",
  apply: "serve",
  transformIndexHtml: (html) =>
    html.replace(
      /(<meta http-equiv="Content-Security-Policy" content=")([^"]*)(")/,
      (_match, open: string, _policy: string, close: string) =>
        `${open}default-src 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' ws: wss:; base-uri 'none'; form-action 'none'${close}`
    )
});

export default defineConfig({
  main: {
    // Bundle main-process deps to avoid production runtime resolution issues.
    plugins: [],
    build: {
      outDir: "dist/main",
      rollupOptions: {
        input: {
          index: resolve("src/main/index.ts")
        }
      }
    },
    resolve: {
      alias: {
        "@shared": resolve("src/shared"),
        "@main": resolve("src/main")
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: "dist/preload",
      rollupOptions: {
        input: {
          index: resolve("src/main/preload.ts")
        }
      }
    },
    resolve: {
      alias: {
        "@shared": resolve("src/shared"),
        "@main": resolve("src/main")
      }
    }
  },
  renderer: {
    root: ".",
    plugins: [react(), devCspPlugin()],
    build: {
      outDir: "dist/renderer",
      rollupOptions: {
        input: {
          index: resolve("index.html"),
          alarm: resolve("alarm.html"),
          session: resolve("session.html")
        }
      }
    },
    resolve: {
      alias: {
        "@shared": resolve("src/shared")
      }
    }
  }
});
