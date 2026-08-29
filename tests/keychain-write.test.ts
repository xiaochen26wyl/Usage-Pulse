import test from "node:test";
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import {
  addGenericPasswordViaStdin,
  buildClaudeSetupTokenKeychainArgs,
  USAGE_PULSE_KEYCHAIN_ACCOUNT,
  USAGE_PULSE_KEYCHAIN_SERVICE
} from "../src/main/credential-provider";

type FakeChild = Pick<ChildProcess, "stdin" | "stderr" | "on" | "kill">;

test("addGenericPasswordViaStdin writes the secret twice then resolves on exit 0", async () => {
  let written = "";
  const listeners: { close?: (code: number) => void } = {};
  const child: FakeChild = {
    stdin: {
      end: (data?: string) => {
        written = String(data);
        queueMicrotask(() => listeners.close?.(0));
      }
    } as FakeChild["stdin"],
    stderr: { on: () => undefined } as FakeChild["stderr"],
    on: ((event: string, cb: (code: number) => void) => {
      if (event === "close") {
        listeners.close = cb;
      }
      return child as ChildProcess;
    }) as FakeChild["on"],
    kill: () => true
  };

  await addGenericPasswordViaStdin(["add-generic-password", "-w"], "blob", {
    spawnFn: () => child,
    timeoutMs: 1_000
  });
  assert.equal(written, "blob\nblob\n");
});

test("Claude setup-token writes to a Usage-Pulse-owned Keychain tuple", () => {
  assert.deepEqual(buildClaudeSetupTokenKeychainArgs(), [
    "add-generic-password",
    "-s",
    USAGE_PULSE_KEYCHAIN_SERVICE,
    "-a",
    USAGE_PULSE_KEYCHAIN_ACCOUNT,
    "-U",
    "-w"
  ]);
  assert.notEqual(USAGE_PULSE_KEYCHAIN_SERVICE, "Claude Code-credentials");
  assert.equal(buildClaudeSetupTokenKeychainArgs().at(-1), "-w");
});

test("addGenericPasswordViaStdin times out and kills a spawn that never closes", async () => {
  let killed = false;
  const child: FakeChild = {
    stdin: { end: () => undefined } as FakeChild["stdin"],
    stderr: { on: () => undefined } as FakeChild["stderr"],
    on: (() => child as ChildProcess) as FakeChild["on"],
    kill: () => {
      killed = true;
      return true;
    }
  };

  await assert.rejects(
    () =>
      addGenericPasswordViaStdin(["add-generic-password", "-w"], "x", {
        spawnFn: () => child,
        timeoutMs: 20
      }),
    /timed out/
  );
  assert.equal(killed, true);
});
