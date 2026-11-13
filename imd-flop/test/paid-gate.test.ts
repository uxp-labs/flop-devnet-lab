import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { cli, readLines, readySeat, tmpHome } from "./helpers.js";
import { checkGenesis, PreSendError, readEthereumChainId } from "../src/gateway.js";
import { NETWORKS, SEAT_CHAIN_ID } from "../src/networks.js";
import { FlopProvider, type Provider } from "../src/providers.js";
import { gatewayKeyFile } from "../src/paths.js";
import { writeSecretFile } from "../src/store.js";
import { clearSecretRegistry } from "../src/secrets.js";
import type { LinkFile } from "../src/link.js";

const PIN = NETWORKS.devnet.genesisHash;
// Same length as the pin, last nibble flipped. A prefix compare would miss this.
const WRONG = PIN.slice(0, -1) + (PIN.endsWith("1") ? "2" : "1");
const ETH = "https://eth.example/rpc";
const RUN = ["run", "--job", "job-abc", "--prompt", "Say hi", "--max-tokens", "8", "--provider", "flop", "--live"];

type Seen = { url: string; body: unknown };
type ChainMode = "ok" | "wrong" | "down" | "http" | "malformed" | "decimal" | "empty" | "rpc-error";
type FaucetMode = "pin" | "wrong" | "down" | "http" | "malformed" | "short";
type WsMode = "pin" | "wrong" | "down" | "malformed" | "short" | "error-result";

class SpyFlop implements Provider {
  readonly name = "flop" as const;
  calls = 0;
  estimates = 0;
  async estimate() {
    this.estimates++;
    return { estimated_cost_flop: 0.012, estimated_input_tokens: 1, estimated_output_tokens: 1 };
  }
  async complete() {
    this.calls++;
    return {
      request_id: "spy",
      text: "[offline spy, no inference]",
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost_flop: 0.01 },
    };
  }
  async readReceipt(requestId: string) {
    return {
      http: 200,
      error: null,
      receipt: {
        request_id: requestId,
        correlation_id: "imd-job-job-abc",
        model: "spy",
        reserved_spend: 0.01,
        settled_spend: null,
        settled_spend_raw: null,
        terminal_event: null,
        channel_id: null,
        created_at: 0,
        state: "estimated" as const,
        response_status: 200,
      },
    };
  }
}

function rpc(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}

function isPaid(url: string): boolean {
  return url.includes("api.flop.network") || url.includes("/keys/ephemeral") || url.includes("/chat/completions");
}

function scripted(opts: { chain?: ChainMode; faucet?: FaucetMode; owner?: string | null | "down" }, seen: Seen[]): typeof fetch {
  const chain = opts.chain ?? "ok";
  const faucet = opts.faucet ?? "pin";
  return (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    let body: unknown = null;
    if (init?.body) {
      try {
        body = JSON.parse(String(init.body));
      } catch {
        body = String(init.body);
      }
    }
    seen.push({ url, body });
    if (isPaid(url)) throw new Error(`paid call ${url}`);
    const method = (body as { method?: string } | null)?.method;
    if (method === "eth_chainId") {
      if (chain === "down") throw new Error("eth rpc down");
      if (chain === "http") return new Response("no", { status: 503 });
      if (chain === "malformed") return new Response("not-json", { status: 200 });
      if (chain === "decimal") return rpc({ jsonrpc: "2.0", id: 1, result: "1" });
      if (chain === "empty") return rpc({ jsonrpc: "2.0", id: 1, result: "0x" });
      if (chain === "rpc-error") return rpc({ jsonrpc: "2.0", id: 1, error: { message: "boom" }, result: "0x1" });
      return rpc({ jsonrpc: "2.0", id: 1, result: chain === "wrong" ? "0x5" : "0x1" });
    }
    if (method === "eth_call") {
      if (opts.owner === "down" || opts.owner === undefined) throw new Error("ownerOf down");
      if (opts.owner === null) return rpc({ jsonrpc: "2.0", id: 1, error: { code: 3, message: "execution reverted" } });
      return rpc({ jsonrpc: "2.0", id: 1, result: "0x" + "0".repeat(24) + opts.owner.slice(2).toLowerCase() });
    }
    if (url.endsWith("/chain")) {
      if (faucet === "down") throw new Error("faucet down");
      if (faucet === "http") return new Response(JSON.stringify({ genesisHash: PIN }), { status: 500, headers: { "content-type": "application/json" } });
      if (faucet === "malformed") return new Response("<html>nope</html>", { status: 200 });
      if (faucet === "short") return rpc({ genesisHash: PIN.slice(0, 18) });
      if (faucet === "wrong") return rpc({ genesisHash: WRONG });
      return rpc({ genesisHash: PIN });
    }
    throw new Error(`unexpected url ${url}`);
  }) as typeof fetch;
}

