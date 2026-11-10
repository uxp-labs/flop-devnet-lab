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
    const read = <T>(name: string, errors: string[][] = [loadErrors]): T | undefined => {
      const path = join(dir, name);
      if (!existsSync(path)) return undefined;
      try {
        // RFC 8259 JSON text is UTF-8: decode strictly, so an invalid byte refuses instead of
        // turning into U+FFFD, and keep a byte order mark so JSON.parse refuses it as Python does.
        const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(readFileSync(path));
        return JSON.parse(text) as T;
      } catch (e) {
        // The parser's own wording changes between Node versions, so outputs say only this.
        const reason = e instanceof SyntaxError || e instanceof TypeError ? "not valid JSON" : (e as Error).message;
        for (const list of errors) list.push(`${name}: ${reason}`);
        return undefined;
      }
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
      const entries = readdirSync(pagesDir, { withFileTypes: true }).sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
      for (const entry of entries) {
        const name = entry.name;
        // RULES.md 3.1 clause 15: anything else in event-pages may be a page meant to count, so it
        // is reported, never skipped.
        if (!entry.isFile() || name.startsWith(".") || !name.endsWith(".json")) {
          const why = `event-pages/${name}: not a page file (a regular file named *.json, not starting with a dot)`;
          loadErrors.push(why);
          pageErrors.push(why);
          continue;
        }
        const page = read<EventPage>(join("event-pages", name), [loadErrors, pageErrors]);
        if (page !== undefined) eventPages.push(page);
      }
    }
    return new FixtureSource(
      {
        meta,
        faucetHealth: read("faucet-health.json"),
        faucetChain: read("faucet-chain.json"),
        gatewayModels: read("gateway-models.json"),
        rpcHead: read("rpc-head.json"),
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
