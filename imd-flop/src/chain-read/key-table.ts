// Written by scripts/read-key-table.mjs from committed files. Do not edit: run the script again.
// test/chain-read-keys.test.ts derives it again and compares byte for byte.
import { deepFreeze } from "../freeze.js";
import type { KeyTable } from "./key-table-types.js";

export const SOURCES = deepFreeze([
  {
    "tape": "observatory/fixtures/recording-20261112080132-05842a6db1e9c890/tape.jsonl",
    "facts": "research/2026-11-12-session-rerun-1014020/facts-1014020.json",
    "shapeFile": "shapes/tzkv-runtime-1014020.json"
  }
]);

export const KEY_TABLE: KeyTable = deepFreeze({
  "system": {
    "events": {
      "pallet": "System",
      "entry": "Events",
      "palletPart": "0x26aa394eea5630e07c48ae0c9558cef7",
      "entryPart": "0x80d41e5e16056765bc8461851072c9d7",
      "hashers": [],
      "modifier": "Default"
    },
    "last_runtime_upgrade": {
      "pallet": "System",
      "entry": "LastRuntimeUpgrade",
      "palletPart": "0x26aa394eea5630e07c48ae0c9558cef7",
      "entryPart": "0xf9cce9c888469bb1a0dceaa129672ef8",
      "hashers": [],
      "modifier": "Optional"
    }
  },
  "runtimes": [
    {
      "specName": "tzkv-runtime",
      "specVersion": 1014020,
      "shapeFile": "shapes/tzkv-runtime-1014020.json",
      "metadataSha256": "91294eb61225c4de7459e6a8fed3c37169a2c8a1b1906b46a5890d5e0d328238",
      "entries": {
        "sessions": {
          "pallet": "FlopSessionKeys",
          "entry": "Sessions",
          "palletPart": "0x26d6680094539fc341d5ea8ffc79d76f",
          "entryPart": "0x028685274e698e781f7f2766cba0cc83",
          "hashers": [
            "Blake2_128Concat",
            "Blake2_128Concat"
          ],
          "modifier": "Optional"
        },
        "session_nonces": {
          "pallet": "FlopSessionKeys",
          "entry": "SessionNonces",
          "palletPart": "0x26d6680094539fc341d5ea8ffc79d76f",
          "entryPart": "0xa8bf8c9b4fb4963e0d891d0ea6eb7b2c",
          "hashers": [
            "Blake2_128Concat",
            "Blake2_128Concat"
          ],
          "modifier": "Default"
        },
        "circuit_breakers": {
          "pallet": "FlopSessionKeys",
          "entry": "CircuitBreakers",
          "palletPart": "0x26d6680094539fc341d5ea8ffc79d76f",
          "entryPart": "0x8ab2f41796e7514fa8610f8d361c94e7",
          "hashers": [
            "Blake2_128Concat"
          ],
          "modifier": "Optional"
        }
      },
      "records": {
        "session": [
          {
            "name": "owner",
            "type": {
              "kind": "bytes",
              "length": 32
            }
          },
          {
            "name": "delegate",
            "type": {
              "kind": "bytes",
              "length": 32
            }
          },
          {
            "name": "spending_cap",
            "type": {
              "kind": "u128"
            }
          },
          {
            "name": "per_tx_limit",
            "type": {
              "kind": "u128"
            }
          },
          {
            "name": "daily_cap",
            "type": {
              "kind": "u128"
            }
          },
          {
            "name": "epoch_spent",
            "type": {
              "kind": "u128"
            }
          },
          {
            "name": "epoch_start",
            "type": {
              "kind": "u32"
            }
          },
          {
            "name": "spent",
            "type": {
              "kind": "u128"
            }
          },
          {
            "name": "expires_at",
            "type": {
              "kind": "u32"
            }
          },
          {
            "name": "allowed_pallets",
            "type": {
              "kind": "list",
              "of": {
                "kind": "bytes"
              }
            }
          },
          {
            "name": "active",
            "type": {
              "kind": "bool"
            }
          }
        ],
        "circuitBreaker": [
          {
            "name": "period_start",
            "type": {
              "kind": "u32"
            }
          },
          {
            "name": "tx_count",
            "type": {
              "kind": "u32"
            }
          },
          {
            "name": "total_spend",
            "type": {
              "kind": "u128"
            }
          },
          {
            "name": "tripped",
            "type": {
              "kind": "bool"
            }
          }
        ],
        "sessionNonce": {
          "kind": "u64"
        }
      },
      "crossCheck": {
        "pallet": "FlopSessionKeys",
        "event": "SessionCallExecuted",
        "keys": [
          "owner",
          "delegate"
        ],
        "totals": [
          "spent",
          "epoch_spent"
        ]
      }
    }
  ]
});
