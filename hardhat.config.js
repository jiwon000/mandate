import hardhatEthers from "@nomicfoundation/hardhat-ethers";

export default {
  plugins: [hardhatEthers],
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "prague"
    }
  },
  paths: {
    sources: "./contracts/src",
    tests: "./contracts/test-js",
    cache: "./contracts/cache",
    artifacts: "./contracts/artifacts"
  }
};
