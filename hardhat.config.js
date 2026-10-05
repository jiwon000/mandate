import hardhatEthers from "@nomicfoundation/hardhat-ethers";

export default {
  plugins: [hardhatEthers],
  solidity: {
    version: "0.8.37",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "prague"
    }
  },
  // Lets a test fork Monad testnet (Perpl's exchange lives there). EDR needs a
  // hardfork for every block it replays; Monad runs Prague rules throughout.
  chainDescriptors: {
    10143: { name: "Monad testnet", hardforkHistory: { prague: { blockNumber: 0 } } }
  },
  paths: {
    sources: "./contracts/src",
    tests: "./contracts/test-js",
    cache: "./contracts/cache",
    artifacts: "./contracts/artifacts"
  }
};
