// Tests never touch the network, and nothing may sign, spend or write.
// Any fetch or WebSocket attempt is recorded and fails loudly. After each test file,
// any attempt still in the log fails the file. A test that provokes a refusal on
// purpose must assert it and then call resetAttempts().
import { appendFileSync } from "node:fs";
import { afterAll } from "vitest";
import { attemptLog, recordAttempt } from "../src/guard.js";

globalThis.fetch = ((input: unknown) => {
  recordAttempt("network", `fetch ${String(input)}`);
  throw new Error("network disabled in tests");
}) as typeof fetch;

(globalThis as { WebSocket?: unknown }).WebSocket = class {
  constructor(url: unknown) {
    recordAttempt("network", `websocket ${String(url)}`);
    throw new Error("network disabled in tests");
  }
};

afterAll(() => {
  const left = attemptLog();
  const file = process.env.OBS_ATTEMPTS_FILE;
  if (file && left.length > 0) {
    appendFileSync(file, left.map((a) => JSON.stringify(a)).join("\n") + "\n");
  }
  if (left.length > 0) {
    throw new Error(`unexpected network, write, sign or spend attempts: ${JSON.stringify(left)}`);
  }
});
