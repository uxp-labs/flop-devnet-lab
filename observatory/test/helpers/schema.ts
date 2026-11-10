// A small JSON Schema checker for the keywords our interface schemas use: type (with null
// unions), const, enum, required, properties, additionalProperties: false, items, minimum,
// pattern and local $ref. Returns a list of problems; empty means valid.
type Schema = Record<string, unknown>;

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

function typeMatches(want: string, got: string): boolean {
  return want === got || (want === "number" && got === "integer");
}

export function checkSchema(root: Schema, value: unknown): string[] {
  const problems: string[] = [];
  const resolve = (s: Schema): Schema => {
    const ref = s.$ref;
    if (typeof ref !== "string") return s;
    const path = ref.replace(/^#\//, "").split("/");
    let node: unknown = root;
    for (const p of path) node = (node as Record<string, unknown>)[p];
    return resolve(node as Schema);
  };
  const walk = (s0: Schema, v: unknown, at: string): void => {
    const s = resolve(s0);
    const got = typeOf(v);
    if (s.type !== undefined) {
      const wants = Array.isArray(s.type) ? (s.type as string[]) : [s.type as string];
      if (!wants.some((w) => typeMatches(w, got))) problems.push(`${at}: type ${got}, want ${wants.join("|")}`);
    }
    if ("const" in s && v !== s.const) problems.push(`${at}: ${JSON.stringify(v)} is not ${JSON.stringify(s.const)}`);
    if (Array.isArray(s.enum) && !s.enum.includes(v)) problems.push(`${at}: ${JSON.stringify(v)} not in enum`);
    if (typeof s.minimum === "number" && typeof v === "number" && v < s.minimum) problems.push(`${at}: below minimum`);
    if (typeof s.pattern === "string" && typeof v === "string" && !new RegExp(s.pattern).test(v)) {
      problems.push(`${at}: does not match ${s.pattern}`);
    }
    if (got === "object") {
      const obj = v as Record<string, unknown>;
      const props = (s.properties ?? {}) as Record<string, Schema>;
      for (const r of (s.required ?? []) as string[]) if (!(r in obj)) problems.push(`${at}: missing ${r}`);
      for (const [k, val] of Object.entries(obj)) {
        if (props[k]) walk(props[k], val, `${at}.${k}`);
        else if (s.additionalProperties === false) problems.push(`${at}: unexpected property ${k}`);
        else if (s.additionalProperties && typeof s.additionalProperties === "object") {
          walk(s.additionalProperties as Schema, val, `${at}.${k}`);
        }
      }
    }
    if (got === "array" && s.items && typeof s.items === "object") {
      (v as unknown[]).forEach((item, i) => walk(s.items as Schema, item, `${at}[${i}]`));
    }
  };
  walk(root, value, "$");
  return problems;
}
