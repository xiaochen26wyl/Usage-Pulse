import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

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
    plugins: [react()],
    build: {
      outDir: "dist/renderer",
      rollupOptions: {
        input: {
          index: resolve("index.html"),
          alarm: resolve("alarm.html"),
          credential: resolve("credential.html")
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
