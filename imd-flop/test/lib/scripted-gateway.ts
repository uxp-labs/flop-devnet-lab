/**
 * A scripted FLOP gateway for a full paid run through the CLI, offline: every answer the tool parses (the
 * Ethereum RPC, the faucet, the FLOP RPC WebSocket frame, the estimate, the child key mint, the paid call's
 * answer and the receipt read) is a body given as text, so a test can put any JSON text, valid or not, in any
 * of them. Nothing here is a key: the bearer and the child token are synthetic.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { NETWORKS } from "../../src/networks.js";
import { gatewayKeyFile } from "../../src/paths.js";
import { writeSecretFile } from "../../src/store.js";
import type { LinkFile } from "../../src/link.js";
import { cli, readySeat, tmpHome } from "../helpers.js";

export const PIN = NETWORKS.devnet.genesisHash;
export const ETH = "https://eth.example/rpc";
export const SEAT = "42";
export const RUN = ["run", "--job", "job-abc", "--prompt", "Say hi", "--max-tokens", "8", "--provider", "flop", "--live", "--seat", SEAT];

/** One scripted answer: the body as text and its HTTP status. */
export interface Answer { status: number; text: string }

export type Site = "chainId" | "ownerOf" | "faucet" | "estimate" | "mint" | "completion" | "receipt";

/** The body of each answer when a test does not replace it: every one valid and finite. */
export function defaults(owner: string): Record<Site, Answer> {
  return {
    chainId: { status: 200, text: `{"jsonrpc":"2.0","id":1,"result":"0x1"}` },
    ownerOf: { status: 200, text: `{"jsonrpc":"2.0","id":1,"result":"0x${"0".repeat(24)}${owner.slice(2).toLowerCase()}"}` },
    faucet: { status: 200, text: `{"genesisHash":"${PIN}"}` },
    estimate: { status: 200, text: `{"model":"m","estimated_input_tokens":1,"estimated_output_tokens":1,"estimated_cost_flop":0.012}` },
    mint: { status: 201, text: `{"token":"flop_ek_SYNTHETICCHILD0123456789","expires_at":0}` },
    completion: {
      status: 200,
      text: `{"id":"x","object":"chat.completion","created":1,"model":"m","choices":[{"index":0,"message":{"role":"assistant","content":"hi"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2,"cost_flop":0.01}}`,
    },
    receipt: { status: 200, text: receiptText({}) },
  };
}

/** A receipt body as text, with each field replaced by the raw JSON text given for it. */
export function receiptText(fields: Record<string, string>, requestId = "__RID__"): string {
  const base: Record<string, string> = {
    request_id: JSON.stringify(requestId),
    correlation_id: JSON.stringify("imd-job-job-abc"),
    model: JSON.stringify("m"),
    reserved_spend: "0.012",
    settled_spend: "0.01",
    settled_spend_raw: "null",
    terminal_event: "null",
    channel_id: "null",
    created_at: "1",
    state: JSON.stringify("settled"),
    response_status: "200",
    ...fields,
  };
  return `{${Object.entries(base).map(([k, v]) => `${JSON.stringify(k)}:${v}`).join(",")}}`;
}

export interface Gateway {
  fetch: typeof fetch;
  seen: Site[];
  /** The request id the paid call carried (its Idempotency-Key), once it was sent. */
  requestId: () => string | null;
}

/** "__RID__" in a receipt body stands for the request id of the paid call. */
export function scriptedGateway(answers: Record<Site, Answer>): Gateway {
  const seen: Site[] = [];
  let rid: string | null = null;
  const reply = (site: Site) => {
    seen.push(site);
    const a = answers[site];
    return new Response(a.text.replaceAll("__RID__", rid ?? ""), { status: a.status, headers: { "content-type": "application/json" } });
  };
  const f = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url === ETH) {
      const method = (JSON.parse(String(init?.body)) as { method: string }).method;
      return reply(method === "eth_chainId" ? "chainId" : "ownerOf");
    }
    if (url.endsWith("/chain")) return reply("faucet");
    if (url.endsWith("/models/estimate")) return reply("estimate");
    if (url.endsWith("/keys/ephemeral")) return reply("mint");
    if (url.endsWith("/chat/completions")) {
      rid = new Headers(init?.headers).get("Idempotency-Key");
      return reply("completion");
    }
    if (url.includes("/keys/me/receipts/")) {
      rid ??= decodeURIComponent(url.split("/").at(-1)!);
      return reply("receipt");
    }
    throw new Error(`unexpected url ${url}`);
  }) as typeof fetch;
  return { fetch: f, seen, requestId: () => rid };
}

/** A FLOP RPC WebSocket that answers every request with the given frame text. */
export async function withFrame<T>(frame: string, fn: () => Promise<T>): Promise<T> {
  const real = globalThis.WebSocket;
  (globalThis as { WebSocket: unknown }).WebSocket = class {
    onopen?: () => void;
    onmessage?: (ev: { data: string }) => void;
    constructor() {
      setTimeout(() => this.onopen?.(), 0);
    }
    send() {
      setTimeout(() => this.onmessage?.({ data: frame }), 0);
    }
    close() {}
  };
  try {
    return await fn();
  } finally {
    globalThis.WebSocket = real;
  }
}

/** The frame the FLOP RPC answers chain_getBlockHash(0) with when a test does not replace it. */
export const PIN_FRAME = `{"jsonrpc":"2.0","id":1,"result":"${PIN}"}`;

/** A seat ready for a paid run: key, link signed by the FLOP key and a seat wallet, cap, synthetic gateway bearer. */
export async function paidSeat(): Promise<{ h: string; owner: string }> {
  const h = tmpHome();
  await readySeat(h, SEAT);
  const file = join(h, "seats", SEAT, "link.json");
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
  writeSecretFile(gatewayKeyFile(h, SEAT), "flop_sk_SYNTHETICPARENT0123456789\n");
  return { h, owner: wallet.address };
}

/** One full paid run with some answers replaced. */
export async function paidRun(replace: Partial<Record<Site, Answer>> = {}, frame = PIN_FRAME, seat?: { h: string; owner: string }) {
  const { h, owner } = seat ?? (await paidSeat());
  const gw = scriptedGateway({ ...defaults(owner), ...replace });
  const r = await withFrame(frame, () => cli(h, RUN, { fetch: gw.fetch, env: { IMD_FLOP_HOME: h, ETH_RPC_URL: ETH } }));
  return { h, owner, gw, ...r };
}

/** `receipt <id> --refresh --json` against a scripted receipt answer. */
export async function refresh(h: string, owner: string, rid: string, receipt: Answer, frame = PIN_FRAME) {
  const gw = scriptedGateway({ ...defaults(owner), receipt });
  const r = await withFrame(frame, () => cli(h, ["receipt", rid, "--refresh", "--json", "--seat", SEAT, "--live"], { fetch: gw.fetch, env: { IMD_FLOP_HOME: h, ETH_RPC_URL: ETH } }));
  return { gw, ...r };
}
