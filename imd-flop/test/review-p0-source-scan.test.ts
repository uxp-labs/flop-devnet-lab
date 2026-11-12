/**
 * Review of P0 (132bb6a..576d4d7), attack D: promise P3 and P8. The source check in test/provider-table.test.ts
 * must find a provider name compared with a literal and a concrete provider reached for, in the five files. This
 * file loads that check's own two functions from the test file's text (not a copy), so it tests what the author
 * wrote, and hands it source shapes that break B2. Each "realistic" case is a shape this repo has written before
 * or that a builder adding the third provider could plausibly write. A failing test here is a miss of the check.
 *
 * The lead ruled the hostile shapes (brief 2026-11-12-fix-p0-provider-table, rule F2): a prefix test, a name built
 * by concatenation and a name with a unicode escape are out of scope by rule, since the check guards against a
 * careless change and every diff is read by the lead and an independent reviewer. Those tests assert that the
 * check does not flag the shape, so a later change of the check shows up. The angle bracket cast is caught, since
 * the check flags any name a concrete provider module exports, and stays a test that it is found.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const PKG = join(import.meta.dirname, "..");
type Findings = (text: string) => string[];
let findings: Findings;

beforeAll(async () => {
  const text = readFileSync(join(PKG, "test", "provider-table.test.ts"), "utf8");
  const start = text.indexOf("const CONCRETE = ");
  const end = text.indexOf('describe("B2');
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const src = join(PKG, "src", "providers");
  const mod = [
    `import * as mockModule from ${JSON.stringify(join(src, "mock.js"))};`,
    `import * as gatewayModule from ${JSON.stringify(join(src, "gateway.js"))};`,
    `import { isProviderName } from ${JSON.stringify(join(src, "kinds.js"))};`,
    text.slice(start, end),
    "export { providerNameFindings };",
  ].join("\n");
  const file = join(mkdtempSync(join(tmpdir(), "review-p0-scan-")), "scan.ts");
  writeFileSync(file, mod);
  findings = ((await import(file)) as { providerNameFindings: Findings }).providerNameFindings;
});

describe("review P0, D: the source check against shapes that break B2", () => {
  it("control: a quoted name, a case label and a named import of a concrete class are found (holds)", () => {
    expect(findings(`switch (p.name) { case "mock": break; }`)).not.toEqual([]);
    expect(findings(`import { MockProvider } from "./providers.js";`)).not.toEqual([]);
    expect(findings("const s = String.raw`flop`;")).not.toEqual([]);
  });
  const realistic: [string, string][] = [
    ["a dynamic import of a concrete provider module (the old cli.ts quote path did a dynamic import)", `const g = await import("./providers/gateway.js");`],
    ["a re-export from a concrete provider module", `export { MockProvider } from "./providers/mock.js";`],
    ["a namespace import of providers.js and instanceof through it", `import * as P from "./providers.js";\nif (p instanceof P.MockProvider) x();`],
    ["a name compared with DEFAULT_PROVIDER, which is the name mock", `if (r.provider === DEFAULT_PROVIDER) out("[MOCK] ");`],
    ["a name compared with an entry of PROVIDER_NAMES", `if (provider.name !== PROVIDER_NAMES[0]) throw e;`],
    ["a map from name to fact with the names as bare object keys", `const mock = ({ mock: true, flop: false } as Record<string, boolean>)[pname];`],
    ["a regular expression literal that matches a name", `if (!/^mock$/.test(provider.name)) throw e;`],
  ];
  for (const [label, src] of realistic) {
    it(`realistic miss: ${label}`, () => {
      expect(findings(src)).not.toEqual([]);
    });
  }
  const outOfScope: [string, string][] = [
    ["a prefix test", `if (provider.name.startsWith("mo")) x();`],
    ["a name built by concatenation", `if (provider.name === "mo" + "ck") x();`],
    ["a name with a unicode escape", `if (provider.name === "mo\\u0063k") x();`],
  ];
  for (const [label, src] of outOfScope) {
    it(`hostile, out of scope by rule (F2), not flagged: ${label}`, () => {
      expect(findings(src)).toEqual([]);
    });
  }
  it("hostile, caught: an angle bracket cast to a concrete class", () => {
    expect(findings(`const s = (<MockProvider>provider).scenario;`)).not.toEqual([]);
  });
});
