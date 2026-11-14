// The pasted files run as a page runs them, for the tests: pane-runner.js of the last batch (by its
// path, its bytes unchanged) and then session-reads.js, in one fresh global with what a browser gives
// and nothing else. A tape the tests use is made by session-reads.js itself over a fake WebSocket fed
// from the rerun's recording (rerun-node.mjs), so its form is the pane's. Not a test file. No network.
import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import { join } from "node:path";
import vm from "node:vm";
import { HERE } from "./lib.mjs";
import { fakeWebSocket } from "./rerun-node.mjs";

export const PANE_RUNNER = join(HERE, "..", "2026-11-12-encoder-devnet-test", "pane-runner.js");
export const SESSION_READS = join(HERE, "session-reads.js");

/** A fresh page with pane-runner.js and then session-reads.js run in it. */
export function page(extra = {}) {
  const g = { crypto: webcrypto, TextEncoder, setTimeout, clearTimeout, ...extra };
  vm.runInNewContext(readFileSync(PANE_RUNNER, "utf8"), g);
  vm.runInNewContext(readFileSync(SESSION_READS, "utf8"), g);
  return g;
}

/** A reader of session-reads.js whose transport is pane-runner.js wsTransport over a fake WebSocket fed by the node. */
export function readerOver(node) {
  const g = page();
  const ws = fakeWebSocket(node);
  let socket = null;
  const Ctor = class extends ws { constructor(url) { super(url); socket = this; } };
  const transport = g.paneRunner.wsTransport(undefined, Ctor);
  return { reader: g.sessionReads.createReader({ transport, nowIso: () => "2026-11-14T00:00:00.000Z" }), socket: () => socket, g };
}

/** A plain copy of a value made in the page's global (its objects are of another realm). */
export const plain = (x) => JSON.parse(JSON.stringify(x));
