// Reads the solc output `npm run compile` writes to contracts/artifacts-local.
// Shared by every script that talks to a chain it did not deploy in-process.
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");

export function loadArtifact(relativePath, name) {
  const file = path.join(root, "contracts/artifacts-local", relativePath, `${name}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(`Missing ${file}. Run \`npm run compile\` first.`);
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function loadAbi(relativePath, name) {
  return loadArtifact(relativePath, name).abi;
}