async function signHolder(h: string, seat = "42"): Promise<string> {
  const file = join(h, "seats", seat, "link.json");
  const link = JSON.parse(readFileSync(file, "utf8")) as LinkFile;
  const wallet = privateKeyToAccount(generatePrivateKey());
  const td = link.eip712;
  const sig = await wallet.signTypedData({
    domain: td.domain,
    types: td.types,
    primaryType: td.primaryType,
    message: { ...td.message, tokenId: BigInt(td.message.tokenId), issuedAt: BigInt(td.message.issuedAt) },
  });
  writeFileSync(file, JSON.stringify({ ...link, wallet: { address: wallet.address, signature: sig } }));
  return wallet.address;
}

async function withWs<T>(mode: WsMode, fn: () => Promise<T>): Promise<T> {
  const real = globalThis.WebSocket;
  class FakeWS {
    onopen?: () => void;
    onmessage?: (ev: { data: string }) => void;
    onerror?: () => void;
    constructor() {
      if (mode === "down") throw new Error("rpc down");
      setTimeout(() => this.onopen?.(), 0);
    }
    send() {
      setTimeout(() => {
        if (mode === "malformed") this.onmessage?.({ data: "not-json{" });
        else if (mode === "short") this.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", id: 1, result: PIN.slice(0, 18) }) });
        else if (mode === "error-result") this.onmessage?.({ data: JSON.stringify({ error: { message: "nope" }, result: PIN }) });
        else this.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", id: 1, result: mode === "wrong" ? WRONG : PIN }) });
      }, 0);
    }
    close() {}
  }
  (globalThis as { WebSocket: unknown }).WebSocket = FakeWS;
  try {
    return await fn();
  } finally {
    globalThis.WebSocket = real;
  }
}

function expectNothingPaid(h: string, spy: SpyFlop, seen: Seen[]) {
  expect(spy.calls).toBe(0);
  expect(spy.estimates).toBe(0);
  expect(seen.some((s) => isPaid(s.url))).toBe(false);
  expect(existsSync(join(h, "responses"))).toBe(false);
  if (existsSync(join(h, "ledger.jsonl"))) {
    const rows = readLines(join(h, "ledger.jsonl")) as { state?: string; cap_charge?: number }[];
    expect(rows.some((r) => r.state === "sent" || (typeof r.cap_charge === "number" && r.cap_charge > 0))).toBe(false);
  }
}

async function runPaid(opts: { chain?: ChainMode; faucet?: FaucetMode; owner?: string | null | "down"; ws?: WsMode; eth?: boolean }) {
  const h = tmpHome();
  await readySeat(h);
  const spy = new SpyFlop();
  const seen: Seen[] = [];
  const fetchImpl = scripted({ chain: opts.chain, faucet: opts.faucet, owner: opts.owner }, seen);
  const env: NodeJS.ProcessEnv = { IMD_FLOP_HOME: h };
  if (opts.eth !== false) env.ETH_RPC_URL = ETH;
  const result = await withWs(opts.ws ?? "pin", () =>
    cli(h, RUN, { provider: spy, fetch: fetchImpl, env }),
  );
  return { h, spy, seen, ...result };
}

const REQ = {
  model: "qwen/qwen2.5-0.5b-instruct",
  messages: [{ role: "user" as const, content: "hi" }],
  max_tokens: 8,
  requestId: "req-1",
  correlationId: "imd-job-job-abc",
  maxCostFlop: 0.1,
  signal: new AbortController().signal,
};

