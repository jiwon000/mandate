import fs from "node:fs";
import path from "node:path";
import { compileContracts } from "./compiler.mjs";

const contracts = compileContracts();
const out = path.resolve(import.meta.dirname, "../artifacts-local");
fs.rmSync(out, { recursive: true, force: true });

let count = 0;
for (const [source, entries] of Object.entries(contracts)) {
  if (!source.startsWith("contracts/src/")) continue;
  for (const [name, compiled] of Object.entries(entries)) {
    const destination = path.join(out, source.replace("contracts/src/", ""), `${name}.json`);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, JSON.stringify({
      contractName: name,
      sourceName: source,
      abi: compiled.abi,
      bytecode: `0x${compiled.evm.bytecode.object}`
    }, null, 2));
    count += 1;
  }
}

console.log(`Compiled ${count} Mandate contracts with solc ${process.env.npm_package_devDependencies_solc ?? "0.8.24"}.`);
