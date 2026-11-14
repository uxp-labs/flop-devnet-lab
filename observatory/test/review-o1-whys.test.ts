// Review o1 (round 33), attack 5: the whys of the sixth list held to the first recording's tape.
// The events of the two settled blocks are read through the decoder's door. Nothing here reads the
// network.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeBlockEvents } from "../src/scale/block.js";
import { REVIEWED } from "../src/scale/shape.js";
import { recorded } from "./helpers/recorded.js";

const REPO = new URL("../../", import.meta.url);
const LIST = JSON.parse(readFileSync(new URL("observatory/recordings/requests.json", REPO), "utf8")) as { calls: { method: string; params: unknown[]; why: string }[] };
const R = recorded();
const SHAPE = readFileSync(new URL(`observatory/${REVIEWED.find((r) => r.specVersion === Number(R.runtimeVersion.specVersion))?.shapeFile}`, REPO), "utf8");
function eventsOf(height: number) {
  const b = R.blocks.find((x) => x.number === height);
  if (b === undefined) throw new Error(`no block ${height}`);
  const d = decodeBlockEvents({ specName: String(R.runtimeVersion.specName), specVersion: Number(R.runtimeVersion.specVersion), metadata: R.metadata, lastRuntimeUpgrade: b.lastRuntimeUpgrade, shapeText: SHAPE, events: b.events });
  if (!d.decoded) throw new Error(d.refused);
  return d.events;
}
/** The variant name of an event's phase, as the door decodes it. */
const phaseName = (p: unknown): string => (typeof p === "object" && p !== null ? String((p as Record<string, unknown>).name ?? (p as Record<string, unknown>).variant ?? Object.keys(p)[0]) : String(p));

describe("review o1: the whys of the sixth list (attack 5)", () => {
  it("DEFECT O1-8: the settled block's why says System.Events holds the events of every extrinsic of the block, but the block's events hold phases that are not an extrinsic", () => {
    const why = LIST.calls[4]?.why ?? "";
    expect(why).toContain("System.Events, the events of every extrinsic of the block");
    const phases = [3479299, 3479277].flatMap((h) => eventsOf(h).map((e) => phaseName(e.phase)));
    // Every event of the block would be an extrinsic's only if no phase were Initialization or Finalization.
    expect(phases.filter((p) => !/ApplyExtrinsic/.test(p))).toEqual([]);
  });

  it("HOLDS: each settled block's why names the channel the block's one Settled event names, by its first ten characters", () => {
    for (const [i, h] of [
      [2, 3479299],
      [7, 3479277],
    ] as const) {
      const settled = eventsOf(h).filter((e) => e.pallet === "ComputeChannel" && e.event === "Settled");
      expect(settled).toHaveLength(1);
      const id = String((settled[0]?.fields as Record<string, unknown>).channel_id);
      for (const c of LIST.calls.slice(i, i + 5)) expect(c.why).toContain(`${id.slice(0, 10)}... settled`);
    }
  });
});
