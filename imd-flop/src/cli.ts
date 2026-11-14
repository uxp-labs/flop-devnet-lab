import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { CliError, EXIT } from "./errors.js";
import { home, gatewayKeyFile, linkFile, receiptsDir, keyFile } from "./paths.js";
import { loadConfig, saveConfig, type Payer } from "./config.js";
import { claimUnassigned, initSeat, isSeatId, loadSigner, readIdentity, UNASSIGNED, validateSeat } from "./keys.js";
import { buildLink, verifyLink, type LinkFile } from "./link.js";
import { readJson, writeJsonSafe, writeSecretFile } from "./store.js";
import { network, SEAT_COLLECTION } from "./networks.js";
import { checkGenesis, readVerifiedSeatOwner, enrollChallengeUrl, getEnrollChallenge, postEnroll, type Fetch } from "./gateway.js";
import type { Provider } from "./providers/interface.js";
import { DEFAULT_PROVIDER, kindOf, PROVIDER_NAMES, PROVIDER_NAMES_PAID_FIRST, type ProviderName } from "./providers/kinds.js";
import { makeProvider } from "./providers/make.js";
import { checkLinkForRun, runJob } from "./run.js";
import { overDailyCap, padQuote, parseAmount } from "./policy.js";
import { appendLedger, latestAttempts, latestLineOf, LedgerLockError, reportedSpendToday, spentToday, UnusableLedgerRow, type LedgerEntry } from "./ledger.js";
import { listReceipts, readSavedReceipt, receiptVerdicts, refreshReceipt, type SavedReceipt } from "./receipt-store.js";
import { blank, classifyReceipt, receiptLine } from "./receipts.js";
import { outsideText, outsideValue, registerSecret } from "./secrets.js";
import type { Transport } from "./chain-read/node.js";
import { SESSION_USAGE, sessionCommand } from "./session/command.js";

