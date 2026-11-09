// Demo only: signs a link's EIP-712 typed data with a THROWAWAY wallet generated in memory.
// The key is never printed or written. Prints "<address> <signature>". Real holders sign in their own wallet.
import { readFileSync } from "node:fs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const link = JSON.parse(readFileSync(process.argv[2], "utf8"));
const td = link.eip712;
const wallet = privateKeyToAccount(generatePrivateKey());
const sig = await wallet.signTypedData({
  domain: td.domain,
  types: td.types,
  primaryType: td.primaryType,
  message: { ...td.message, tokenId: BigInt(td.message.tokenId), issuedAt: BigInt(td.message.issuedAt) },
});
process.stdout.write(`${wallet.address} ${sig}\n`);