describe("chain id and genesis parsers fail closed", () => {
  it("uses the project pin and chain id, and accepts only a hex chain id of 1", async () => {
    expect(PIN).toMatch(/^0x[0-9a-f]{64}$/);
    expect(SEAT_CHAIN_ID).toBe(1);
    expect(WRONG).toHaveLength(PIN.length);
    expect(WRONG).not.toBe(PIN);
    const ok = (async () => rpc({ jsonrpc: "2.0", id: 1, result: "0x01" })) as typeof fetch;
    expect(await readEthereumChainId(ETH, ok)).toBe(1n);
    const decimal = (async () => rpc({ jsonrpc: "2.0", id: 1, result: "1" })) as typeof fetch;
    await expect(readEthereumChainId(ETH, decimal)).rejects.toThrow(/malformed/);
  });

  it("a faucet HTTP error is ignored even when the body and the RPC both repeat the pin", async () => {
    const faucet = (async () => new Response(JSON.stringify({ genesisHash: PIN }), { status: 500 })) as typeof fetch;
    const g = await withWs("pin", () => checkGenesis(NETWORKS.devnet, faucet));
    expect(g.ok).toBe(false);
    expect(g.faucetGenesis).toBeNull();
    expect(g.rpcGenesis).toBe(PIN);
    expect(g.error).toMatch(/faucet HTTP 500/);
  });

  it("malformed or prefix-only replies fail even when the other source has the full pin", async () => {
    const badFaucet = (async () => new Response("<html>", { status: 200 })) as typeof fetch;
    const bad = await withWs("pin", () => checkGenesis(NETWORKS.devnet, badFaucet));
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/malformed JSON/);

    const shortFaucet = (async () => rpc({ genesisHash: PIN.slice(0, 18) })) as typeof fetch;
    const short = await withWs("pin", () => checkGenesis(NETWORKS.devnet, shortFaucet));
    expect(short.ok).toBe(false);
    expect(short.faucetGenesis).toBeNull();

    const pinFaucet = (async () => rpc({ genesisHash: PIN })) as typeof fetch;
    const prefixRpc = await withWs("short", () => checkGenesis(NETWORKS.devnet, pinFaucet));
    expect(prefixRpc.ok).toBe(false);
    expect(prefixRpc.rpcGenesis).toBeNull();
    expect(prefixRpc.faucetGenesis).toBe(PIN);

    const lied = await withWs("error-result", () => checkGenesis(NETWORKS.devnet, pinFaucet));
    expect(lied.ok).toBe(false);
    expect(lied.rpcGenesis).toBeNull();
  });

  it("faucet and RPC agreeing on another full hash is still a failed check", async () => {
    const faucet = (async () => rpc({ genesisHash: WRONG })) as typeof fetch;
    const g = await withWs("wrong", () => checkGenesis(NETWORKS.devnet, faucet));
    expect(g.ok).toBe(false);
    expect(g.faucetGenesis).toBe(WRONG);
    expect(g.rpcGenesis).toBe(WRONG);
    expect(g.pinnedGenesis).toBe(PIN);
    expect(g.error).toMatch(/agree on a different genesis/);
  });
});

