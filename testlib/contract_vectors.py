"""The Python loader for contract/rules.json and contract/vectors/*.json: test infrastructure, shared by the
spend-guard and viewer contract tests. imd-flop's one TS loader is imd-flop/test/lib/contract-vectors.ts.
Not imported by any tool. The file format is specified in contract/README.md.

Every vector names all three parts under "expect". A part either has an expectation or
{"not_applicable": "<why>"}; nothing is skipped silently. {"$float": "nan"|"inf"|"-inf"} encodes
non-finite floats, which JSON cannot hold. A vector with status "known_defect" asserts `expect` (today's
output); its `target` is recorded for the fix step and not asserted."""
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "contract"
PARTS = ("imd-flop", "spend-guard", "viewer")
FLOATS = {"nan": math.nan, "inf": math.inf, "-inf": -math.inf}


def decode(v):
    if isinstance(v, dict):
        if set(v) == {"$float"}:
            return FLOATS[v["$float"]]
        return {k: decode(x) for k, x in v.items()}
    if isinstance(v, list):
        return [decode(x) for x in v]
    return v


def rules():
    return json.loads((ROOT / "rules.json").read_text())


def vector_files():
    return sorted((ROOT / "vectors").glob("*.json"))


def vectors():
    """All vectors, schema-checked. Raises ValueError on a malformed file."""
    quirk_ids = {q["id"] for q in rules()["quirks"]}
    defect_ids = {d["id"] for d in rules()["known_defects"]}
    label_rule_ids = {r["id"] for r in rules()["viewer_label_rules"]["rules"]}
    out, seen = [], set()
    for f in vector_files():
        doc = json.loads(f.read_text())
        for v in doc["vectors"]:
            vid = v.get("id")
            if not isinstance(vid, str) or not vid or vid in seen:
                raise ValueError(f"{f.name}: missing or duplicate id {vid!r}")
            seen.add(vid)
            if not isinstance(v.get("rule"), str) or "input" not in v:
                raise ValueError(f"{f.name}:{vid}: needs rule and input")
            exp = v.get("expect")
            if not isinstance(exp, dict) or set(exp) != set(PARTS):
                raise ValueError(f"{f.name}:{vid}: expect must name exactly {PARTS}")
            for part, e in exp.items():
                if not isinstance(e, dict) or not e:
                    raise ValueError(f"{f.name}:{vid}: {part} expectation must be a non-empty object")
                if "not_applicable" in e and (set(e) != {"not_applicable"} or not isinstance(e["not_applicable"], str) or not e["not_applicable"]):
                    raise ValueError(f"{f.name}:{vid}: {part} not_applicable must be the only key and give a reason")
            if "status" in v:
                if v["status"] != "known_defect" or v.get("defect") not in defect_ids or not isinstance(v.get("target"), dict) or not v["target"]:
                    raise ValueError(f"{f.name}:{vid}: status must be known_defect with a known defect id and a target")
            for q in v.get("quirks", []):
                if q not in quirk_ids:
                    raise ValueError(f"{f.name}:{vid}: unknown quirk {q}")
            lr = v.get("label_rules", [])
            if not isinstance(lr, list) or any(x not in label_rule_ids for x in lr):
                raise ValueError(f"{f.name}:{vid}: label_rules must list ids from rules.json viewer_label_rules")
            out.append(dict(v, file=f.name))
    return out


def unreferenced_quirks():
    """Quirk ids in rules.json that no vector pins."""
    used = {q for v in vectors() for q in v.get("quirks", [])}
    return sorted({q["id"] for q in rules()["quirks"]} - used)


def unreferenced_label_rules():
    """FIXER viewer label rule ids in rules.json that no vector names in label_rules."""
    used = {r for v in vectors() for r in v.get("label_rules", [])}
    return sorted({r["id"] for r in rules()["viewer_label_rules"]["rules"]} - used)


def for_part(part):
    """(applicable, not_applicable) vectors for one part."""
    vs = vectors()
    return ([v for v in vs if "not_applicable" not in v["expect"][part]],
            [v for v in vs if "not_applicable" in v["expect"][part]])


def same(a, b):
    """Deep equality where nan equals nan and int 1 equals float 1.0 only when both are numbers (bools are not numbers)."""
    if isinstance(a, bool) or isinstance(b, bool):
        return type(a) is type(b) and a == b
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return (math.isnan(a) and math.isnan(b)) if (isinstance(a, float) and math.isnan(a)) or (isinstance(b, float) and math.isnan(b)) else a == b
    if isinstance(a, dict) and isinstance(b, dict):
        return set(a) == set(b) and all(same(a[k], b[k]) for k in a)
    if isinstance(a, (list, tuple)) and isinstance(b, (list, tuple)):
        return len(a) == len(b) and all(same(x, y) for x, y in zip(a, b))
    return a == b
