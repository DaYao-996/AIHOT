// File judgments and model calls are different paths. This entry never writes a model receipt.

export function assertFileJudgmentPath(): void {
  if (process.env.MODEL_CALLS_ENABLED === "true") {
    throw new Error("文件判断入口不允许同时打开模型调用");
  }
}

export function modelCall(): never {
  throw new Error("模型调用与文件判断分开。这一入口不调用模型，也不写回执。");
}
