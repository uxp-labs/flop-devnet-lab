import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { CliError, EXIT } from "./errors.js";
import { home, gatewayKeyFile, linkFile, receiptsDir, keyFile } from "./paths.js";
import { loadConfig, saveConfig, type Payer } from "./config.js";
import { claimUnassigned, initSeat, loadSigner, readIdentity, UNASSIGNED, validateSeat } from "./keys.js";
import { buildLink, verifyLink, type LinkFile } from "./link.js";
import { readJson, writeJsonSafe, writeSecretFile } from "./store.js";
import { network, SEAT_COLLECTION } from "./networks.js";
import { checkGenesis, readVerifiedSeatOwner, enrollChallengeUrl, getEnrollChallenge, postEnroll, type Fetch } from "./gateway.js";
import { FlopProvider, MOCK_SCENARIOS, MockProvider, type MockScenario, type Provider } from "./providers.js";
import { checkLinkForRun, runJob } from "./run.js";
import { padQuote, parseAmount } from "./policy.js";
import { appendLedger, latestAttempts, spentToday } from "./ledger.js";
import { DISAGREE, isFreshRead, receiptIdentity, refreshBooking } from "./settlement.js";
import { blank, classifyReceipt, receiptLine, type Classified } from "./receipts.js";
import { redactFlagged, registerSecret } from "./secrets.js";
import { matchReceipt } from "./match.js";

export interface IO {
  out: (s: string) => void;
  err: (s: string) => void;
  env: NodeJS.ProcessEnv;
  fetch?: Fetch;
  /** Test hook: supply the provider instance (lets tests count calls). */
  provider?: Provider;
}

const HELP = `imd-flop: reference companion CLI for "FLOP, by choice" (devnet rehearsal)

  init [--network devnet] [--seat <tokenId>] [--rotate] [--check-genesis]
  link --token <tokenId> [--agent <erc8004AgentId>]
  link verify <file> [--wallet-sig <0x..> --wallet <0x..>] [--save] [--eth-rpc <url>]  (eth_chainId must be 1, then ownerOf; or ETH_RPC_URL)
  faucet [--dry-run]                      (refuses: team rule, no faucets)
  enroll [--dry-run | --live]             (dry run by default)
  cap set <FLOP/day> [--per-call <FLOP>] | cap show
  config set payer <holder|requester> | config show
  quote --prompt <text> [--max-tokens N] [--provider mock|flop]
  run --job <id> (--prompt <text> | --prompt-file <path>) [--system <text>] [--max-tokens N]
      [--provider mock|flop] [--live] [--no-link] [--job-budget <FLOP>] [--timeout-ms N]
      [--check-job] [--mock-scenario ok|timeout|settled|key_expired|estimate_error]
  status [--json]
  receipt <request_id> [--refresh] [--json]

Global: --seat <tokenId>, --json. Data: $IMD_FLOP_HOME or ~/.imd-flop. Provider defaults to mock.
Paid run --provider flop needs ETH_RPC_URL reporting chain id 1 and a live devnet genesis equal to the pinned hash.
It refuses on a wrong chain, a reset, or an unreadable response, before any paid call. The mock provider stays offline.
`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Values = Record<string, any>;
function parse(args: string[], options: ParseArgsConfig["options"]): { values: Values; positionals: string[] } {
  try {
    return parseArgs({ args, options: { json: { type: "boolean" }, seat: { type: "string" }, ...options }, allowPositionals: true, strict: true });
  } catch (e) {
    throw new CliError((e as Error).message, EXIT.USAGE);
  }
}

function timeoutMs(raw: string | undefined): number {
  if (raw === undefined) return 60000;
  if (!/^\d+$/.test(raw)) throw new CliError("--timeout-ms must be an integer from 1 to 2147483647", EXIT.USAGE);
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 2147483647) throw new CliError("--timeout-ms must be an integer from 1 to 2147483647", EXIT.USAGE);
  return n;
}

function activeSeat(h: string, explicit?: string): string {
  const s = explicit ?? loadConfig(h).seat;
  if (!s) throw new CliError("no seat yet: run `imd-flop init --seat <tokenId>`", EXIT.USAGE);
  return validateSeat(s);
}

