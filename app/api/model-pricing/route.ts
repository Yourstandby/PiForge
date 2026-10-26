import { NextResponse } from "../../../lib/next-server-shim.ts";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const dynamic = "force-dynamic";

/**
 * 模型计价币种表：{"provider/modelId": "USD" | "CNY"}
 *
 * pi 的 usage.cost.* 是纯数字，币种只存在于模型定义的 cost.currency 里。
 * 前端需要它来决定「人民币桶是否还要乘汇率」，否则按人民币报价的自定义
 * provider 会被重复换算。两个来源都要读：
 *   1. models.json        —— 用户自定义 provider 的显式配置
 *   2. models-store.json  —— pi 从上游同步的模型目录（内置 provider）
 * 没有声明 currency 的模型不出现在结果里，前端按 USD 兜底。
 */
function readJson(file: string): unknown {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch {
    return null;
  }
}

type CatalogProvider = {
  models?: Array<{ id?: string; cost?: { currency?: unknown } }>;
};

function collect(target: Record<string, "USD" | "CNY">, data: unknown): void {
  if (!data || typeof data !== "object") return;
  const root = data as { providers?: Record<string, CatalogProvider> } & Record<string, CatalogProvider>;
  const providers = root.providers && typeof root.providers === "object" ? root.providers : root;
  if (!providers || typeof providers !== "object") return;
  for (const [providerKey, provider] of Object.entries(providers)) {
    const models = provider?.models;
    if (!Array.isArray(models)) continue;
    for (const model of models) {
      const raw = model?.cost?.currency;
      if (typeof raw !== "string" || !raw.trim()) continue;
      const id = typeof model.id === "string" ? model.id.trim() : "";
      if (!id) continue;
      target[(providerKey + "/" + id).toLowerCase()] =
        raw.trim().toUpperCase() === "CNY" ? "CNY" : "USD";
    }
  }
}

export async function GET() {
  const agentDir = getAgentDir();
  const currencies: Record<string, "USD" | "CNY"> = {};
  collect(currencies, readJson(join(agentDir, "models.json")));
  collect(currencies, readJson(join(agentDir, "models-store.json")));
  return NextResponse.json({ currencies });
}
