import fs from "node:fs";
import path from "node:path";
import solc from "solc";

const root = path.resolve(import.meta.dirname, "../..");
const contractsRoot = path.join(root, "contracts/src");

function collectSolidityFiles(directory, sources = {}) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) collectSolidityFiles(absolute, sources);
    if (entry.isFile() && entry.name.endsWith(".sol")) {
      const sourceName = path.relative(root, absolute).replaceAll(path.sep, "/");
      sources[sourceName] = { content: fs.readFileSync(absolute, "utf8") };
    }
  }
  return sources;
}

function resolveImport(importPath) {
  const candidates = [
    path.join(root, importPath),
    path.join(root, "contracts/src", importPath),
    path.join(root, "node_modules", importPath)
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return { contents: fs.readFileSync(candidate, "utf8") };
  }
  return { error: `Import not found: ${importPath}` };
}

export function compileContracts() {
  const input = {
    language: "Solidity",
    sources: collectSolidityFiles(contractsRoot),
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } }
    }
  };

  const output = JSON.parse(solc.compile(JSON.stringify(input), { import: resolveImport }));
  const errors = (output.errors ?? []).filter((item) => item.severity === "error");
  if (errors.length) throw new Error(errors.map((item) => item.formattedMessage).join("\n"));
  return output.contracts;
}

export function artifact(contracts, source, name) {
  const result = contracts[source]?.[name];
  if (!result) throw new Error(`Missing artifact ${source}:${name}`);
  return { abi: result.abi, bytecode: `0x${result.evm.bytecode.object}` };
}