function makeProvider(io: IO, name: string, h: string, seat: string, opts: { live?: boolean; scenario?: string }): Provider {
  if (io.provider) return io.provider;
  if (name === "mock") {
    const sc = (opts.scenario ?? "ok") as MockScenario;
    if (!MOCK_SCENARIOS.includes(sc)) throw new CliError(`--mock-scenario must be one of ${MOCK_SCENARIOS.join(", ")}`, EXIT.USAGE);
    return new MockProvider(sc);
  }
  if (name === "flop") {
    if (!opts.live) throw new CliError("--provider flop spends real devnet FLOP: it needs --live, a cap, a fully signed link and an enrolled gateway key", EXIT.REFUSED_RULE);
    return new FlopProvider(network(loadConfig(h).network), gatewayKeyFile(h, seat), io.fetch, io.env.ETH_RPC_URL);
  }
  throw new CliError("--provider must be mock or flop", EXIT.USAGE);
}

export async function main(argv: string[], io: IO): Promise<number> {
  const h = home(io.env);
  const [cmd, ...rest] = argv;
  const print = (o: unknown) => io.out(JSON.stringify(o, null, 2));
  try {
    switch (cmd) {
      case undefined:
      case "help":
      case "--help":
      case "-h":
        io.out(HELP);
        return EXIT.OK;

      case "init": {
        const { values } = parse(rest, { network: { type: "string" }, rotate: { type: "boolean" }, "check-genesis": { type: "boolean" } });
        const cfg = loadConfig(h);
        const net = values.network ?? cfg.network ?? "devnet";
        const seat = values.seat ?? UNASSIGNED;
        const r = initSeat(h, { seat, network: net, rotate: values.rotate });
        cfg.network = net;
        cfg.seat = seat;
        saveConfig(h, cfg);
        const out: Record<string, unknown> = { seat, network: net, did: r.identity.did, ss58: r.identity.ss58, ss58Prefix: r.identity.ss58Prefix, keyFile: "seats/" + seat + "/flop.key (mode 600, never printed)" };
        if (r.rotated) out.rotated = { revokedDid: r.rotated.revokedDid, note: "revocation written to revocations.jsonl; re-run `link`" };
        if (values["check-genesis"]) {
          const g = await checkGenesis(network(net), io.fetch);
          out.genesis = g;
          if (!g.ok) {
            values.json ? print(out) : io.out(`seat ${seat}\n  did   ${r.identity.did}\n  ss58  ${r.identity.ss58}`);
            throw new CliError(`genesis check failed: pinned ${g.pinnedGenesis} vs faucet ${g.faucetGenesis ?? "?"} vs rpc ${g.rpcGenesis ?? "?"}${g.error ? ` (${g.error})` : ""}. Devnet may have reset.`, EXIT.ERROR);
          }
        }
        if (values.json) print(out);
        else {
          io.out(`seat ${seat} on ${net}${r.rotated ? ` (rotated; revoked ${r.rotated.revokedDid})` : ""}`);
          io.out(`  did   ${r.identity.did}`);
          io.out(`  ss58  ${r.identity.ss58}  (prefix ${r.identity.ss58Prefix}, the devnet faucet's ss58Format)`);
          io.out(`  key   ${String(out.keyFile)}`);
          if (out.genesis) io.out(`  genesis ok (pinned == faucet == rpc)`);
        }
        return EXIT.OK;
      }

      case "link": {
        if (rest[0] === "verify") {
          const { values, positionals } = parse(rest.slice(1), { "wallet-sig": { type: "string" }, wallet: { type: "string" }, save: { type: "boolean" }, "eth-rpc": { type: "string" } });
          const file = positionals[0];
          if (!file) throw new CliError("usage: link verify <file>", EXIT.USAGE);
          const lf = readJson<LinkFile>(resolve(file));
          if (!lf) throw new CliError(`no such file: ${file}`, EXIT.USAGE);
          const ethRpc = values["eth-rpc"] ?? io.env.ETH_RPC_URL;
          let currentOwner: string | null | undefined;
          if (ethRpc) {
            try {
              currentOwner = await readVerifiedSeatOwner(ethRpc, SEAT_COLLECTION, lf.statement?.tokenId ?? "0", io.fetch);
            } catch (e) {
              throw new CliError(`owner check failed (not treated as ok): ${(e as Error).message}`, EXIT.VERIFY_FAILED);
            }
          }
          const v = await verifyLink(lf, { walletSig: values["wallet-sig"], wallet: values.wallet, ...(currentOwner === undefined ? {} : { currentOwner }) });
          if (v.ok && values.save && values["wallet-sig"] && values.wallet) {
            writeJsonSafe(resolve(file), { ...lf, wallet: { address: v.wallet.expected, signature: values["wallet-sig"] }, note: "signed by the FLOP key and the seat wallet" }, "link.json");
          }
          if (values.json) print(v);
          else {
            io.out(`${v.ok ? "OK" : "FAIL"}  ${file}`);
            io.out(`  ed25519 signature      ${v.flopSig}`);
            io.out(`  ss58 == did:key        ${v.didMatchesSs58}`);
            io.out(`  ss58 prefix/network    ${v.ss58PrefixOk}`);
            io.out(`  genesis hash           ${v.genesisOk}`);
            io.out(`  eip712 == statement    ${v.eip712MatchesStatement}`);
            io.out(`  wallet (EIP-712)       ${v.wallet.checked ? `${v.wallet.ok} ${v.wallet.recovered ?? ""}` : "not checked (no --wallet-sig)"}`);
            io.out(`  seat owner (ownerOf)   ${v.owner.checked ? `${v.owner.ok} ${v.owner.current ?? "none"}` : "not checked (no --eth-rpc / ETH_RPC_URL)"}`);
            for (const e of v.errors) io.out(`  ! ${e}`);
          }
          return v.ok ? EXIT.OK : EXIT.VERIFY_FAILED;
        }
        const { values } = parse(rest, { token: { type: "string" }, agent: { type: "string" } });
        if (!values.token) throw new CliError("usage: link --token <tokenId> [--agent <erc8004AgentId>]", EXIT.USAGE);
        const token = validateSeat(values.token);
        claimUnassigned(h, token);
        const signer = loadSigner(h, token);
        const lf = buildLink(signer, { tokenId: token, agentId: values.agent });
        const path = linkFile(h, token);
        writeJsonSafe(path, lf, "link.json");
        const cfg = loadConfig(h);
        cfg.seat = token;
        saveConfig(h, cfg);
        if (values.json) print({ file: path, link: lf });
        else {
          io.out(`link for seat ${token} written to ${path}`);
          io.out(`  flop side signed (Ed25519, ${signer.identity.did})`);
          if (!values.agent) io.out(`  erc8004AgentId not set (pass --agent; on-chain lookup is off)`);
          io.out(`  wallet side: sign this EIP-712 typed data with the wallet that holds seat ${token}, on your own machine.`);
          io.out(`  Never paste a seed or private key anywhere. Then: imd-flop link verify ${path} --wallet-sig <sig> --wallet <addr> --save`);
          io.out(JSON.stringify(lf.eip712, null, 2));
        }
        return EXIT.OK;
      }

      case "faucet": {
        const { values } = parse(rest, { "dry-run": { type: "boolean" } });
        const seat = activeSeat(h, values.seat);
        const id = readIdentity(h, seat);
        if (values["dry-run"]) {
          const would = { sent: false, method: "POST", url: `${network(loadConfig(h).network).faucet}/fund`, body: { address: id?.ss58 ?? "<ss58>" }, note: "request shape from the gateway's faucet hint; not verified. Not sent: team rule." };
          values.json ? print(would) : io.out(`DRY RUN (not sent): POST ${would.url} ${JSON.stringify(would.body)}`);
          return EXIT.OK;
        }
        throw new CliError(
          "refused: our team does not use faucets. Rule 3 forbids faucet cycling, and our fleet rule is stricter: no faucet requests at all from this tool. Fund the seat's FLOP address by hand if a human decides to. `imd-flop faucet --dry-run` shows the request it would make.",
          EXIT.FAUCET_REFUSED,
        );
      }

      case "enroll": {
        const { values } = parse(rest, { "dry-run": { type: "boolean" }, live: { type: "boolean" } });
        const seat = activeSeat(h, values.seat);
        const net = network(loadConfig(h).network);
        const id = readIdentity(h, seat);
        if (!id) throw new CliError(`no FLOP key for seat ${seat}`, EXIT.USAGE);
        if (!values.live || values["dry-run"]) {
          const plan = {
            sent: false,
            steps: [
              { method: "GET", url: enrollChallengeUrl(net, id.ss58) },
              { sign: "Ed25519 over the challenge message bytes, with this seat's FLOP key (local)" },
              { method: "POST", url: `${net.gateway}/enroll/wallet`, body: { address: id.ss58, message: "<challenge message, byte for byte>", signature: "<0x ed25519 signature>" } },
              { store: `seats/${seat}/gateway.key (mode 600); the bearer is never printed or logged` },
            ],
            needs: "a finalized balance >= 1 FLOP on the address (the gateway answers 403 wallet_unfunded otherwise). We do not use faucets, so a human funds it.",
          };
          values.json ? print(plan) : io.out(`DRY RUN (nothing sent)\n${JSON.stringify(plan, null, 2)}`);
          return EXIT.OK;
        }
        // --live: real devnet enrollment. Only a human runs this, on the holder's machine.
        if (existsSync(gatewayKeyFile(h, seat))) throw new CliError("this seat already has a gateway key; re-enrolling rotates the bearer, delete it by hand first if you mean it", EXIT.REFUSED_RULE);
        const signer = loadSigner(h, seat);
        const ch = await getEnrollChallenge(net, id.ss58, io.fetch ?? globalThis.fetch);
        if (!ch.message.includes(id.ss58)) throw new CliError("challenge does not name this seat's address; refusing to sign", EXIT.REFUSED_RULE);
        const sig = "0x" + bytesToHex(signer.sign(utf8ToBytes(ch.message)));
        const r = await postEnroll(net, { address: id.ss58, message: ch.message, signature: sig }, io.fetch ?? globalThis.fetch);
        const bearer = r.json.key;
        if ((r.status === 200 || r.status === 201) && typeof bearer === "string") {
          registerSecret(bearer);
          writeSecretFile(gatewayKeyFile(h, seat), bearer + "\n");
          print({ enrolled: true, http: r.status, model: r.json.model, remaining_quota: r.json.remaining_quota, expires_at: r.json.expires_at });
          return EXIT.OK;
        }
        print({ enrolled: false, http: r.status, error: r.json.error ?? null });
        return EXIT.ERROR;
      }

      case "cap": {
        const sub = rest[0];
        const { values, positionals } = parse(rest.slice(1), { "per-call": { type: "string" } });
        const cfg = loadConfig(h);
        const seat = activeSeat(h, values.seat);
        if (sub === "set") {
          const daily = parseAmount(positionals[0], "cap");
          if (daily === undefined) throw new CliError("usage: cap set <FLOP/day> [--per-call <FLOP>]", EXIT.USAGE);
          const perCall = parseAmount(values["per-call"], "--per-call") ?? daily;
          if (perCall > daily) throw new CliError("--per-call cannot exceed the daily cap", EXIT.USAGE);
          cfg.caps[seat] = { daily, perCall };
          saveConfig(h, cfg);
        } else if (sub !== "show") throw new CliError("usage: cap set <FLOP/day> | cap show", EXIT.USAGE);
        const c = cfg.caps[seat];
        const o = { seat, cap: c ?? null, spent_today_mock: spentToday(h, seat, "mock"), spent_today_flop: spentToday(h, seat, "flop"), day_utc: new Date().toISOString().slice(0, 10) };
        if (values.json) print(o);
        else io.out(c ? `seat ${seat}: cap ${c.daily} FLOP/day (UTC), ${c.perCall} per call. Today: flop ${o.spent_today_flop}, mock ${o.spent_today_mock}` : `seat ${seat}: no cap. FLOP is off until \`cap set\`.`);
        return EXIT.OK;
      }

      case "config": {
        const cfg = loadConfig(h);
        if (rest[0] === "set") {
          const [, key, val] = rest;
          if (key !== "payer" || (val !== "holder" && val !== "requester")) throw new CliError("usage: config set payer <holder|requester>", EXIT.USAGE);
          cfg.payer = val as Payer;
          saveConfig(h, cfg);
          io.out(`payer = ${val}${val === "requester" ? " (run needs --job-budget; the daily cap counts holder-paid spend only)" : ""}`);
          return EXIT.OK;
        }
        if (rest[0] === "show" || rest[0] === undefined) {
          print(cfg);
          return EXIT.OK;
        }
        throw new CliError("usage: config set payer <holder|requester> | config show", EXIT.USAGE);
      }

      case "quote": {
        const { values } = parse(rest, { prompt: { type: "string" }, "max-tokens": { type: "string" }, provider: { type: "string" }, live: { type: "boolean" } });
        if (!values.prompt) throw new CliError("usage: quote --prompt <text>", EXIT.USAGE);
        const max = Number(values["max-tokens"] ?? 16);
        const pname = values.provider ?? "mock";
        // The estimate is free, so `quote --provider flop` needs no key and no --live.
        const p: Provider = pname === "flop" ? { name: "flop", calls: 0, estimate: (b) => import("./gateway.js").then((g) => g.postEstimate(network(loadConfig(h).network), b, io.fetch ?? globalThis.fetch)), complete: () => Promise.reject(new Error("quote only")), readReceipt: () => Promise.reject(new Error("quote only")) } : new MockProvider();
        const est = await p.estimate({ model: "qwen/qwen2.5-0.5b-instruct", prompt: values.prompt, max_tokens: max });
        print({ provider: pname, estimate: est, padded: padQuote(est), note: "padded = raw + 20 tokens for the Qwen chat template" });
        return EXIT.OK;
      }

      case "run": {
        const { values } = parse(rest, {
          job: { type: "string" },
          prompt: { type: "string" },
          "prompt-file": { type: "string" },
          system: { type: "string" },
          "max-tokens": { type: "string" },
          provider: { type: "string" },
          live: { type: "boolean" },
          "no-link": { type: "boolean" },
          "job-budget": { type: "string" },
          "timeout-ms": { type: "string" },
          "check-job": { type: "boolean" },
          "mock-scenario": { type: "string" },
          cap: { type: "string" },
        });
        if (values.cap !== undefined) throw new CliError("set the cap with `imd-flop cap set <FLOP/day>`; run reads it from config", EXIT.USAGE);
        const seat = activeSeat(h, values.seat);
        const pname = values.provider ?? "mock";
        const provider = makeProvider(io, pname, h, seat, { live: values.live, scenario: values["mock-scenario"] });
        if (values["no-link"]) io.err("WARNING: --no-link: link check bypassed (mock demo only). This run is not a valid FLOP route.");
        const r = await runJob(
          h,
          provider,
          {
            job: values.job,
            prompt: values.prompt,
            promptFile: values["prompt-file"],
            system: values.system,
            maxTokens: Number(values["max-tokens"] ?? 16),
            seat,
            noLink: values["no-link"],
            jobBudget: parseAmount(values["job-budget"], "--job-budget"),
            timeoutMs: timeoutMs(values["timeout-ms"]),
            checkJob: values["check-job"],
          },
          { fetch: io.fetch, ethRpc: io.env.ETH_RPC_URL },
        );
        if (values.json) print(r);
        else {
          io.out(`${r.provider === "mock" ? "[MOCK] " : ""}job ${r.job}  request_id ${r.request_id}  payer ${r.payer}${r.link_bypassed ? "  LINK BYPASSED (--no-link)" : ""}`);
          io.out(`  quote (padded) ${r.quote_padded} FLOP, charged to cap ${r.cap_charge}`);
          io.out(`  receipt: ${receiptLine(r.receipt)}`);
          io.out(`  response saved: ${r.response_file} (not submitted to IMD)`);
        }
        return EXIT.OK;
      }

      case "status": {
        const { values } = parse(rest, {});
        const cfg = loadConfig(h);
        const seat = activeSeat(h, values.seat);
        const id = readIdentity(h, seat);
        const lc = existsSync(linkFile(h, seat)) ? await checkLinkForRun(h, seat, false) : { ok: false, why: ["no link"] };
        const lfw = readJson<LinkFile>(linkFile(h, seat))?.wallet ?? null;
        const rows = latestAttempts(h);
        const recent = await Promise.all(
          listReceipts(h)
            .slice(0, 5)
            .map(async (r) => ({ ...r, match: await matchReceipt(h, r, rows.find((e) => e.request_id === r.request_id) ?? null) })),
        );
        // Attempts with no receipt yet (timeouts, crashes) show as pending.
        const pending = rows
          .filter((e) => e.seat === seat && e.state !== "refused_local" && !recent.some((r) => r.request_id === e.request_id) && !existsSync(join(receiptsDir(h), `${e.request_id}.json`)))
          .slice(-5)
          .map((e) => ({ request_id: e.request_id, job: e.job, seat: e.seat, did: e.did, ledger_state: e.state, spend: e.spend, match: { match: "pending" as const, fields: [] as string[] } }));
        const cap = cfg.caps[seat] ?? null;
        const o = {
          network: cfg.network,
          seat,
          did: id?.did ?? null,
          ss58: id?.ss58 ?? null,
          key_file_present: existsSync(keyFile(h, seat)),
          gateway_key_present: existsSync(gatewayKeyFile(h, seat)),
          link: { flop_side_ok: lc.ok, wallet_signed: !!lfw, problems: lc.ok ? [] : lc.why },
          payer: cfg.payer,
          cap,
          today_utc: { flop: spentToday(h, seat, "flop"), mock: spentToday(h, seat, "mock") },
          attempts: latestAttempts(h).filter((e) => e.seat === seat).length,
          recent_receipts: recent,
          pending_receipts: pending,
          not_shown: "balance and allowance (need a live gateway read with the bearer; not wired in v0)",
        };
        if (values.json) print(o);
        else {
          io.out(`network ${o.network}   seat ${seat}   payer ${o.payer}`);
          io.out(`  did   ${o.did ?? ""}`);
          io.out(`  ss58  ${o.ss58 ?? ""}`);
          io.out(`  link  ${lc.ok ? "verifies" : "BROKEN: " + lc.why.join("; ")}${lfw ? " (wallet-signed)" : " (wallet signature pending)"}`);
          io.out(`  cap   ${cap ? `${cap.daily} FLOP/day, ${cap.perCall}/call` : "none (FLOP off)"}`);
          io.out(`  today flop ${o.today_utc.flop}${cap ? ` / ${cap.daily}` : ""}   mock ${o.today_utc.mock}${cap ? ` / ${cap.daily}` : ""}`);
          io.out(`  recent receipts:`);
          for (const r of recent) io.out(`    ${receiptLine(r)}`);
          if (recent.length === 0) io.out(`    (none)`);
          for (const p of pending) io.out(`    ${p.request_id}  job=${p.job}  ledger=${p.ledger_state}  spend=${blank(p.spend)}  match=pending`);
        }
        return EXIT.OK;
      }

      case "receipt": {
        const { values, positionals } = parse(rest, { refresh: { type: "boolean" }, live: { type: "boolean" } });
        const rid = positionals[0];
        if (!rid || !/^[\x21-\x7e]{1,128}$/.test(rid) || rid.includes("/")) throw new CliError("usage: receipt <request_id>", EXIT.USAGE);
        const path = join(receiptsDir(h), `${rid}.json`);
        let saved = readJson<Classified & { seat: string; mock_scenario?: string }>(path);
        // Timeouts have a ledger row but no receipt file yet.
        let ledgerRow = latestAttempts(h).find((e) => e.request_id === rid);
        if (!saved && !ledgerRow) throw new CliError(`no receipt or ledger entry for ${rid}`, EXIT.USAGE);
        if (values.refresh) {
          const seat = saved?.seat ?? ledgerRow!.seat;
          const pname = saved?.provider ?? ledgerRow!.provider;
          const p = makeProvider(io, pname, h, seat, { live: values.live, scenario: saved?.mock_scenario });
          const rr = await p.readReceipt(rid);
          const c = classifyReceipt(rr.receipt, { job: saved?.job ?? ledgerRow?.job ?? null, provider: pname, http: rr.http, error: rr.error, requestId: rid, mock: pname === "mock" });
          // Identity is decided on the raw gateway receipt, exactly as run does. classifyReceipt's
          // requestId fallback never decides identity, settlement or the stored request_id.
          const fresh = isFreshRead(rr);
          const { rawId, identityOk } = fresh ? receiptIdentity(rr.receipt, rid) : { rawId: undefined, identityOk: false };
          // A timeout leaves a ledger row but no receipt file. Take the seat identity from that row (what run
          // recorded at call time), never from the gateway, so the first receipt file is not a permanent mismatch.
          const ident = saved ? {} : (() => {
            const id = readIdentity(h, ledgerRow!.seat);
            return { seat: ledgerRow!.seat, did: ledgerRow!.did, ss58: id && id.did === ledgerRow!.did ? id.ss58 : null, network: ledgerRow!.network };
          })();
          let merged: Record<string, unknown> = fresh
            ? { ...ident, ...saved, ...c, request_id: typeof rawId === "string" ? rawId : "", ...(identityOk ? {} : { settled: null, chain_final: false }) }
            // No fresh receipt: keep what was stored, including its request_id (a recorded mismatch stays one).
            : { ...ident, ...saved, ...c, request_id: saved?.request_id ?? "", state: saved?.state ?? null, reserved: saved?.reserved ?? null, settled: saved?.settled ?? null, chain_final: saved?.chain_final ?? false, last_known_at: saved?.observed_at ?? null };
          try {
            writeJsonSafe(path, merged, "receipt");
          } catch {
            // Same fallback as run: null only the flagged fields, then still reach the ledger logic.
            const redacted = redactFlagged(merged);
            if (redacted.residual.length > 0) throw new CliError("secret scan blocked writing receipt and redaction could not clear it", EXIT.REFUSED_RULE);
            merged = redacted.copy as Record<string, unknown>;
            writeJsonSafe(path, merged, "receipt");
          }
          saved = merged as unknown as typeof saved;
          const prev = latestAttempts(h).find((e) => e.request_id === rid);
          if (prev) {
            const next = refreshBooking(prev, { fresh, identityOk, state: saved?.state ?? null, settled: saved?.settled });
            if (next.kind === "disagree") {
              // Unknown charge and no exact-identity settlement: never substitute 0. Leave the row (and the refusal) alone.
              io.err(DISAGREE);
              saved = { ...saved, status: DISAGREE } as typeof saved;
            } else if (next.kind === "append") {
              try {
                appendLedger(h, { ...prev, ts: new Date().toISOString(), state: next.booking.state, reason: saved?.flag ?? null, spend: next.booking.spend, cap_charge: next.booking.cap_charge });
              } catch {
                io.err(DISAGREE);
                saved = { ...saved, status: DISAGREE } as typeof saved;
              }
            }
            ledgerRow = latestAttempts(h).find((e) => e.request_id === rid);
          }
        }
        const match = await matchReceipt(h, saved ?? null, ledgerRow ?? null);
        const show = { ...(saved ?? { ...classifyReceipt(null, { job: ledgerRow!.job, provider: ledgerRow!.provider, requestId: rid, mock: ledgerRow!.mock }), seat: ledgerRow!.seat, did: ledgerRow!.did }), match };
        if (values.json) print({ ...show, ledger_state: ledgerRow?.state ?? null, ledger_spend: ledgerRow?.spend ?? null });
        else {
          io.out(receiptLine(show));
          if (ledgerRow) io.out(`  ledger: state ${ledgerRow.state}, spend ${blank(ledgerRow.spend)}${ledgerRow.state === "timeout_unknown" ? " (unknown: timed out, not retried)" : ""}`);
        }
        return EXIT.OK;
      }

      default:
        throw new CliError(`unknown command "${cmd}"\n\n${HELP}`, EXIT.USAGE);
    }
  } catch (e) {
    if (e instanceof CliError) {
      io.err(`imd-flop: ${e.message}`);
      return e.code;
    }
    io.err(`imd-flop: ${(e as Error).message}`);
    return EXIT.ERROR;
  }
}

function listReceipts(h: string): Classified[] {
  const dir = receiptsDir(h);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => readJson<Classified>(join(dir, f))!)
    .sort((a, b) => (b.observed_at ?? "").localeCompare(a.observed_at ?? ""));
}
