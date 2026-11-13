// The whole decoder shape derived a second way, from the reference decoder's own parse of the
// metadata (polkadot-api, tests only), with a namer and a type closure of its own: nothing here
// calls src/scale. A test holds each reviewed shape file to it, so the shape the decoder pins is
// the one an independent reader of the same metadata finds (review round 18, round 22 for
// spec 1014020, and round 29 for the entries decoder-shape@3 adds, listed here by hand).
import { getDynamicBuilder, getLookupFn } from "@polkadot-api/metadata-builders";
import { decAnyMetadata, unifyMetadata } from "@polkadot-api/substrate-bindings";

/** The shape of these metadata bytes, as the reference reads them, in the shape file's form before it is written. */
export function referenceShape(metadata: Uint8Array) {
  const REF = decAnyMetadata(metadata);
  const BUILDER = getDynamicBuilder(getLookupFn(unifyMetadata(REF)));
  if (REF.metadata.tag !== "v14") throw new Error("not v14");
  const v14 = REF.metadata.value;
  const lk = v14.lookup;
  const name = (id: number): string => {
    const t = lk[id];
    if (t === undefined) throw new Error(`no type ${id}`);
    const d = t.def;
    if (d.tag === "primitive") return d.value.tag;
    if (t.path.length > 0) {
      const ps = t.params.filter((p) => p.type !== undefined).map((p) => name(p.type as number));
      return `${t.path.at(-1)}${ps.length ? `<${ps.join(", ")}>` : ""}#${id}`;
    }
    if (d.tag === "sequence") return `Vec<${name(d.value)}>`;
    if (d.tag === "array") return `[${name(d.value.type)}; ${d.value.len}]`;
    if (d.tag === "tuple") return `(${d.value.map(name).join(", ")})`;
    if (d.tag === "compact") return `Compact<${name(d.value)}>`;
    return `${d.tag}#${id}`;
  };
  const HASH: Record<string, string> = { Blake2128: "Blake2_128", Blake2256: "Blake2_256", Blake2128Concat: "Blake2_128Concat", Twox128: "Twox128", Twox256: "Twox256", Twox64Concat: "Twox64Concat", Identity: "Identity" };
  const fields = (fs: { name?: string; type: number }[]) => fs.map((f) => ({ name: f.name ?? null, type: name(f.type) }));
  const variants = (id: number) => {
    const d = lk[id]?.def;
    if (d?.tag !== "variant") throw new Error("not a variant");
    return d.value.map((v) => ({ fields: fields(v.fields), index: v.index, name: v.name }));
  };
  const composite = (id: number) => {
    const d = lk[id]?.def;
    if (d?.tag !== "composite") throw new Error("not a composite");
    return d.value;
  };
  const pallet = (n: string) => v14.pallets.find((p) => p.name === n);
  const entry = (p: string, e: string) => {
    const x = pallet(p)?.storage?.items.find((i) => i.name === e);
    if (x === undefined) throw new Error("no entry");
    const map = x.type.tag === "map";
    return {
      default: x.fallback,
      hashers: map ? (x.type.value as { hashers: { tag: string }[] }).hashers.map((h) => HASH[h.tag]) : [],
      key: map ? name((x.type.value as { key: number }).key) : null,
      modifier: x.modifier === 0 ? "Optional" : "Default",
      value: name(map ? (x.type.value as { value: number }).value : (x.type.value as number)),
      valueId: map ? (x.type.value as { value: number }).value : (x.type.value as number),
      keyId: map ? [(x.type.value as { key: number }).key] : [],
    };
  };
  const strip = ({ valueId, keyId, ...rest }: ReturnType<typeof entry>) => rest;
  // The closure of types, walked over the reference's lookup on its own.
  const describe = (id: number): { desc: Record<string, unknown>; names: number[] } => {
    const t = lk[id];
    if (t === undefined) throw new Error(`no type ${id}`);
    const d = t.def;
    const base = { kind: d.tag, path: t.path };
    const params = t.params.flatMap((p) => (p.type === undefined ? [] : [p.type as number]));
    if (d.tag === "primitive") return { desc: { ...base, primitive: d.value.tag }, names: params };
    if (d.tag === "composite") return { desc: { ...base, fields: fields(d.value) }, names: [...params, ...d.value.map((f) => f.type)] };
    if (d.tag === "variant") return { desc: { ...base, variants: d.value.map((v) => ({ fields: fields(v.fields), index: v.index, name: v.name })) }, names: [...params, ...d.value.flatMap((v) => v.fields.map((f) => f.type))] };
    if (d.tag === "sequence") return { desc: { ...base, element: name(d.value) }, names: [...params, d.value] };
    if (d.tag === "array") return { desc: { ...base, element: name(d.value.type), len: d.value.len }, names: [...params, d.value.type] };
    if (d.tag === "tuple") return { desc: { ...base, types: d.value.map(name) }, names: [...params, ...d.value] };
    if (d.tag === "compact") return { desc: { ...base, type: name(d.value) }, names: [...params, d.value] };
    throw new Error(`a ${d.tag} in the closure`);
  };
  const closure = (roots: number[]) => {
    const seen = new Set<number>();
    const out: Record<string, unknown> = {};
    const queue = [...roots];
    while (queue.length > 0) {
      const id = queue.shift() as number;
      if (seen.has(id)) continue;
      seen.add(id);
      const { desc, names } = describe(id);
      out[name(id)] = desc;
      queue.push(...names);
    }
    return out;
  };
  const cc = pallet("ComputeChannel");
  const sys = pallet("System");
  const events = entry("System", "Events");
  const seq = lk[events.valueId]?.def;
  if (seq?.tag !== "sequence") throw new Error("not a list");
  const upgrade = entry("System", "LastRuntimeUpgrade");
  const channels = entry("ComputeChannel", "Channels");
  const channel = composite(channels.valueId);
  const state = channel.find((f) => f.name === "state");
  const fsk = pallet("FlopSessionKeys");
  const sessions = entry("FlopSessionKeys", "Sessions");
  const nonces = entry("FlopSessionKeys", "SessionNonces");
  const breakers = entry("FlopSessionKeys", "CircuitBreakers");
  // The entries decoder-shape@3 adds, each pallet's section and each entry's key by hand.
  const added: [section: string, pallet: string, [key: string, entry: string][]][] = [
    ["system", "System", [["account", "Account"]]],
    ["compute_channel", "ComputeChannel", [["failed_acks", "FailedAcks"], ["channel_authored_opened_at", "ChannelAuthoredOpenedAt"]]],
    ["flop_session_keys", "FlopSessionKeys", [["delegate_sessions", "DelegateSessions"]]],
    ["model_registry", "ModelRegistry", [["models", "Models"], ["measured_roots", "MeasuredRoots"], ["allowed_decode_policies", "AllowedDecodePolicies"]]],
    ["miner_staking", "MinerStaking", [["miners", "Miners"]]],
    ["hw_calibration", "HwCalibration", [["calibration_versions", "CalibrationVersions"], ["last_initial_calibration", "LastInitialCalibration"]]],
  ];
  const addedEntries = added.flatMap(([, p, es]) => es.map(([, e]) => entry(p, e)));
  const sectionOf = (section: string, p: string, es: [string, string][]) => {
    const x = pallet(p);
    const out: Record<string, unknown> = Object.fromEntries(es.map(([k, e]) => [k, strip(entry(p, e))]));
    if (["model_registry", "miner_staking", "hw_calibration"].includes(section)) Object.assign(out, { index: x?.index, storage_prefix: x?.storage?.prefix });
    return out;
  };
  const more = Object.fromEntries(added.map(([section, p, es]) => [section, sectionOf(section, p, es)]));
  const versionConstant = sys?.constants.find((c) => c.name === "Version");
  const version = BUILDER.buildConstant("System", "Version").dec(versionConstant?.value ?? "0x") as { spec_name: string; spec_version: number };
  const mine = {
    compute_channel: {
      channel_states: variants(state?.type ?? -1),
      channels: { ...strip(channels), fields: fields(channel) },
      ...more.compute_channel,
      events: variants(cc?.events ?? -1),
      index: cc?.index,
      storage_prefix: cc?.storage?.prefix,
    },
    flop_session_keys: {
      circuit_breakers: strip(breakers),
      index: fsk?.index,
      storage_prefix: fsk?.storage?.prefix,
      session_nonces: strip(nonces),
      sessions: strip(sessions),
      ...more.flop_session_keys,
    },
    hw_calibration: more.hw_calibration,
    miner_staking: more.miner_staking,
    model_registry: more.model_registry,
    schema: "flop-observatory/decoder-shape@3",
    spec_name: version.spec_name,
    spec_version: version.spec_version,
    system: {
      events: { ...strip(events), record: fields(composite(seq.value)) },
      index: sys?.index,
      storage_prefix: sys?.storage?.prefix,
      last_runtime_upgrade: { ...strip(upgrade), fields: fields(composite(upgrade.valueId)) },
      version: name(versionConstant?.type ?? -1),
      ...more.system,
    },
    types: closure([events.valueId, upgrade.valueId, channels.valueId, ...channels.keyId, versionConstant?.type ?? -1, ...[sessions, nonces, breakers, ...addedEntries].flatMap((e) => [e.valueId, ...e.keyId])]),
  };
  return mine;
}