describe("paid run refuses before any paid call", () => {
  it("refuses a wrong Ethereum chain and does not call ownerOf or the gateway", async () => {
    const { h, spy, seen, code, err } = await runPaid({ chain: "wrong" });
    expect(code).toBe(5);
    expect(err).toMatch(/refused locally, nothing sent/);
    expect(err).toMatch(/chain id 5 is not 1/);
    expectNothingPaid(h, spy, seen);
    expect(seen.map((s) => (s.body as { method?: string }).method)).toEqual(["eth_chainId"]);
  });

  it("refuses when faucet and RPC agree on a different genesis", async () => {
    const { h, spy, seen, code, err } = await runPaid({ faucet: "wrong", ws: "wrong" });
    expect(code).toBe(5);
    expect(err).toMatch(/agree on a different genesis/);
    expect(err).toContain(PIN);
    // Moved (review of the audit 33f3b9f fixes): the reported genesis is server text, shown as its first 10 and last
    // 6 characters. The pinned one is ours and printed in full. Was the whole WRONG hash.
    expect(err).toContain(`${WRONG.slice(0, 10)}...${WRONG.slice(-6)}`);
    expect(err).not.toContain(WRONG);
    expectNothingPaid(h, spy, seen);
    expect(seen.some((s) => (s.body as { method?: string })?.method === "eth_call")).toBe(false);
  });

  it("refuses when the faucet hash is wrong and the RPC still has the pin", async () => {
    const faucet = (async () => rpc({ genesisHash: WRONG })) as typeof fetch;
    const g = await withWs("pin", () => checkGenesis(NETWORKS.devnet, faucet));
    expect(g.ok).toBe(false);
    expect(g.faucetGenesis).toBe(WRONG);
    expect(g.rpcGenesis).toBe(PIN);
    expect(g.error).toBe("genesis mismatch");
    const { h, spy, seen, code, err } = await runPaid({ faucet: "wrong", ws: "pin" });
    expect(code).toBe(5);
    expect(err).toMatch(/genesis mismatch/);
    expect(err).toContain(PIN);
    // Moved (review of the audit 33f3b9f fixes): the reported genesis is server text, shown as its first 10 and last
    // 6 characters. The pinned one is ours and printed in full. Was the whole WRONG hash.
    expect(err).toContain(`${WRONG.slice(0, 10)}...${WRONG.slice(-6)}`);
    expect(err).not.toContain(WRONG);
    expect(err).not.toMatch(/agree on a different genesis/);
    expectNothingPaid(h, spy, seen);
  });

  it("refuses when the faucet has the pin and the RPC hash is wrong", async () => {
    const faucet = (async () => rpc({ genesisHash: PIN })) as typeof fetch;
    const g = await withWs("wrong", () => checkGenesis(NETWORKS.devnet, faucet));
    expect(g.ok).toBe(false);
    expect(g.faucetGenesis).toBe(PIN);
    expect(g.rpcGenesis).toBe(WRONG);
    expect(g.error).toBe("genesis mismatch");
    const { h, spy, seen, code, err } = await runPaid({ faucet: "pin", ws: "wrong" });
    expect(code).toBe(5);
    expect(err).toMatch(/genesis mismatch/);
    expect(err).toContain(PIN);
    // Moved (review of the audit 33f3b9f fixes): the reported genesis is server text, shown as its first 10 and last
    // 6 characters. The pinned one is ours and printed in full. Was the whole WRONG hash.
    expect(err).toContain(`${WRONG.slice(0, 10)}...${WRONG.slice(-6)}`);
    expect(err).not.toContain(WRONG);
    expect(err).not.toMatch(/agree on a different genesis/);
    expectNothingPaid(h, spy, seen);
  });

  it("refuses an unavailable or malformed chain id, including a result that also carries an error", async () => {
    for (const chain of ["down", "http", "malformed", "decimal", "empty", "rpc-error"] as const) {
      const { h, spy, seen, code, err } = await runPaid({ chain });
      expect(code, chain).toBe(5);
      expect(err, chain).toMatch(/eth_chainId/);
      expectNothingPaid(h, spy, seen);
    }
  });

  it("refuses when the faucet is down, HTTP 500, or malformed, even if the RPC has the pin", async () => {
    for (const faucet of ["down", "http", "malformed", "short"] as const) {
      const { h, spy, seen, code, err } = await runPaid({ faucet, ws: "pin" });
      expect(code, faucet).toBe(5);
      expect(err, faucet).toMatch(/genesis check failed/);
      expectNothingPaid(h, spy, seen);
    }
  });

  it("refuses when the FLOP RPC is down or its block 0 is malformed, even if the faucet has the pin", async () => {
    for (const ws of ["down", "malformed", "short", "error-result"] as const) {
      const { h, spy, seen, code, err } = await runPaid({ faucet: "pin", ws });
      expect(code, ws).toBe(5);
      expect(err, ws).toMatch(/genesis check failed/);
      expectNothingPaid(h, spy, seen);
    }
  });

  it("refuses with no ETH_RPC_URL and makes no network call", async () => {
    const h = tmpHome();
    await readySeat(h);
    const spy = new SpyFlop();
    const seen: Seen[] = [];
    const r = await cli(h, RUN, {
      provider: spy,
      fetch: scripted({}, seen),
      env: { IMD_FLOP_HOME: h },
    });
    expect(r.code).toBe(5);
    expect(r.err).toMatch(/ETH_RPC_URL/);
    expectNothingPaid(h, spy, seen);
    expect(seen).toEqual([]);
  });

  it("refuses when ownerOf is unavailable after a good chain and genesis", async () => {
    const { h, spy, seen, code, err } = await runPaid({ owner: "down" });
    expect(code).toBe(4);
    expect(err).toMatch(/owner check failed/);
    expectNothingPaid(h, spy, seen);
    expect(seen.some((s) => (s.body as { method?: string })?.method === "eth_call")).toBe(true);
  });

  it("an offline mock run does not query chain id or genesis", async () => {
    const h = tmpHome();
    await readySeat(h);
    const seen: Seen[] = [];
    let sockets = 0;
    const real = globalThis.WebSocket;
    (globalThis as { WebSocket: unknown }).WebSocket = class {
      constructor() {
        sockets++;
        throw new Error("socket");
      }
    };
    try {
      const r = await cli(h, ["run", "--job", "job-abc", "--prompt", "Say hi", "--max-tokens", "8"], {
        fetch: (async (url: unknown) => {
          seen.push({ url: String(url), body: null });
          throw new Error("fetched");
        }) as typeof fetch,
        env: { IMD_FLOP_HOME: h, ETH_RPC_URL: ETH },
      });
      expect(r.code).toBe(0);
      expect(r.out).toMatch(/\[MOCK\]/);
      expect(seen).toEqual([]);
      expect(sockets).toBe(0);
    } finally {
      globalThis.WebSocket = real;
    }
  });

  it("opens the gate for an offline spy when chain id and genesis match, and still contacts no gateway", async () => {
    const h = tmpHome();
    await readySeat(h);
    const owner = await signHolder(h);
    const spy = new SpyFlop();
    const seen: Seen[] = [];
    const r = await withWs("pin", () =>
      cli(h, [...RUN, "--json"], {
        provider: spy,
        fetch: scripted({ owner }, seen),
        env: { IMD_FLOP_HOME: h, ETH_RPC_URL: ETH },
      }),
    );
    expect(r.code).toBe(0);
    expect(r.json().text).toBe("[offline spy, no inference]");
    expect(spy.estimates).toBe(1);
    expect(spy.calls).toBe(1);
    expect(seen.some((s) => isPaid(s.url))).toBe(false);
    expect(seen.some((s) => String(s.url).includes("api.flop.network"))).toBe(false);
  });
});

