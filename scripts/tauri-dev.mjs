/**
 * Starts the Tauri shell against the renderer dev server on a free port.
 *
 * Tauri wants a fixed `devUrl`, but this repo never hard-codes a dev port, so the
 * port is picked here, handed to vite, and passed to `tauri dev` as a config
 * override. Usage: pnpm tauri:dev
 */
import { spawn } from "node:child_process";
import { createServer, connect } from "node:net";

const pickPort = () =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

const waitForPort = (port, timeoutMs) =>
  new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const attempt = () => {
      const socket = connect(port, "127.0.0.1");
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() > deadline) {
          reject(new Error(`renderer dev server did not come up on port ${port}`));
        } else {
          setTimeout(attempt, 250);
        }
      });
    };
    attempt();
  });

const port = Number(process.env.PORT) > 0 ? Number(process.env.PORT) : await pickPort();

const vite = spawn(
  "pnpm",
  ["exec", "vite", "--config", "vite.tauri.config.ts", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
  { stdio: "inherit" }
);
// Set once the Tauri shell is spawned; the shell must never outlive the dev server,
// otherwise it keeps a window pointed at a dead URL and single-instance blocks the next run.
let tauri = null;
let shuttingDown = false;

const shutdown = (code) => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  if (!vite.killed) {
    vite.kill();
  }
  if (tauri && !tauri.killed) {
    tauri.kill();
  }
  process.exit(code);
};

vite.once("exit", (code) => shutdown(code ?? 1));
process.on("SIGINT", () => shutdown(130));
process.on("SIGTERM", () => shutdown(143));

try {
  await waitForPort(port, 30_000);
} catch (error) {
  console.error(String(error));
  shutdown(1);
}

const override = JSON.stringify({ build: { devUrl: `http://127.0.0.1:${port}` } });
tauri = spawn("pnpm", ["exec", "tauri", "dev", "--config", override], { stdio: "inherit" });
tauri.once("exit", (code) => shutdown(code ?? 0));
