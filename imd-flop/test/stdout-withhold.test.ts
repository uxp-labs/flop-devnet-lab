/**
 * `run --json` must print the completion text that was persisted.
 * When the response-file secret scan withholds it, stdout is null plus that reason.
 * Plain output does not print completion text. The marker is synthetic and is not a key.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CompleteReq, CompleteRes, Provider } from "../src/providers.js";
import { MockProvider } from "../src/providers.js";
import { cli, readySeat, tmpHome } from "./helpers.js";

/** Synthetic 64-hex shape. Not a key. Not a credential. */
const MARKER_HEX = "ee".repeat(32);
const MARKER_TEXT = `SYNTHETIC-NOT-A-KEY ${MARKER_HEX}`;
const BENIGN_TEXT = "BENIGN-CONTROL-output-no-secret-shape";
const SEAT = "9001";

class FixedTextProvider implements Provider {
  readonly name = "mock" as const;
  calls = 0;
  constructor(
    private readonly inner: MockProvider,
    private readonly text: string,
  ) {}
  estimate(body: { model: string; prompt: string; max_tokens: number }) {
    return this.inner.estimate(body);
  }
  async complete(req: CompleteReq): Promise<CompleteRes> {
    this.calls += 1;
    const res = await this.inner.complete(req);
    return { ...res, text: this.text };
  }
  readReceipt(requestId: string) {
    return this.inner.readReceipt(requestId);
  }
}

function runArgs(job: string, json: boolean): string[] {
  return ["run", "--seat", SEAT, "--job", job, "--prompt", "Say hi", "--max-tokens", "8", "--provider", "mock", ...(json ? ["--json"] : [])];
}

function responseSavedPath(stdout: string): string {
  const m = stdout.match(/response saved: (\S+)/);
  if (!m) throw new Error(`response path missing from stdout: ${stdout}`);
  return m[1];
}

describe("run stdout matches the persisted response text", () => {
  it("marker-json: withholds a synthetic key-shaped marker from stdout and the response file", async () => {
    const home = tmpHome();
    await readySeat(home, SEAT, "5");
    const provider = new FixedTextProvider(new MockProvider("ok"), MARKER_TEXT);
    const r = await cli(home, runArgs("marker-json", true), { provider });
    expect(r.code).toBe(0);
    const printed = r.json() as { text: string | null; withheld?: string; response_file: string };
    const fileBlob = readFileSync(printed.response_file, "utf8");
    const file = JSON.parse(fileBlob) as { text: string | null; withheld?: string };
    expect(r.out.includes(MARKER_HEX)).toBe(false);
    expect(fileBlob.includes(MARKER_HEX)).toBe(false);
    expect(printed.text).toBeNull();
    expect(printed.withheld).toMatch(/secret scan blocked/);
    expect(String(printed.withheld).includes(MARKER_HEX)).toBe(false);
    expect(file.text).toBeNull();
    expect(file.withheld).toBe(printed.withheld);
  });

  it("marker-plain: does not print the synthetic marker", async () => {
    const home = tmpHome();
    await readySeat(home, SEAT, "5");
    const provider = new FixedTextProvider(new MockProvider("ok"), MARKER_TEXT);
    const r = await cli(home, runArgs("marker-plain", false), { provider });
    expect(r.code).toBe(0);
    expect(r.out.includes(MARKER_HEX)).toBe(false);
    const fileBlob = readFileSync(responseSavedPath(r.out), "utf8");
    const file = JSON.parse(fileBlob) as { text: string | null; withheld?: string };
    expect(fileBlob.includes(MARKER_HEX)).toBe(false);
    expect(file.text).toBeNull();
    expect(file.withheld).toMatch(/secret scan blocked/);
  });

  it("benign-json: prints the same text that was saved", async () => {
    const home = tmpHome();
    await readySeat(home, SEAT, "5");
    const provider = new FixedTextProvider(new MockProvider("ok"), BENIGN_TEXT);
    const r = await cli(home, runArgs("benign-json", true), { provider });
    expect(r.code).toBe(0);
    const printed = r.json() as { text: string | null; withheld?: string; response_file: string };
    const file = JSON.parse(readFileSync(printed.response_file, "utf8")) as { text: string | null; withheld?: string };
    expect(printed.text).toBe(BENIGN_TEXT);
    expect(file.text).toBe(printed.text);
    expect(printed.withheld).toBeUndefined();
    expect(file.withheld).toBeUndefined();
  });
});
