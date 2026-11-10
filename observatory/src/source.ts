// Where observations come from. M0 has one implementation, FixtureSource, which reads a
// scenario directory of saved responses. M1 adds a live source behind the read-only guard.
//
// A scenario directory may hold any of these files. A missing file means "unknown",
// never "ok" and never 0:
//   meta.json               { "scenario", "description", "now", "synthetic" }
//   faucet-health.json      HttpResult<FaucetHealthBody>
//   faucet-chain.json       HttpResult<FaucetChainBody>
//   gateway-models.json     HttpResult<unknown>
//   rpc-head.json           RpcHead
//   runtime-constants.json  RuntimeConstants
//   event-pages/*.json      EventPage, one page per file, read in file-name order
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { MAX_NESTING, duplicateKey, nestingDepth } from "./strict.js";
import type {
  EventPage,
  FaucetChainBody,
  FaucetHealthBody,
  HttpResult,
  RpcHead,
  RuntimeConstants,
  Trust,
} from "./types.js";

export interface Source {
  readonly kind: "fixture" | "rpc";
  readonly trust: Trust;
  /** Short description of where data comes from, for the run pin. */
  readonly label: string;
  faucetHealth(): Promise<HttpResult<FaucetHealthBody>>;
  faucetChain(): Promise<HttpResult<FaucetChainBody>>;
  gatewayModels(): Promise<HttpResult<unknown>>;
  rpcHead(): Promise<RpcHead>;
  runtimeConstants(): Promise<RuntimeConstants | null>;
  /** Raw event pages, verbatim. Retained so any count can be recomputed from them. */
  eventPages(): Promise<EventPage[]>;
  /**
   * Event pages that exist but could not be read or parsed, as "file: reason". Never dropped
   * silently: a census refuses and every escrow is unverified when this is not empty.
   */
  eventPageErrors(): Promise<string[]>;
}

export interface FixtureMeta {
  scenario: string;
  description: string;
  /** The clock for this scenario (ISO 8601). Snapshots use it so reruns are byte-identical. */
  now: string;
  /** True when the data is made up for a test, false when it was copied from a real response. */
  synthetic: boolean;
  /** Census scenarios: the block range the census is asked for. */
  census_request?: { from_block: number; to_block: number };
  /** Census and escrow scenarios: the genesis to treat as pinned, when not the devnet one. */
  pinned_genesis?: string;
  /** Escrow scenarios: the escrow ids to look up. */
  escrow_ids?: string[];
  /** Drift scenarios: the params YAML to compare against, relative to the scenario directory. */
  params_spec?: string;
}

export interface FixtureData {
  meta: FixtureMeta;
  faucetHealth?: HttpResult<FaucetHealthBody>;
  faucetChain?: HttpResult<FaucetChainBody>;
  gatewayModels?: HttpResult<unknown>;
  rpcHead?: RpcHead;
  runtimeConstants?: RuntimeConstants;
  eventPages?: EventPage[];
  /** Files that existed but could not be parsed. Reported, never silently dropped. */
  loadErrors?: string[];
  /** The event page files among loadErrors. Census and escrow results consume these. */
  pageErrors?: string[];
}

export function unknownHttp<T>(error: string): HttpResult<T> {
  return { http: null, body: null, error, fetched_at: null };
}

/**
 * An RPC head that was never read. Its error is null: "not read" is unknown, while a read
 * that was tried and failed (error set) is down.
 */
export function unknownHead(): RpcHead {
  return {
    genesis_hash: null,
    finalized: null,
    best_number: null,
    runtime_spec_version: null,
    observed_at: null,
    error: null,
  };
}

/**
 * A file name shown byte for byte: printable ASCII as itself, every other byte (and %) as %XX.
 * The recount shows such a name the same way, so the two can name the same file.
 */
function shownName(raw: Uint8Array): string {
  return [...raw].map((b) => (b >= 0x20 && b < 0x7f && b !== 0x25 ? String.fromCharCode(b) : `%${b.toString(16).toUpperCase().padStart(2, "0")}`)).join("");
}

/** A JSON file whose arrays and objects nest deeper than MAX_NESTING. */
class TooDeep extends Error {}

/** A JSON file that parses, but holds one key twice in one object. */
class DuplicateKey extends Error {
  readonly key: string;
  constructor(key: string) {
    super(`duplicate key ${key}`);
    this.key = key;
  }
}

export class FixtureSource implements Source {
  readonly kind = "fixture" as const;
  readonly trust: Trust = "fixture";
  readonly label: string;
  readonly data: FixtureData;

  constructor(data: FixtureData, label?: string) {
    this.data = data;
    this.label = label ?? `fixture:${data.meta.scenario}`;
  }

