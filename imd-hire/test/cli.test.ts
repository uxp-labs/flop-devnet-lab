import { decodePaymentSignatureHeader } from "@x402/core/http";
import { mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseTransaction, recoverTypedDataAddress, type TransactionSerializedEIP1559 } from "viem";
import { quoteApproval } from "../src/approval.js";
import { parseChallenge } from "../src/challenge.js";
import { cli, EXPIRES, fixture, ISSUED, read, rehash, request, save, TEST_KEY, tmpJob, tmpKeyDir } from "./helpers.js";

const NOW = ISSUED + 30;
beforeEach(() => vi.useFakeTimers({ now: NOW * 1000, toFake: ["Date"] }));
afterEach(() => vi.useRealTimers());

const ORDER_ID = "06423b07-dddf-41af-8bdf-f8d03dd925d8";

/** A job folder taken as far as a saved challenge: wallet, quote, the quote's answer, the challenge request, its answer. */
async function quoted(edit: { quote?: (r: any) => void; challenge?: (r: any) => void } = {}) { // eslint-disable-line @typescript-eslint/no-explicit-any
  const dir = tmpJob();
  const key = join(tmpKeyDir(), "wallet.key");
  const made = await cli(["wallet", "new", "--key", key]);
  const address = made.out.match(/address (0x[0-9a-fA-F]{40})/)![1];
  expect((await cli(["quote", "--dir", dir])).code).toBe(0);
  const answer = fixture("quote-response.json");
  answer.body.order.requestKey = read(dir, "order.json").requestKey;
  edit.quote?.(answer);
  save(dir, "1-quote.response.json", answer);
  const ch = fixture("challenge-response.json");
  edit.challenge?.(ch);
  save(dir, "2-challenge.response.json", ch);
  return { dir, key, address };
}
const pay = (dir: string, key: string, max = "0.5") => cli(["pay", "--dir", dir, "--key", key, "--max-imd", max]);