describe("FlopProvider.complete refuses before the child-key mint", () => {
  it("missing ETH rpc, wrong chain, agreeing-wrong genesis, and a faucet HTTP 500 make zero paid calls", async () => {
    const cases: { name: string; eth?: string; chain?: ChainMode; faucet?: FaucetMode; ws: WsMode; match: RegExp }[] = [
      { name: "no rpc", ws: "pin", match: /ETH_RPC_URL/ },
      { name: "wrong chain", eth: ETH, chain: "wrong", ws: "pin", match: /chain id 5 is not 1/ },
      { name: "agreeing wrong", eth: ETH, faucet: "wrong", ws: "wrong", match: /agree on a different genesis/ },
      { name: "faucet 500", eth: ETH, faucet: "http", ws: "pin", match: /faucet HTTP 500/ },
    ];
    for (const c of cases) {
      const h = tmpHome();
      writeSecretFile(gatewayKeyFile(h, "42"), "test-gateway-bearer\n");
      const seen: Seen[] = [];
      const provider = new FlopProvider(NETWORKS.devnet, gatewayKeyFile(h, "42"), scripted({ chain: c.chain, faucet: c.faucet }, seen), c.eth);
      try {
        await withWs(c.ws, async () => {
          await expect(provider.complete(REQ), c.name).rejects.toBeInstanceOf(PreSendError);
          await expect(provider.complete(REQ), c.name).rejects.toThrow(c.match);
        });
        expect(provider.calls, c.name).toBe(0);
        expect(seen.some((s) => isPaid(s.url)), c.name).toBe(false);
      } finally {
        clearSecretRegistry();
      }
    }
  });

  it("a real paid run whose first gate passes still mints nothing when the pre-mint gate fails", async () => {
    const h = tmpHome();
    await readySeat(h);
    const owner = await signHolder(h);
    writeSecretFile(gatewayKeyFile(h, "42"), "test-gateway-bearer\n");
    const seen: Seen[] = [];
    let faucets = 0;
    let sockets = 0;
    const fetchImpl = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      let body: unknown = null;
      if (init?.body) {
        try {
          body = JSON.parse(String(init.body));
        } catch {
          body = String(init.body);
        }
      }
      seen.push({ url, body });
      if (url.includes("/keys/ephemeral") || url.includes("/chat/completions")) throw new Error(`paid call ${url}`);
      const method = (body as { method?: string } | null)?.method;
      if (method === "eth_chainId") return rpc({ jsonrpc: "2.0", id: 1, result: "0x1" });
      if (method === "eth_call") return rpc({ jsonrpc: "2.0", id: 1, result: "0x" + "0".repeat(24) + owner.slice(2).toLowerCase() });
      if (url.endsWith("/chain")) {
        faucets++;
        return rpc({ genesisHash: faucets === 1 ? PIN : WRONG });
      }
      if (url.endsWith("/models/estimate")) return rpc({ estimated_cost_flop: 0.012, estimated_input_tokens: 1, estimated_output_tokens: 1 });
      throw new Error(`unexpected url ${url}`);
    }) as typeof fetch;
    const real = globalThis.WebSocket;
    class SeqWS {
      onopen?: () => void;
      onmessage?: (ev: { data: string }) => void;
      constructor() {
        sockets++;
        setTimeout(() => this.onopen?.(), 0);
      }
      send() {
        setTimeout(() => this.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", id: 1, result: PIN }) }), 0);
      }
      close() {}
    }
    (globalThis as { WebSocket: unknown }).WebSocket = SeqWS;
    try {
      const r = await cli(h, RUN, { fetch: fetchImpl, env: { IMD_FLOP_HOME: h, ETH_RPC_URL: ETH } });
      // The same refusal as at the first gate, so the same exit code (audit ba164ffa finding 6; was 1).
      expect(r.code).toBe(5);
      expect(r.err).toMatch(/nothing sent/);
      expect(r.err).toMatch(/genesis mismatch/);
      // stderr shows the reason the ledger row gets (swarm audit 33f3b9f, finding 10). Moved again (review of the
      // audit 33f3b9f fixes): the pinned genesis is printed in full and the reported one as 10 ... 6 characters.
      expect(r.err).toContain(PIN);
      expect(r.err).toContain(`${WRONG.slice(0, 10)}...${WRONG.slice(-6)}`);
      expect(r.err).not.toContain(WRONG);
      expect(faucets).toBe(2);
      expect(sockets).toBe(2);
      const estimateAt = seen.findIndex((s) => s.url.endsWith("/models/estimate"));
      const secondFaucetAt = seen.findIndex((s, i) => s.url.endsWith("/chain") && seen.slice(0, i).some((p) => p.url.endsWith("/chain")));
      expect(estimateAt).toBeGreaterThan(-1);
      expect(secondFaucetAt).toBeGreaterThan(estimateAt);
      expect(seen.some((s) => s.url.includes("/keys/ephemeral") || s.url.includes("/chat/completions"))).toBe(false);
      expect(existsSync(join(h, "responses"))).toBe(false);
      const rows = readLines(join(h, "ledger.jsonl")) as { state?: string; cap_charge?: number; reason?: string | null; request_id?: string | null }[];
      expect(rows[0]).toMatchObject({ state: "sent" });
      expect(rows[0].cap_charge).toBeGreaterThan(0);
      const latest = rows.at(-1)!;
      expect(latest.state).toBe("refused_local");
      expect(latest.cap_charge).toBe(0);
      expect(latest.reason).toMatch(/nothing sent/);
      expect(latest.reason).toContain(PIN);
      expect(latest.reason).not.toContain(WRONG);
      expect(r.err).toContain(latest.reason!);
      expect(latest.request_id).toBe(rows[0].request_id);
      const st = await cli(h, ["status", "--json"]);
      expect(st.json().today_utc.flop).toBe(0);
      expect(st.json().pending_receipts).toEqual([]);
    } finally {
      globalThis.WebSocket = real;
      clearSecretRegistry();
    }
  });
});