  /** Loads a scenario directory. Unparsable files are listed in data.loadErrors, not thrown. */
  static fromDir(dir: string): FixtureSource {
    const loadErrors: string[] = [];
    const pageErrors: string[] = [];
    // Files that exist but could not be read, and why. A saved reading in one of them becomes
    // "nothing read", with the reason in its detail, never a reading that was silently dropped.
    const unreadable = new Map<string, string>();
    const read = <T>(name: string, errors: string[][] = [loadErrors], listed = false): T | undefined => {
      const path = join(dir, name);
      if (!existsSync(path)) {
        // An entry the folder listing produced is never dropped without a word.
        if (listed) for (const list of errors) list.push(`${name}: listed in the folder but cannot be opened`);
        return undefined;
      }
      try {
        // RFC 8259 JSON text is UTF-8: decode strictly, so an invalid byte refuses instead of
        // turning into U+FFFD, and keep a byte order mark so JSON.parse refuses it as Python does.
        const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(readFileSync(path));
        // Checked before parsing, so no parser's own stack limit ever decides (clause 12).
        if (nestingDepth(text) > MAX_NESTING) throw new TooDeep();
        const value = JSON.parse(text) as T;
        // A key that appears twice in one object has no one meaning (RULES.md 3.1 clause 12).
        const twice = duplicateKey(text);
        if (twice !== null) throw new DuplicateKey(twice);
        return value;
      } catch (e) {
        // The parser's own wording changes between Node versions, so outputs say only this.
        const reason =
          e instanceof TooDeep
            ? `nested deeper than ${MAX_NESTING} levels`
            : e instanceof DuplicateKey
            ? `the key ${JSON.stringify(e.key)} appears twice in one object`
            : e instanceof SyntaxError || e instanceof TypeError
              ? "not valid JSON"
              : (e as Error).message;
        for (const list of errors) list.push(`${name}: ${reason}`);
        unreadable.set(name, `${name}: ${reason}`);
        return undefined;
      }
    };
    const http = <T>(name: string): HttpResult<T> | undefined => {
      const r = read<HttpResult<T>>(name);
      return r ?? (unreadable.has(name) ? unknownHttp<T>(unreadable.get(name)!) : undefined);
    };
    const head = (name: string): RpcHead | undefined => {
      const r = read<RpcHead>(name);
      return r ?? (unreadable.has(name) ? { ...unknownHead(), unreadable: unreadable.get(name)! } : undefined);
    };
    const meta = read<FixtureMeta>("meta.json");
    if (!meta) throw new Error(`fixture ${dir} has no readable meta.json`);
    const pagesDir = join(dir, "event-pages");
    let eventPages: EventPage[] | undefined;
    let pagesStat: ReturnType<typeof lstatSync> | null = null;
    try {
      pagesStat = lstatSync(pagesDir);
    } catch {
      pagesStat = null;
    }
    if (pagesStat && !pagesStat.isDirectory()) {
      // RULES.md 3.1 clause 15: event-pages must be a real folder. A file or a link refuses.
      const why = "event-pages: not a folder (it must be a real folder, not a file or a link)";
      loadErrors.push(why);
      pageErrors.push(why);
      eventPages = [];
    } else if (pagesStat) {
      eventPages = [];
      // Names are read as bytes and sorted by bytes, as the recount does. A name that is not strict
      // UTF-8 would otherwise be decoded to U+FFFD and name a file that does not exist (clause 15).
      const entries = readdirSync(pagesDir, { withFileTypes: true, encoding: "buffer" }).sort((x, y) => Buffer.compare(x.name, y.name));
      const strictName = new TextDecoder("utf-8", { fatal: true });
      for (const entry of entries) {
        let name: string;
        try {
          name = strictName.decode(entry.name);
        } catch {
          const why = `event-pages/${shownName(entry.name)}: not a page file (its name is not valid UTF-8)`;
          loadErrors.push(why);
          pageErrors.push(why);
          continue;
        }
        // RULES.md 3.1 clause 15: anything else in event-pages may be a page meant to count, so it
        // is reported, never skipped.
        if (!entry.isFile() || name.startsWith(".") || !name.endsWith(".json")) {
          const why = `event-pages/${name}: not a page file (a regular file named *.json, not starting with a dot)`;
          loadErrors.push(why);
          pageErrors.push(why);
          continue;
        }
        const page = read<EventPage>(join("event-pages", name), [loadErrors, pageErrors], true);
        if (page !== undefined) eventPages.push(page);
      }
    }
    return new FixtureSource(
      {
        meta,
        faucetHealth: http<FaucetHealthBody>("faucet-health.json"),
        faucetChain: http<FaucetChainBody>("faucet-chain.json"),
        gatewayModels: http<unknown>("gateway-models.json"),
        rpcHead: head("rpc-head.json"),
        runtimeConstants: read("runtime-constants.json"),
        eventPages,
        loadErrors,
        pageErrors,
      },
      `fixture:${meta.scenario}`,
    );
  }

  async faucetHealth(): Promise<HttpResult<FaucetHealthBody>> {
    return this.data.faucetHealth ?? unknownHttp("no faucet health in fixture");
  }

  async faucetChain(): Promise<HttpResult<FaucetChainBody>> {
    return this.data.faucetChain ?? unknownHttp("no faucet chain in fixture");
  }

  async gatewayModels(): Promise<HttpResult<unknown>> {
    return this.data.gatewayModels ?? unknownHttp("no gateway models in fixture");
  }

  async rpcHead(): Promise<RpcHead> {
    return this.data.rpcHead ?? unknownHead();
  }

  async runtimeConstants(): Promise<RuntimeConstants | null> {
    return this.data.runtimeConstants ?? null;
  }

  async eventPages(): Promise<EventPage[]> {
    return this.data.eventPages ?? [];
  }

  async eventPageErrors(): Promise<string[]> {
    return this.data.pageErrors ?? [];
  }
}
