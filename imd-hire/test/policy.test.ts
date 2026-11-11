import { describe, expect, it } from "vitest";
import { parseChallenge } from "../src/challenge.js";
import { checkChallenge, holds, type Policy } from "../src/policy.js";
import { challengeBody, EXPIRES, HALF_IMD, IMD, ISSUED, request } from "./helpers.js";

const NOW = ISSUED + 30;
const policy = (over: Partial<Policy> = {}): Policy => ({ api: "https://api.imd.fun", chainId: 1, token: IMD, maxAmount: HALF_IMD, action: "job.open", input: request().input, ...over });
const check = (edit: (b: any) => void = () => {}, p: Policy = policy(), now = NOW) => { // eslint-disable-line @typescript-eslint/no-explicit-any
  const body = challengeBody();
  edit(body);
  return checkChallenge(parseChallenge(body), p, now);
};

describe("a challenge is signed only when it asks for what was approved", () => {
  it("the captured challenge passes for the request that was quoted", () => {
    expect(check()).toEqual([]);
    expect(check(() => {}, policy({ maxAmount: HALF_IMD * 2n }))).toEqual([]);
    expect(check(() => {}, policy({ token: IMD.toUpperCase().replace("0X", "0x") as `0x${string}` }))).toEqual([]);
  });

  const refusedFor: [string, (b: any) => void, RegExp][] = [ // eslint-disable-line @typescript-eslint/no-explicit-any
    ["another chain in the requirement", (b) => (b.accepts[0].network = "eip155:4663"), /not eip155:1/],
    ["another chain in the quote only", (b) => (b.quote.payment.network = "eip155:4663"), /different networks/],
    ["another asset", (b) => { b.accepts[0].asset = b.quote.payment.asset = "0x5f7bb59365ce557c26dbcaa4ee9d39a4b95b7127"; }, /is not the IMD token/],
    ["an asset that differs between quote and requirement", (b) => (b.quote.payment.asset = "0x5f7bb59365ce557c26dbcaa4ee9d39a4b95b7127"), /different assets/],
    ["a price above the maximum", (b) => { b.accepts[0].amount = b.quote.payment.amount = "500000000000000001"; }, /above the approved maximum/],
    ["an amount that differs between quote and requirement", (b) => (b.accepts[0].amount = "400000000000000000"), /different amounts/],
    ["a recipient that differs between quote and requirement", (b) => (b.accepts[0].payTo = "0x00000000000000000000000000000000000000aa"), /different recipients/],
    ["a resourceUrl on another host", (b) => { b.resourceUrl = b.resource.url = "https://api.imd.example/requests/" + b.quote.id; }, /resourceUrl is not/],
    ["a resourceUrl for another order", (b) => { b.resourceUrl = b.resource.url = "https://api.imd.fun/requests/another"; }, /resourceUrl is not/],
    ["a resource that is not the order", (b) => (b.resource.url = "https://api.imd.fun/requests/another"), /resource.url/],
    ["another action", (b) => (b.quote.action = "launch.open"), /not job.open/],
    ["another commit in the quoted input", (b) => (b.input.baseCommit = "0".repeat(40)), /not the request that was approved/],
    ["another objective in the quoted input", (b) => (b.input.objective += " Also deploy it."), /not the request that was approved/],
    ["a field of the request missing from the quoted input", (b) => delete b.input.template, /not the request that was approved/],
  ];
  for (const [name, edit, why] of refusedFor) {
    it(`refuses ${name}`, () => {
      const reasons = check(edit);
      expect(reasons.join("; ")).toMatch(why);
    });
  }

  it("the server may add defaults to the input, never change or drop what was sent", () => {
    expect(check((b) => (b.input.github = false))).toEqual([]);
    expect(holds({ a: 1, b: [], c: { d: 1, e: 2 } }, { a: 1, c: { d: 1 } })).toBe(true);
    expect(holds({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(holds({ a: [1, 2, 3] }, { a: [1, 2] })).toBe(false);
    expect(holds({ a: "1" }, { a: 1 })).toBe(false);
    expect(holds({ a: null }, { a: {} })).toBe(false);
    expect(holds([], {})).toBe(false);
  });

  it("refuses a quote that is expired, too close to expiry for the payment window, or dated in the future", () => {
    expect(check(() => {}, policy(), EXPIRES)).toEqual(["the quote has expired; quote again"]);
    expect(check(() => {}, policy(), EXPIRES + 5)).toEqual(["the quote has expired; quote again"]);
    // The permit's deadline is now + 300 s and must fall before the expiry: 299 s left is too late, 301 s is fine.
    expect(check(() => {}, policy(), EXPIRES - 300).join()).toMatch(/too close to its expiry/);
    expect(check(() => {}, policy(), EXPIRES - 299).join()).toMatch(/too close to its expiry/);
    expect(check(() => {}, policy(), EXPIRES - 301)).toEqual([]);
    expect(check(() => {}, policy(), ISSUED - 121).join()).toMatch(/dated in the future/);
    expect(check(() => {}, policy(), ISSUED - 119)).toEqual([]);
  });

  it("returns every reason, not only the first", () => {
    const reasons = check((b) => { b.accepts[0].network = "eip155:4663"; b.quote.action = "launch.open"; b.input.objective = "x"; });
    expect(reasons.length).toBeGreaterThanOrEqual(3);
  });
});
