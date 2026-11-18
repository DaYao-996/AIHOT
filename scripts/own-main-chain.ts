// Independently runnable entry for one contract run. Defaults to the v15 inputs.
const defaults: Record<string, string> = {
  "--config": "docs/own-pipeline/contract-run-v15/CONFIG.json",
  "--out-dir": "docs/own-pipeline/contract-run-v15",
  "--prior": "docs/own-pipeline/contract-run-v15/PRIOR17.json",
  "--contract": "docs/own-pipeline/contract-run-v15/inputs/SOURCE_CONTRACT_v1.json",
};
for (const [flag, value] of Object.entries(defaults)) {
  if (!process.argv.includes(flag)) process.argv.push(flag, value);
}
await import("./own-contract-entry.ts");
