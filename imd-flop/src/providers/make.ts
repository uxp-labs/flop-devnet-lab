/**
 * The one place that makes a provider from a name. `run` and `receipt --refresh` make one to spend and read
 * with; `quote` makes one only to ask for an estimate. Every name comes from the table in kinds.ts.
 */
import { CliError, EXIT } from "../errors.js";
import { loadConfig } from "../config.js";
import { network } from "../networks.js";
import { gatewayKeyFile } from "../paths.js";
import type { Fetch } from "../gateway.js";
import { PROVIDER_NAMES, isProviderName, type ProviderName } from "./kinds.js";
import type { Provider } from "./interface.js";
import { FlopProvider, gatewayQuoteProvider } from "./gateway.js";
import { MOCK_SCENARIOS, MockProvider, type MockScenario } from "./mock.js";

/** What a maker may need: the data home, and for a run the seat, the network access and the run's flags. */
export interface MakeContext {
  home: string;
  fetch?: Fetch;
  env: NodeJS.ProcessEnv;
}
export type ProviderUse = { for: "quote" } | { for: "run"; seat: string; live?: boolean; scenario?: string };

interface Maker {
  run(ctx: MakeContext, use: { seat: string; live?: boolean; scenario?: string }): Provider;
  quote(ctx: MakeContext): Provider;
}

const MAKERS: Record<ProviderName, Maker> = {
  mock: {
    run(_ctx, use) {
      const sc = (use.scenario ?? "ok") as MockScenario;
      if (!MOCK_SCENARIOS.includes(sc)) throw new CliError(`--mock-scenario must be one of ${MOCK_SCENARIOS.join(", ")}`, EXIT.USAGE);
      return new MockProvider(sc);
    },
    quote: () => new MockProvider(),
  },
  flop: {
    run(ctx, use) {
      if (!use.live) throw new CliError("--provider flop spends real devnet FLOP: it needs --live, a cap, a fully signed link and an enrolled gateway key", EXIT.REFUSED_RULE);
      return new FlopProvider(network(loadConfig(ctx.home).network), gatewayKeyFile(ctx.home, use.seat), ctx.fetch, ctx.env.ETH_RPC_URL);
    },
    quote: (ctx) => gatewayQuoteProvider(() => network(loadConfig(ctx.home).network), ctx.fetch ?? globalThis.fetch),
  },
};

/**
 * A provider of the named kind, for its use. A name not in the table: a run (or a refresh) refuses with a usage
 * error and makes nothing; a quote uses the mock, as `quote` always has.
 */
export function makeProvider(name: string, ctx: MakeContext, use: ProviderUse): Provider {
  if (use.for === "quote") return (isProviderName(name) ? MAKERS[name] : MAKERS.mock).quote(ctx);
  if (!isProviderName(name)) throw new CliError(`--provider must be ${PROVIDER_NAMES.join(" or ")}`, EXIT.USAGE);
  return MAKERS[name].run(ctx, use);
}
