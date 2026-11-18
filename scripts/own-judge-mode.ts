// File judgments and model calls are different paths. This entry never writes a model receipt.

export function assertFileJudgmentPath(): void {
  if (process.env.MODEL_CALLS_ENABLED === "true") {
    throw new Error("文件判断入口不允许同时打开模型调用");
  }
}

/** Names the missing switch or variables. Null means a model address is present; this entry still does not call it. */
export function modelConfigurationGap(): string | null {
  const missing = [
    process.env.MODEL_CALLS_ENABLED === "true" ? "" : "MODEL_CALLS_ENABLED",
    process.env.LLM_BASE_URL ? "" : "LLM_BASE_URL",
    process.env.LLM_API_KEY ? "" : "LLM_API_KEY",
    process.env.LLM_MODEL ? "" : "LLM_MODEL",
  ].filter(Boolean);
  return missing.length ? missing.join(", ") : null;
}

export function modelCall(): never {
  const missing = modelConfigurationGap();
  if (missing) {
    throw new Error(`模型未配置，缺少 ${missing}。没有发出请求，没有回执。文件判断用 --step file 和 --step once，不走这里。`);
  }
  throw new Error("模型地址和开关都在，这一入口仍然不调用模型，也不写回执。");
}