export interface IO {
  out: (s: string) => void;
  err: (s: string) => void;
  env: NodeJS.ProcessEnv;
  fetch?: Fetch;
  /** Test hook: supply the provider instance (lets tests count calls). */
  provider?: Provider;
  /** Test hook: the chain reads' transport for the session commands (P5b, rule C5). Else the network's node. */
  transport?: Transport;
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
  session grant --owner <ss58> --days <1..10>   (prints the owner's create_session call; a day is one epoch of the chain's daily cap)
  session revoke --owner <ss58>                 (prints the owner's revoke_session call)
  session show --owner <ss58>                   (reads the session at the finalized head and the room left)
      The owner signs the printed call in his own wallet. These commands sign, send and write nothing.

Global: --seat <tokenId>, --json. Data: $IMD_FLOP_HOME or ~/.imd-flop. Provider defaults to mock.
Paid run --provider flop needs ETH_RPC_URL reporting chain id 1 and a live devnet genesis equal to the pinned hash.
It refuses on a wrong chain, a reset, or an unreadable response, before any paid call. The mock provider stays offline.
`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Values = Record<string, any>;
function parse(args: string[], options: ParseArgsConfig["options"]): { values: Values; positionals: string[] } {
  try {
    const parsed = parseArgs({ args, options: { json: { type: "boolean" }, seat: { type: "string" }, ...options }, allowPositionals: true, strict: true, tokens: true });
    // An option given more than once is a usage error for every command, boolean ones too. The count is of the
    // parser's own option tokens, so an argument after `--` (a positional) is never counted. The tool does not guess which one was meant.
    const seen = new Set<string>();
    for (const tok of parsed.tokens ?? []) {
      if (tok.kind !== "option") continue;
      if (seen.has(tok.name)) throw new CliError(`--${tok.name} is given more than once: give each option once`, EXIT.USAGE);
      seen.add(tok.name);
    }
    return { values: parsed.values, positionals: parsed.positionals };
  } catch (e) {
    if (e instanceof CliError) throw e;
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

/** A field the gateway sent, for stdout: a finite number as it is, any other value through outsideText, missing as null (review defect 5). */
function shownField(v: unknown): number | string | null {
  if (v === undefined || v === null) return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return outsideText(typeof v === "string" ? v : JSON.stringify(v), { max: 200 });
}

/**
 * The seat a refresh reads with: the stored receipt's, else the ledger row's. It is used only when it is a usable
 * seat id (isSeatId), since it picks the gateway key file. Anything else refuses with exit 3 and names the file
 * or the line it came from; there is no fallback to another seat (review defect 6).
 */
function refreshSeat(h: string, rid: string, saved: SavedReceipt | null, ledgerRow: LedgerEntry | undefined): string {
  const fromFile = saved?.seat !== undefined && saved?.seat !== null;
  const seat = fromFile ? saved!.seat : ledgerRow?.seat;
  if (isSeatId(seat)) return seat;
  const from = fromFile ? `the receipt file of ${rid}` : `ledger line ${latestLineOf(h, rid) ?? "?"}`;
  throw new CliError(`${from} has seat ${outsideValue(seat)}, which is not a usable seat id; refresh refused, nothing read. Repair that ${fromFile ? "file" : "line"}.`, EXIT.REFUSED_CAP);
}

function activeSeat(h: string, explicit?: string): string {
  const s = explicit ?? loadConfig(h).seat;
  if (!s) throw new CliError("no seat yet: run `imd-flop init --seat <tokenId>`", EXIT.USAGE);
  return validateSeat(s, explicit === undefined ? "config.json" : "the command line");
}

/** The provider a run or a refresh uses: the caller's own (a test hook), else the one maker's (providers/make.ts). */
function runProvider(io: IO, name: string, h: string, seat: string, opts: { live?: boolean; scenario?: string }): Provider {
  return io.provider ?? makeProvider(name, { home: h, fetch: io.fetch, env: io.env }, { for: "run", seat, ...opts });
}

/** One amount per provider name, in the order of the names given, as an object keyed by name. */
function perProvider<T>(names: readonly ProviderName[], value: (p: ProviderName) => T): Record<ProviderName, T> {
  return Object.fromEntries(names.map((p) => [p, value(p)])) as Record<ProviderName, T>;
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
        if (r.completed) out.completed = "this seat had a key file and no identity.json; its identity was made from that key";
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
          print({ enrolled: true, http: r.status, model: shownField(r.json.model), remaining_quota: shownField(r.json.remaining_quota), expires_at: shownField(r.json.expires_at) });
          return EXIT.OK;
        }
        print({ enrolled: false, http: r.status, error: r.reason ?? shownField(r.json.error) });
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
        const spent = perProvider(PROVIDER_NAMES, (p) => spentToday(h, seat, p));
        const o = { seat, cap: c ?? null, ...Object.fromEntries(PROVIDER_NAMES.map((p) => [`spent_today_${p}`, spent[p]])), day_utc: new Date().toISOString().slice(0, 10) };
        if (values.json) print(o);
        else io.out(c ? `seat ${seat}: cap ${c.daily} FLOP/day (UTC), ${c.perCall} per call. Today: ${PROVIDER_NAMES_PAID_FIRST.map((p) => `${p} ${spent[p]}`).join(", ")}` : `seat ${seat}: no cap. FLOP is off until \`cap set\`.`);
        return EXIT.OK;
      }

      case "config": {
        const cfg = loadConfig(h);
        if (rest[0] === "set") {
          const [, key, val] = rest;
          if (key !== "payer" || (val !== "holder" && val !== "requester")) throw new CliError("usage: config set payer <holder|requester>", EXIT.USAGE);
          cfg.payer = val as Payer;
          saveConfig(h, cfg);
          io.out(`payer = ${val}${val === "requester" ? " (run needs --job-budget; the seat's daily cap still applies)" : ""}`);
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
        const pname = values.provider ?? DEFAULT_PROVIDER;
        // The estimate is free, so `quote --provider flop` needs no key and no --live.
        const p = makeProvider(pname, { home: h, fetch: io.fetch, env: io.env }, { for: "quote" });
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
        const pname = values.provider ?? DEFAULT_PROVIDER;
        const provider = runProvider(io, pname, h, seat, { live: values.live, scenario: values["mock-scenario"] });
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
          { fetch: io.fetch, ethRpc: io.env.ETH_RPC_URL, warn: io.err },
        );
        if (values.json) print(r);
        else {
          io.out(`${kindOf(r.provider).mock ? "[MOCK] " : ""}job ${r.job}  request_id ${r.request_id}  payer ${r.payer}${r.link_bypassed ? "  LINK BYPASSED (--no-link)" : ""}`);
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
        // A receipt file that cannot be read or matched is named, not fatal: the overview still prints.
        const listed = listReceipts(h);
        const recent = await Promise.all(
          listed.receipts
            .slice(0, 5)
            .map(async (r) => ({ ...r, ...(await receiptVerdicts(h, r, rows.find((e) => e.request_id === r.request_id) ?? null)) })),
        );
        // Attempts with no receipt yet (timeouts, crashes) show as pending.
        const pending = rows
          .filter((e) => e.seat === seat && e.state !== "refused_local" && !recent.some((r) => r.request_id === e.request_id) && !existsSync(join(receiptsDir(h), `${e.request_id}.json`)))
          .slice(-5)
          .map((e) => ({ request_id: e.request_id, job: e.job, seat: e.seat, did: e.did, ledger_state: e.state, spend: e.spend, match: { match: "pending" as const, fields: [] as string[] } }));
        const cap = cfg.caps[seat] ?? null;
        // today_utc counts against the cap: what each call was allowed to spend (the hold floor). Beside it,
        // what the gateway reported as spent, and whether the day is above its cap.
        const today = perProvider(PROVIDER_NAMES_PAID_FIRST, (p) => spentToday(h, seat, p));
        // What the gateway reported, and how many sent calls it reported no amount for (never shown as 0).
        const reported = perProvider(PROVIDER_NAMES_PAID_FIRST, (p) => reportedSpendToday(h, seat, p));
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
          today_utc: today,
          gateway_spent_today_utc: perProvider(PROVIDER_NAMES_PAID_FIRST, (p) => reported[p].spent),
          gateway_spend_unknown_rows: perProvider(PROVIDER_NAMES_PAID_FIRST, (p) => reported[p].unknownRows),
          over_cap_today_utc: perProvider(PROVIDER_NAMES_PAID_FIRST, (p) => overDailyCap(today[p], cap)),
          attempts: latestAttempts(h).filter((e) => e.seat === seat).length,
          recent_receipts: recent,
          pending_receipts: pending,
          unreadable_receipts: listed.unreadable,
          not_shown: "balance and allowance (need a live gateway read with the bearer; not wired in v0)",
        };
        if (values.json) print(o);
        else {
          io.out(`network ${o.network}   seat ${seat}   payer ${o.payer}`);
          io.out(`  did   ${o.did ?? ""}`);
          io.out(`  ss58  ${o.ss58 ?? ""}`);
          io.out(`  link  ${lc.ok ? "verifies" : "BROKEN: " + lc.why.join("; ")}${lfw ? " (wallet-signed)" : " (wallet signature pending)"}`);
          io.out(`  cap   ${cap ? `${cap.daily} FLOP/day, ${cap.perCall}/call` : "none (FLOP off)"}`);
          const charged = (p: ProviderName) => `${p} ${o.today_utc[p]}${cap ? ` / ${cap.daily}` : ""}${o.over_cap_today_utc[p] ? " OVER CAP" : ""}`;
          io.out(`  today, charged to the cap      ${PROVIDER_NAMES_PAID_FIRST.map(charged).join("   ")}`);
          const reportedText = (p: ProviderName) => {
            const n = o.gateway_spend_unknown_rows[p];
            return `${p} ${blank(o.gateway_spent_today_utc[p])}${n > 0 ? ` (${n} ${n === 1 ? "call" : "calls"} with no reported spend)` : ""}`;
          };
          io.out(`  today, gateway reported spent  ${PROVIDER_NAMES_PAID_FIRST.map(reportedText).join("   ")}`);
          io.out(`  recent receipts:`);
          for (const r of recent) io.out(`    ${receiptLine(r)}`);
          if (recent.length === 0) io.out(`    (none)`);
          for (const p of pending) io.out(`    ${p.request_id}  job=${p.job}  ledger=${p.ledger_state}  spend=${blank(p.spend)}  match=pending`);
          if (listed.unreadable.length > 0) io.out(`  unreadable receipt files (not shown): ${listed.unreadable.join(", ")}`);
        }
        return EXIT.OK;
      }

      case "receipt": {
        const { values, positionals } = parse(rest, { refresh: { type: "boolean" }, live: { type: "boolean" } });
        const rid = positionals[0];
        if (!rid || !/^[\x21-\x7e]{1,128}$/.test(rid) || rid.includes("/")) throw new CliError("usage: receipt <request_id>", EXIT.USAGE);
        let saved: SavedReceipt | null = readSavedReceipt(h, rid);
        // Timeouts have a ledger row but no receipt file yet. A damaged ledger line, or a busy ledger, stops
        // every receipt command except a refresh of a stored receipt: that one stores its read, then stops at
        // the same line, or says the ledger is busy, when it comes to book (receipt-store.ts refreshReceipt),
        // so the read is not lost.
        let ledgerRow: LedgerEntry | undefined;
        try {
          ledgerRow = latestAttempts(h).find((e) => e.request_id === rid);
        } catch (e) {
          if (!((e instanceof UnusableLedgerRow || e instanceof LedgerLockError) && values.refresh && saved)) throw e;
        }
        if (!saved && !ledgerRow) throw new CliError(`no receipt or ledger entry for ${rid}`, EXIT.USAGE);
        if (values.refresh) {
          const p = runProvider(io, saved?.provider ?? ledgerRow!.provider, h, refreshSeat(h, rid, saved, ledgerRow), { live: values.live, scenario: saved?.mock_scenario });
          ({ saved, ledgerRow } = await refreshReceipt(h, rid, p, { saved, ledgerRow }, io.err));
        }
        const verdicts = await receiptVerdicts(h, saved ?? null, ledgerRow ?? null);
        const show = { ...(saved ?? { ...classifyReceipt(null, { job: ledgerRow!.job, provider: ledgerRow!.provider, requestId: rid, mock: ledgerRow!.mock }), seat: ledgerRow!.seat, did: ledgerRow!.did }), ...verdicts };
        if (values.json) print({ ...show, ledger_state: ledgerRow?.state ?? null, ledger_spend: ledgerRow?.spend ?? null });
        else {
          io.out(receiptLine(show));
          if (ledgerRow) io.out(`  ledger: state ${ledgerRow.state}, spend ${blank(ledgerRow.spend)}${ledgerRow.state === "timeout_unknown" ? " (unknown: timed out, not retried)" : ""}`);
        }
        return EXIT.OK;
      }

      case "session": {
        const { values, positionals } = parse(rest.slice(1), { owner: { type: "string" }, days: { type: "string" } });
        if (positionals.length > 0) throw new CliError(SESSION_USAGE, EXIT.USAGE);
        const cfg = loadConfig(h);
        const ctx = { home: h, seat: activeSeat(h, values.seat), net: network(cfg.network), caps: cfg.caps, owner: values.owner, days: values.days, transport: io.transport };
        return await sessionCommand(rest[0], ctx, io.out, values.json === true);
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
