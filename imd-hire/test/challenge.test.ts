import { describe, expect, it } from "vitest";
import { chainIdOf, parseChallenge } from "../src/challenge.js";
import { EXIT, HireError } from "../src/errors.js";
import { challengeBody, EXPIRES, IMD, ISSUED } from "./helpers.js";

describe("the 402 challenge is parsed strictly", () => {
  it("reads the captured challenge", () => {
    const ch = parseChallenge(challengeBody());
    expect(ch.accepted).toEqual({ scheme: "exact", network: "eip155:1", asset: IMD, amount: "500000000000000000", payTo: "0x4e0fa57bde726079356537e2f34d671e9f41adbc", maxTimeoutSeconds: 300, extra: { assetTransferMethod: "permit2" } });
    expect(ch.quote).toMatchObject({ id: "06423b07-dddf-41af-8bdf-f8d03dd925d8", action: "job.open", issuedAt: ISSUED, expiresAt: EXPIRES });
    expect(ch.resourceUrl).toBe("https://api.imd.fun/requests/06423b07-dddf-41af-8bdf-f8d03dd925d8");
    expect(ch.resource).toEqual({ url: ch.resourceUrl, description: "One job.open request", mimeType: "application/json" });
    expect(chainIdOf(ch.accepted.network)).toBe(1);
    // What is sent back as `accepted` is the requirement as it was given.
    expect(ch.accepted).toEqual(challengeBody().accepts[0]);
  });

  const broken: [string, (b: any) => void, RegExp][] = [ // eslint-disable-line @typescript-eslint/no-explicit-any
    ["two requirements", (b) => b.accepts.push(structuredClone(b.accepts[0])), /exactly one requirement/],
    ["no requirement", (b) => (b.accepts = []), /exactly one requirement/],
    ["another scheme", (b) => (b.accepts[0].scheme = "upto"), /scheme is not exact/],
    ["a field it does not know", (b) => (b.accepts[0].feePayer = "0x0000000000000000000000000000000000000001"), /does not know/],
    ["another transfer method", (b) => (b.accepts[0].extra.assetTransferMethod = "eip3009"), /extra is not exactly/],
    ["more in extra", (b) => (b.accepts[0].extra.name = "IMD"), /extra is not exactly/],
    ["an amount of 0", (b) => (b.accepts[0].amount = "0"), /positive whole number/],
    ["a fractional amount", (b) => (b.accepts[0].amount = "0.5"), /positive whole number/],
    ["an amount that is a number", (b) => (b.accepts[0].amount = 500000000000000000), /positive whole number/],
    ["a network that is not eip155", (b) => (b.accepts[0].network = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"), /eip155/],
    ["an asset that is no address", (b) => (b.accepts[0].asset = "0x1234"), /asset is not an address/],
    ["no quote", (b) => delete b.quote, /quote is missing/],
    ["a quote hash that is not 64 hex", (b) => (b.quote.quoteHash = "0x" + b.quote.quoteHash), /quoteHash/],
    ["a scope hash that is not 64 hex", (b) => (b.requesterScopeHash = "f0dd"), /requesterScopeHash/],
    ["an expiry that is text", (b) => (b.quote.expiresAt = String(EXPIRES)), /expiresAt/],
    ["another x402 version", (b) => (b.x402Version = 1), /x402Version/],
    ["a resource with a field it does not know", (b) => (b.resource.serviceName = "x"), /resource holds a field/],
    ["no input", (b) => delete b.input, /input is missing/],
  ];
  for (const [name, edit, why] of broken) {
    it(`refuses ${name}`, () => {
      const body = challengeBody();
      edit(body);
      expect(() => parseChallenge(body)).toThrow(why);
      try {
        parseChallenge(body);
      } catch (e) {
        expect((e as HireError).code).toBe(EXIT.USAGE);
      }
    });
  }
  it("refuses what is not an object, and lists every problem it finds", () => {
    for (const bad of [null, "challenge", 402, []]) expect(() => parseChallenge(bad)).toThrow(/not an object/);
    const body = challengeBody();
    body.x402Version = 3;
    body.accepts[0].amount = "-1";
    body.requesterScopeHash = "";
    expect(() => parseChallenge(body)).toThrow(/x402Version is not 2; .*amount.*; requesterScopeHash/);
  });
});
