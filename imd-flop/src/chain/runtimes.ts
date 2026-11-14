// Written by scripts/chain-table.mjs from recorded metadata (its SOURCES). Do not edit by hand:
// test/chain-table.test.ts derives it again and compares with this file byte for byte.
import { deepFreeze } from "../freeze.js";
import type { Runtime } from "./table.js";

/** Frozen here, where it is defined, so no module can change it before the encoder reads it. */
export const RUNTIMES: readonly Runtime[] = deepFreeze([
  {
    "specName": "tzkv-runtime",
    "specVersion": 1014020,
    "transactionVersion": 2,
    "genesisHash": "0x99c172c095340ace980631f9123544c6bebd4839f3437e463533422d8be2d631",
    "metadataSha256": "91294eb61225c4de7459e6a8fed3c37169a2c8a1b1906b46a5890d5e0d328238",
    "extrinsicVersion": 4,
    "address": {
      "variant": "Id",
      "index": 0
    },
    "signature": {
      "variant": "Ed25519",
      "index": 0
    },
    "signedExtensions": [
      {
        "identifier": "CheckNonZeroSender",
        "extra": {
          "kind": "unit"
        },
        "additionalSigned": {
          "kind": "unit"
        }
      },
      {
        "identifier": "CheckSpecVersion",
        "extra": {
          "kind": "unit"
        },
        "additionalSigned": {
          "kind": "u32"
        }
      },
      {
        "identifier": "CheckTxVersion",
        "extra": {
          "kind": "unit"
        },
        "additionalSigned": {
          "kind": "u32"
        }
      },
      {
        "identifier": "CheckGenesis",
        "extra": {
          "kind": "unit"
        },
        "additionalSigned": {
          "kind": "bytes32"
        }
      },
      {
        "identifier": "CheckMortality",
        "extra": {
          "kind": "era"
        },
        "additionalSigned": {
          "kind": "bytes32"
        }
      },
      {
        "identifier": "CheckNonce",
        "extra": {
          "kind": "compact",
          "of": "u32"
        },
        "additionalSigned": {
          "kind": "unit"
        }
      },
      {
        "identifier": "CheckWeight",
        "extra": {
          "kind": "unit"
        },
        "additionalSigned": {
          "kind": "unit"
        }
      },
      {
        "identifier": "ChargeTransactionPayment",
        "extra": {
          "kind": "compact",
          "of": "u128"
        },
        "additionalSigned": {
          "kind": "unit"
        }
      },
      {
        "identifier": "CheckMetadataHash",
        "extra": {
          "kind": "struct",
          "fields": [
            {
              "name": "mode",
              "type": {
                "kind": "enum",
                "variants": [
                  {
                    "name": "Disabled",
                    "index": 0
                  },
                  {
                    "name": "Enabled",
                    "index": 1
                  }
                ]
              }
            }
          ]
        },
        "additionalSigned": {
          "kind": "option",
          "of": {
            "kind": "bytes32"
          }
        }
      }
    ],
    "calls": [
      {
        "pallet": "FlopSessionKeys",
        "name": "execute_via_session",
        "palletIndex": 94,
        "callIndex": 2,
        "fields": [
          {
            "name": "owner",
            "type": {
              "kind": "bytes32"
            }
          },
          {
            "name": "call",
            "type": {
              "kind": "call"
            }
          },
          {
            "name": "spend_amount",
            "type": {
              "kind": "u128"
            }
          },
          {
            "name": "nonce",
            "type": {
              "kind": "u64"
            }
          }
        ]
      },
      {
        "pallet": "ComputeChannel",
        "name": "open_channel",
        "palletIndex": 103,
        "callIndex": 0,
        "fields": [
          {
            "name": "miner",
            "type": {
              "kind": "bytes32"
            }
          },
          {
            "name": "model_hash",
            "type": {
              "kind": "bytes32"
            }
          },
          {
            "name": "measured_root",
            "type": {
              "kind": "bytes32"
            }
          },
          {
            "name": "decode_policy_hash",
            "type": {
              "kind": "bytes32"
            }
          },
          {
            "name": "precision",
            "type": {
              "kind": "enum",
              "variants": [
                {
                  "name": "FP32",
                  "index": 0
                },
                {
                  "name": "FP16",
                  "index": 1
                },
                {
                  "name": "BF16",
                  "index": 2
                },
                {
                  "name": "INT8",
                  "index": 3
                },
                {
                  "name": "INT4",
                  "index": 4
                },
                {
                  "name": "Mixed",
                  "index": 5
                }
              ]
            }
          },
          {
            "name": "enclave_key",
            "type": {
              "kind": "bytes32"
            }
          },
          {
            "name": "agent_key",
            "type": {
              "kind": "bytes32"
            }
          },
          {
            "name": "sla",
            "type": {
              "kind": "struct",
              "fields": [
                {
                  "name": "max_turns",
                  "type": {
                    "kind": "u32"
                  }
                },
                {
                  "name": "max_duration",
                  "type": {
                    "kind": "u32"
                  }
                },
                {
                  "name": "reattest_every",
                  "type": {
                    "kind": "u32"
                  }
                }
              ]
            }
          },
          {
            "name": "escrow",
            "type": {
              "kind": "u128"
            }
          },
          {
            "name": "nonce",
            "type": {
              "kind": "u64"
            }
          },
          {
            "name": "settlement_class",
            "type": {
              "kind": "enum",
              "variants": [
                {
                  "name": "Standard",
                  "index": 0
                },
                {
                  "name": "CertificatePremium",
                  "index": 1
                }
              ]
            }
          }
        ]
      },
      {
        "pallet": "ComputeChannel",
        "name": "top_up_escrow",
        "palletIndex": 103,
        "callIndex": 1,
        "fields": [
          {
            "name": "channel_id",
            "type": {
              "kind": "bytes32"
            }
          },
          {
            "name": "additional",
            "type": {
              "kind": "u128"
            }
          }
        ]
      },
      {
        "pallet": "ComputeChannel",
        "name": "timeout",
        "palletIndex": 103,
        "callIndex": 5,
        "fields": [
          {
            "name": "channel_id",
            "type": {
              "kind": "bytes32"
            }
          }
        ]
      },
      {
        "pallet": "ComputeChannel",
        "name": "force_open",
        "palletIndex": 103,
        "callIndex": 9,
        "fields": [
          {
            "name": "miner",
            "type": {
              "kind": "bytes32"
            }
          },
          {
            "name": "model_hash",
            "type": {
              "kind": "bytes32"
            }
          },
          {
            "name": "measured_root",
            "type": {
              "kind": "bytes32"
            }
          },
          {
            "name": "decode_policy_hash",
            "type": {
              "kind": "bytes32"
            }
          },
          {
            "name": "precision",
            "type": {
              "kind": "enum",
              "variants": [
                {
                  "name": "FP32",
                  "index": 0
                },
                {
                  "name": "FP16",
                  "index": 1
                },
                {
                  "name": "BF16",
                  "index": 2
                },
                {
                  "name": "INT8",
                  "index": 3
                },
                {
                  "name": "INT4",
                  "index": 4
                },
                {
                  "name": "Mixed",
                  "index": 5
                }
              ]
            }
          },
          {
            "name": "agent_key",
            "type": {
              "kind": "bytes32"
            }
          },
          {
            "name": "sla",
            "type": {
              "kind": "struct",
              "fields": [
                {
                  "name": "max_turns",
                  "type": {
                    "kind": "u32"
                  }
                },
                {
                  "name": "max_duration",
                  "type": {
                    "kind": "u32"
                  }
                },
                {
                  "name": "reattest_every",
                  "type": {
                    "kind": "u32"
                  }
                }
              ]
            }
          },
          {
            "name": "escrow",
            "type": {
              "kind": "u128"
            }
          },
          {
            "name": "nonce",
            "type": {
              "kind": "u64"
            }
          }
        ]
      },
      {
        "pallet": "ComputeChannel",
        "name": "expire_force_open",
        "palletIndex": 103,
        "callIndex": 11,
        "fields": [
          {
            "name": "channel_id",
            "type": {
              "kind": "bytes32"
            }
          }
        ]
      }
    ]
  }
]);
