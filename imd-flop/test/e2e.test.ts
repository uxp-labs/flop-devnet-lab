// Runs the built CLI as a real process (catches event-loop issues the in-process tests cannot).
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpHome } from "./helpers.js";

const BIN = join(__dirname, "..", "dist", "bin.js");
const run = (h: string, args: string[]) => spawnSync(process.execPath, [BIN, ...args], { env: { ...process.env, IMD_FLOP_HOME: h }, encoding: "utf8", timeout: 15000 });

describe("built CLI process", () => {
  it("a timed-out mock run exits 6 and records timeout_unknown with null spend", () => {
    const h = tmpHome();
    expect(run(h, ["init", "--seat", "3"]).status).toBe(0);
    expect(run(h, ["link", "--token", "3"]).status).toBe(0);
    expect(run(h, ["cap", "set", "1"]).status).toBe(0);
    const r = run(h, ["run", "--job", "j1", "--prompt", "hi", "--mock-scenario", "timeout", "--timeout-ms", "100"]);
    expect(r.status).toBe(6);
    const rows = readFileSync(join(h, "ledger.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(rows.at(-1)).toMatchObject({ state: "timeout_unknown", spend: null, job: "j1", seat: "3" });
    expect(rows.filter((x) => x.request_id === rows.at(-1).request_id)).toHaveLength(2); // sent + timeout, one call
  });
});