describe("the whole flow, offline", () => {
  it("quote writes the request to send and keeps one order per folder", async () => {
    const dir = tmpJob();
    const first = await cli(["quote", "--dir", dir]);
    expect(first.code).toBe(0);
    expect(first.out).toMatch(/new order/);
    const order = read(dir, "order.json");
    expect(order.token).toMatch(/^[0-9a-f]{64}$/);
    expect(order.requestKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    const sent = read(dir, "1-quote.request.json");
    expect(sent).toMatchObject({ method: "POST", url: "https://api.imd.fun/requests/quote", headers: { Authorization: `Bearer ${order.token}`, "Content-Type": "application/json" } });
    expect(JSON.parse(sent.body)).toEqual({ requestKey: order.requestKey, action: "job.open", input: request().input });
    // Asking again reuses the key, so a retry returns the same quote.
    const again = await cli(["quote", "--dir", dir]);
    expect(again.out).toMatch(/same order as before/);
    expect(read(dir, "order.json")).toEqual(order);
    // --new starts another order.
    expect((await cli(["quote", "--dir", dir, "--new"])).code).toBe(0);
    expect(read(dir, "order.json").requestKey).not.toBe(order.requestKey);
    for (const f of ["order.json", "1-quote.request.json"]) expect(statSync(join(dir, f)).mode & 0o077).toBe(0);
  });

  it("challenge asks for the 402 of the quoted order, with no body", async () => {
    const { dir } = await quoted();
    const r = await cli(["challenge", "--dir", dir]);
    expect(r.code, r.err).toBe(0);
    const order = read(dir, "order.json");
    expect(read(dir, "2-challenge.request.json")).toEqual({ method: "POST", url: `https://api.imd.fun/requests/${ORDER_ID}/submit`, headers: { Authorization: `Bearer ${order.token}` }, body: null });
  });

  it("pay signs both payloads for the captured challenge and writes the request to send", async () => {
    const { dir, key, address } = await quoted();
    const r = await pay(dir, key);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/pays {4}0\.5 IMD \(maximum approved 0\.5 IMD\)/);
    const order = read(dir, "order.json");
    const sent = read(dir, "3-submit.request.json");
    expect(sent.method).toBe("POST");
    expect(sent.url).toBe(`https://api.imd.fun/requests/${ORDER_ID}/submit`);
    expect(Object.keys(sent.headers).sort()).toEqual(["Authorization", "Content-Type", "PAYMENT-SIGNATURE"]);
    expect(sent.headers.Authorization).toBe(`Bearer ${order.token}`);
    const payment = decodePaymentSignatureHeader(sent.headers["PAYMENT-SIGNATURE"]) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(payment.payload.permit2Authorization.from).toBe(address);
    expect(payment.payload.permit2Authorization.permitted.amount).toBe("500000000000000000");
    expect(Number(payment.payload.permit2Authorization.deadline)).toBe(NOW + 300);
    const body = JSON.parse(sent.body);
    expect(Object.keys(body)).toEqual(["quoteSignature"]);
    expect(body.quoteSignature).toMatch(/^0x[0-9a-f]{130}$/);
    // The approval in the body is this wallet's signature over the payment in the header.
    const ch = parseChallenge(fixture("challenge-response.json").body);
    expect(await recoverTypedDataAddress({ ...quoteApproval(ch, payment), signature: body.quoteSignature })).toBe(address);
    expect(read(dir, "signed.json")).toMatchObject({ payer: address, orderId: ORDER_ID, action: "job.open", network: "eip155:1", amount: "500000000000000000", paymentDeadline: NOW + 300, quoteExpiresAt: EXPIRES, quoteSignature: body.quoteSignature });
  });

  it("the key reaches no file but its own, and no output", async () => {
    const { dir, key } = await quoted();
    const r = await pay(dir, key);
    const secret = JSON.parse(readFileSync(key, "utf8")).key_hex.slice(2);
    const written = readdirSync(dir).map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
    for (const text of [written, r.out, r.err]) expect(text.toLowerCase()).not.toContain(secret.toLowerCase());
  });

  it("pay refuses to sign a second payment for the same order", async () => {
    const { dir, key } = await quoted();
    expect((await pay(dir, key)).code).toBe(0);
    const before = readFileSync(join(dir, "3-submit.request.json"), "utf8");
    const again = await pay(dir, key);
    expect(again.code).toBe(3);
    expect(again.err).toMatch(/already signed in this folder.*safe to resend/);
    expect(readFileSync(join(dir, "3-submit.request.json"), "utf8")).toBe(before);
    // And a folder that holds a signed payment cannot be turned into a new order.
    expect((await cli(["quote", "--dir", dir, "--new"])).code).toBe(3);
  });

  it("pay signs one payment per folder, even when the saved answers are swapped for another order's", async () => {
    const { dir, key } = await quoted();
    expect((await pay(dir, key)).code).toBe(0);
    const before = readFileSync(join(dir, "3-submit.request.json"), "utf8");
    const record = readFileSync(join(dir, "signed.json"), "utf8");
    const other = "11111111-2222-4333-8444-555555555555";
    const quote = read(dir, "1-quote.response.json");
    quote.body.order.id = other;
    save(dir, "1-quote.response.json", quote);
    const ch = read(dir, "2-challenge.response.json");
    ch.body.quote.id = other;
    ch.body.resourceUrl = ch.body.resource.url = `https://api.imd.fun/requests/${other}`;
    save(dir, "2-challenge.response.json", ch);
    const second = await pay(dir, key);
    expect(second.code).toBe(3);
    expect(second.err).toMatch(/already signed in this folder/);
    expect(readFileSync(join(dir, "3-submit.request.json"), "utf8")).toBe(before);
    expect(readFileSync(join(dir, "signed.json"), "utf8")).toBe(record);
  });

  it("pay pays IMD's pinned recipient only, unless the owner names another", async () => {
    const elsewhere = "0x00000000000000000000000000000000000000aa";
    const moved = { challenge: (c: any) => { c.body.accepts[0].payTo = c.body.quote.payment.payTo = elsewhere; } }; // eslint-disable-line @typescript-eslint/no-explicit-any
    const a = await quoted(moved);
    const refusedPay = await pay(a.dir, a.key);
    expect(refusedPay.code).toBe(3);
    expect(refusedPay.err).toMatch(/is not IMD's recipient 0x4e0fa57bde726079356537e2f34d671e9f41adbc/);
    expect(readdirSync(a.dir)).not.toContain("3-submit.request.json");
    // The owner's own word moves it: --pay-to names the recipient, and then only that one is paid.
    const b = await quoted(moved);
    expect((await cli(["pay", "--dir", b.dir, "--key", b.key, "--max-imd", "0.5", "--pay-to", elsewhere])).code).toBe(0);
    const c = await quoted();
    expect((await cli(["pay", "--dir", c.dir, "--key", c.key, "--max-imd", "0.5", "--pay-to", elsewhere])).code).toBe(3);
    expect((await cli(["pay", "--dir", c.dir, "--key", c.key, "--max-imd", "0.5", "--pay-to", "0xnope"])).code).toBe(2);
    // No recipient is pinned on Robinhood Chain: the owner must name one.
    const d = await cli(["pay", "--dir", c.dir, "--key", c.key, "--max-imd", "0.5", "--chain", "4663"]);
    expect(d.code).toBe(2);
    expect(d.err).toMatch(/no IMD recipient is pinned for chain 4663/);
  });

  it("pay refuses a payment window or a quote longer than IMD's", async () => {
    const long = await quoted({ challenge: (c) => { c.body.accepts[0].maxTimeoutSeconds = 315360000; c.body.quote.expiresAt = c.body.quote.issuedAt + 630720000; } });
    const r = await pay(long.dir, long.key);
    expect(r.code).toBe(3);
    expect(r.err).toMatch(/longer than 300 s/);
    const far = await quoted({ challenge: (c) => (c.body.quote.expiresAt = 9e12) });
    const f = await pay(far.dir, far.key);
    expect(f.code).toBe(3);
    expect(readdirSync(far.dir)).not.toContain("3-submit.request.json");
    expect(readdirSync(far.dir)).not.toContain("signed.json");
  });

  it("pay refuses a key that sits inside the job folder, which goes to the sender", async () => {
    const { dir } = await quoted();
    const inside = join(dir, "wallet.key");
    expect((await cli(["wallet", "new", "--key", inside])).code).toBe(0);
    const r = await pay(dir, inside);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/inside the job folder/);
    expect(readdirSync(dir)).not.toContain("3-submit.request.json");
  });

  it("amounts typed in atomic units are caught, for the price limit and for the allowance", async () => {
    const { dir, key } = await quoted();
    const price = await pay(dir, key, "500000000000000000");
    expect(price.code).toBe(2);
    expect(price.err).toMatch(/in IMD, not atomic units/);
    expect(readdirSync(dir)).not.toContain("3-submit.request.json");
    const allowance = await cli(["approve", "--key", key, "--allowance-imd", "5000000000000000000", "--nonce", "0", "--gas", "60000", "--max-fee-gwei", "0.2", "--priority-fee-gwei", "0.01"]);
    expect(allowance.code).toBe(3);
    expect(allowance.err).toMatch(/typed in atomic units/);
  });

  it("a key typed where the key file belongs is refused and never echoed", async () => {
    for (const args of [["wallet", "address", "--key", TEST_KEY], ["wallet", "new", "--key", TEST_KEY.slice(2)]]) {
      const r = await cli(args);
      expect(r.code).toBe(2);
      expect((r.out + r.err).toLowerCase()).not.toContain(TEST_KEY.slice(2, 24));
    }
  });

  it("no step writes through a link planted in the job folder", async () => {
    const dir = tmpJob();
    const target = join(mkdtempSync(join(tmpdir(), "imd-hire-target-")), "elsewhere.json");
    writeFileSync(target, "untouched");
    symlinkSync(target, join(dir, "1-quote.request.json"));
    const r = await cli(["quote", "--dir", dir]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/does not write through links/);
    expect(readFileSync(target, "utf8")).toBe("untouched");
  });

  const refusals: [string, Parameters<typeof quoted>[0], string, RegExp][] = [
    ["a price above the approved maximum", {}, "0.49", /above the approved maximum/],
    ["a challenge for another order", { challenge: (c) => { c.body.quote.id = "another"; c.body.resourceUrl = c.body.resource.url = "https://api.imd.fun/requests/another"; } }, "0.5", /not the quoted order/],
    ["a quote answer for another requestKey", { quote: (q) => (q.body.order.requestKey = "00000000-0000-4000-8000-000000000000") }, "0.5", /stale answer/],
    ["an input that is not the request in the folder", { challenge: (c) => { c.body.input.baseCommit = "f".repeat(40); rehash(c.body); } }, "0.5", /not the request that was approved/],
    ["an input the quote's hash does not cover", { challenge: (c) => (c.body.input.contracts = ["Vault.sol"]) }, "0.5", /inputHash is not the hash/],
    ["another recipient in the requirement", { challenge: (c) => (c.body.accepts[0].payTo = "0x00000000000000000000000000000000000000aa") }, "0.5", /different recipients/],
    ["another asset", { challenge: (c) => { c.body.accepts[0].asset = c.body.quote.payment.asset = "0x5f7bb59365ce557c26dbcaa4ee9d39a4b95b7127"; } }, "0.5", /is not the IMD token/],
  ];
  for (const [name, edit, max, why] of refusals) {
    it(`pay refuses ${name}, exits 3 and writes nothing to send`, async () => {
      const { dir, key } = await quoted(edit);
      const r = await pay(dir, key, max);
      expect(r.code).toBe(3);
      expect(r.err).toMatch(/nothing signed|refused/);
      expect(r.err).toMatch(why);
      expect(readdirSync(dir)).not.toContain("3-submit.request.json");
      expect(readdirSync(dir)).not.toContain("signed.json");
    });
  }

  it("pay refuses an expired quote and one too close to its expiry", async () => {
    const { dir, key } = await quoted();
    vi.setSystemTime((EXPIRES + 1) * 1000);
    expect((await pay(dir, key)).err).toMatch(/expired; quote again/);
    vi.setSystemTime((EXPIRES - 200) * 1000);
    const late = await pay(dir, key);
    expect(late.code).toBe(3);
    expect(late.err).toMatch(/too close to its expiry/);
    expect(readdirSync(dir)).not.toContain("3-submit.request.json");
  });

  it("pay needs a 402 answer, a key and a maximum", async () => {
    const { dir, key } = await quoted({ challenge: (c) => (c.status = 200) });
    expect((await pay(dir, key)).code).toBe(2);
    const ok = await quoted();
    expect((await cli(["pay", "--dir", ok.dir, "--key", ok.key])).code).toBe(2);
    expect((await cli(["pay", "--dir", ok.dir, "--max-imd", "0.5"])).code).toBe(2);
    expect((await cli(["pay", "--dir", ok.dir, "--key", ok.key, "--max-imd", "1e3"])).code).toBe(2);
    expect((await cli(["pay", "--dir", ok.dir, "--key", ok.key, "--max-imd", "0.5", "--chain", "5"])).code).toBe(2);
  });

  it("order writes the status request, which never charges", async () => {
    const { dir } = await quoted();
    expect((await cli(["order", "--dir", dir])).code).toBe(0);
    const order = read(dir, "order.json");
    expect(read(dir, "4-order.request.json")).toEqual({ method: "GET", url: `https://api.imd.fun/requests/${ORDER_ID}`, headers: { Authorization: `Bearer ${order.token}` }, body: null });
  });

  it("the steps refuse to run out of order", async () => {
    const dir = tmpJob();
    expect((await cli(["challenge", "--dir", dir])).code).toBe(2);
    expect((await cli(["quote", "--dir", dir])).code).toBe(0);
    const early = await cli(["challenge", "--dir", dir]);
    expect(early.code).toBe(2);
    expect(early.err).toMatch(/1-quote.response.json is missing/);
    save(dir, "1-quote.response.json", { status: 422, body: { error: "invalid_input" } });
    expect((await cli(["challenge", "--dir", dir])).err).toMatch(/status 422/);
  });

  it("approve prints a signed transaction for Permit2 and sends nothing", async () => {
    const { key, address } = await quoted();
    const r = await cli(["approve", "--key", key, "--allowance-imd", "5", "--nonce", "0", "--gas", "60000", "--max-fee-gwei", "0.2", "--priority-fee-gwei", "0.01"]);
    expect(r.code, r.err).toBe(0);
    const out = JSON.parse(r.out);
    expect(out).toMatchObject({ from: address, to: "0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7", spender: "0x000000000022D473030F116dDEE9F6B43aC78BA3", amount: "5000000000000000000", allowance: "5 IMD", chainId: 1, nonce: 0, sent: false });
    expect(parseTransaction(out.raw as TransactionSerializedEIP1559).chainId).toBe(1);
    const dear = await cli(["approve", "--key", key, "--allowance-imd", "5", "--nonce", "0", "--gas", "60000", "--max-fee-gwei", "500", "--priority-fee-gwei", "1"]);
    expect(dear.code).toBe(3);
    expect(dear.err).toMatch(/above the limit/);
    expect((await cli(["approve", "--key", key, "--allowance-imd", "5", "--nonce", "x", "--gas", "60000", "--max-fee-gwei", "0.2", "--priority-fee-gwei", "0.01"])).code).toBe(2);
  });

  it("help, an unknown command and an unknown flag", async () => {
    expect((await cli([])).out).toMatch(/never touches the network/);
    expect((await cli(["send"])).code).toBe(2);
    expect((await cli(["quote", "--dir", tmpJob(), "--send"])).code).toBe(2);
  });
});
