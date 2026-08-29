import test from "node:test";
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { addGenericPasswordViaStdin } from "../src/main/credential-provider";

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
