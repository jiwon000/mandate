// The demo's accounts, derived from one mnemonic at the same indices the
// in-process EDR node hands out, so a live deployment reads like the local one:
// owner 0, allocator 1, agents 2-5, keeper 9. Testnet-only keys; the server
// signs with allocator, agents and keeper on the browser's behalf.
import { HDNodeWallet, Mnemonic } from "ethers";

export const HD_INDEX = { owner: 0, allocator: 1, agents: [2, 3, 4, 5], keeper: 9 };

export function demoWallets(phrase, provider) {
  const mnemonic = Mnemonic.fromPhrase(String(phrase).trim());
  const at = (index) => HDNodeWallet.fromMnemonic(mnemonic, `m/44'/60'/0'/0/${index}`).connect(provider);
  return {
    owner: at(HD_INDEX.owner),
    allocator: at(HD_INDEX.allocator),
    agents: HD_INDEX.agents.map(at),
    keeper: at(HD_INDEX.keeper)
  };
}
