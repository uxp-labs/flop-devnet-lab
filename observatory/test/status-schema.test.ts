import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FixtureSource } from "../src/source.js";
import { DEVNET_GENESIS, networkStatus } from "../src/status.js";
import { checkSchema } from "./helpers/schema.js";

const schema = JSON.parse(
  readFileSync(new URL("../../interfaces/network-status.v0.schema.json", import.meta.url), "utf8"),
) as Record<string, unknown>;
const fixturesDir = fileURLToPath(new URL("../fixtures/", import.meta.url));
const scenarios = readdirSync(fixturesDir).filter((d) => d.startsWith("status-")).sort();

describe("networkStatus matches interfaces/network-status.v0.schema.json", () => {
  it("covers every status fixture", () => {
    expect(scenarios.length).toBeGreaterThanOrEqual(8);
  });

  it.each(scenarios)("%s", async (scenario) => {
    const src = FixtureSource.fromDir(fixturesDir + scenario);
    const s = await networkStatus(src, { pinnedGenesis: DEVNET_GENESIS, now: src.data.meta.now });
    expect(checkSchema(schema, s)).toEqual([]);
  });

  it("the checker rejects an extra field and a wrong type", async () => {
    const src = FixtureSource.fromDir(fixturesDir + "status-healthy");
    const s = await networkStatus(src, { pinnedGenesis: DEVNET_GENESIS, now: src.data.meta.now });
    const bad = { ...s, extra: 1, finalized_height: "3341575", rpc: { ...s.rpc, health: "fine" } };
    const problems = checkSchema(schema, bad);
    expect(problems.join(" ")).toMatch(/unexpected property extra/);
    expect(problems.join(" ")).toMatch(/finalized_height: type string/);
    expect(problems.join(" ")).toMatch(/health: "fine" not in enum/);
  });
});
