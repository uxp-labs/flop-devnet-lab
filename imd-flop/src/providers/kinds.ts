/**
 * The one list of provider names, with the kind of each. ProviderName, the ledger's LEDGER_PROVIDERS
 * (ledger.ts) and the maker (make.ts) all come from this table. Its names, in this order, are
 * contract/rules.json LEDGER_PROVIDERS; test/provider-table.test.ts holds the two equal.
 *
 * A kind is what the run path asks of a provider, by its name:
 * - paid: a call spends real FLOP, so the run path runs the paid network gate first (gateway.ts assertPaidNetwork).
 * - mock: nothing is spent; its rows, responses and receipts say mock, and only it may bypass the link.
 * - needsWalletLink: the link must carry the seat wallet's signature, and the seat owner is read on chain.
 */
export interface ProviderKind {
  readonly paid: boolean;
  readonly mock: boolean;
  readonly needsWalletLink: boolean;
}

/** An entry and its kind, frozen: nothing in the table can be changed at run time. */
const entry = <N extends string>(name: N, kind: ProviderKind) => Object.freeze({ name, kind: Object.freeze({ ...kind }) });

const TABLE = Object.freeze([
  entry("mock", { paid: false, mock: true, needsWalletLink: false }),
  entry("flop", { paid: true, mock: false, needsWalletLink: true }),
] as const);

export type ProviderName = (typeof TABLE)[number]["name"];

/** Every provider name, in the order of contract/rules.json LEDGER_PROVIDERS. */
export const PROVIDER_NAMES: readonly ProviderName[] = Object.freeze(TABLE.map((e) => e.name));

/** The same names with the paid ones first: the order `status` and `cap show` print them in. */
export const PROVIDER_NAMES_PAID_FIRST: readonly ProviderName[] = Object.freeze([...TABLE.filter((e) => e.kind.paid), ...TABLE.filter((e) => !e.kind.paid)].map((e) => e.name));

/** The provider a command uses when none is named. */
export const DEFAULT_PROVIDER: ProviderName = TABLE[0].name;

/**
 * The kind a name not in the table gets: not paid, not a mock, no wallet link. kindOf gives it for a name read
 * from a stored ledger row or receipt file, where it must answer and not throw; the ledger cannot place such a
 * row (ledger.ts LEDGER_PROVIDERS). A provider object of such a name never reaches it: make.ts makes none for
 * run or receipt --refresh, and the run path refuses one a caller hands it (UNLISTED_PROVIDER_REFUSAL).
 */
export const UNLISTED_KIND: ProviderKind = Object.freeze({ paid: false, mock: false, needsWalletLink: false });

/** The usage error for a provider name not in the table, given by the maker and by the run path. */
export const UNLISTED_PROVIDER_REFUSAL = `--provider must be ${PROVIDER_NAMES.join(" or ")}`;

export function isProviderName(name: unknown): name is ProviderName {
  return typeof name === "string" && TABLE.some((e) => e.name === name);
}

/** The kind of a provider name, for a provider object and for a stored row alike; a name not in the table gets UNLISTED_KIND. */
export function kindOf(name: string): ProviderKind {
  return TABLE.find((e) => e.name === name)?.kind ?? UNLISTED_KIND;
}

/** The first part of a request id run makes: a mock's ids say mock, every other provider's say imdflop. */
export function requestIdPrefix(kind: ProviderKind): string {
  return kind.mock ? "mock" : "imdflop";
}
