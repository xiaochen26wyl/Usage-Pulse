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
vite.once("exit", (code) => {
  if (code) {
    process.exit(code);
  }
});

const stopVite = () => {
  if (!vite.killed) {
    vite.kill();
  }
};
process.on("SIGINT", () => {
  stopVite();
  process.exit(130);
});

try {
  await waitForPort(port, 30_000);
} catch (error) {
  console.error(String(error));
  stopVite();
  process.exit(1);
}

const override = JSON.stringify({ build: { devUrl: `http://127.0.0.1:${port}` } });
const tauri = spawn("pnpm", ["exec", "tauri", "dev", "--config", override], { stdio: "inherit" });
tauri.once("exit", (code) => {
  stopVite();
  process.exit(code ?? 0);
});
