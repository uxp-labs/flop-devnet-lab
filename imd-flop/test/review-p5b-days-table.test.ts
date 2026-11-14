/**
 * Review of P5b, attack 7 and the lead's L2. `--days` is held to 1 to MAX_DAYS, a 10 typed in src/session/caps.ts.
 * Here the encoder's table is a copy whose FlopSessionKeys.MaxSessionDuration is half the committed one
 * (src/chain/runtimes.ts, the constant of that name, read and halved here): five epochs of SessionEpochLength.
 * Nothing else of the table changes. The node is the rerun's recording at A10 (test/lib/session-fixtures.ts).
 * No socket.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/chain/runtimes.js", async (importOriginal) => {
  const m = (await importOriginal()) as { RUNTIMES: any[] };
  const copy = structuredClone(m.RUNTIMES);
  const c = copy[0].constants.find((x: any) => x.pallet === "FlopSessionKeys" && x.name === "MaxSessionDuration");
  c.value = c.value / 2;
  return { ...m, RUNTIMES: copy };
});

const { RUNTIMES } = await import("../src/chain/runtimes.js");
const { OWNER, scriptAt, seatHome, session, transportOf } = await import("./lib/session-fixtures.js");
const constant = (name: string): number => RUNTIMES[0].constants.find((x: any) => x.name === name)!.value as number;

describe("review P5b, L2: a runtime whose longest session is shorter than the days asked", () => {
  const max = constant("MaxSessionDuration");
  const epoch = constant("SessionEpochLength");
  const most = max / epoch;

  it("control: the copy's longest session is a whole number of epochs below MAX_DAYS", () => {
    expect(Number.isInteger(most)).toBe(true);
    expect(most).toBeLessThan(10);
  });

  it("HOLDS: the most days the copy allows prints the call", async () => {
    const r = await session(seatHome(), ["grant", "--owner", OWNER.ss58, "--days", String(most)], transportOf(scriptAt("A10")));
    expect([r.code, r.err]).toEqual([0, ""]);
  });

  it("HOLDS: one day more refuses with no call printed", async () => {
    const r = await session(seatHome(), ["grant", "--owner", OWNER.ss58, "--days", String(most + 1)], transportOf(scriptAt("A10")));
    expect([r.code === 0, r.out]).toEqual([false, ""]);
  });

  it("DEFECT RP5B-7 (the lead's L2): the refusal's words do not name the days asked and the most days the runtime allows; they are the encoder's, in blocks", async () => {
    const r = await session(seatHome(), ["grant", "--owner", OWNER.ss58, "--days", String(most + 1)], transportOf(scriptAt("A10")));
    expect(r.err).toMatch(new RegExp(`--days ${most + 1}\\b`));
    expect(r.err).toMatch(new RegExp(`\\b${most} (days|epochs)\\b`));
  });
});
