// Dry-run gate for the one-shot importer. It does not start a worker.
import { cliEntryAllowed, assessSwitches } from "../site/own-pipeline.ts";

const gate = cliEntryAllowed(process.env);
const idle = assessSwitches(process.env, false);
const report = {
  ok: gate.ok && idle.every((row) => !row.armed),
  entry: "cli",
  workerStarted: false,
  outboundIfWorker: gate.outboundIfWorker,
  localDeleteIfWorker: gate.localDeleteIfWorker,
  note: "publication 投影不是发送。本命令不启动 worker，因此也不会跑保留期删除。",
};
console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exit(1);
