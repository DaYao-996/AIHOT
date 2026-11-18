// A stable local listing. Item addresses do not change between rounds.
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { parseHTML } from "linkedom";

export interface DailyPaths {
  listen: string;
  listingState: string;
  samples: Record<string, string>;
}

const TITLES: Record<string, { title: string; time: string }> = {
  a: { title: "Co-Designing Sparse Attention for Efficient Long-Context Inference", time: "2026-11-17T17:30:00.000Z" },
  b: { title: "Integrating QPUs into Supercomputing Centers Using Slurm HRES Plugins", time: "2026-11-17T17:00:00.000Z" },
  c: { title: "Apple 播客年度节目", time: "2026-11-17T08:00:00.000Z" },
  denied: { title: "拒绝的页面", time: "2026-11-17T09:00:00.000Z" },
};

function listing(base: string, statePath: string): string {
  const state = JSON.parse(readFileSync(statePath, "utf8")) as { items?: string[]; denied?: boolean };
  const keys = [...(state.items ?? [])];
  if (state.denied) keys.push("denied");
  return keys.map((key) => {
    const meta = TITLES[key] ?? { title: key, time: "2026-11-17T00:00:00.000Z" };
    return `<article><a href="${base}/items/${key}">${meta.title}</a><time datetime="${meta.time}"></time></article>`;
  }).join("");
}

function page(file: string, extend: boolean): Buffer {
  if (!extend) return readFileSync(file);
  const html = readFileSync(file).toString("utf8");
  const { document } = parseHTML(html);
  const entry = document.querySelector(".entry-content") ?? document.querySelector("article") ?? document.body;
  const p = document.createElement("p");
  p.textContent = "补充段落用于正文修订。";
  entry?.appendChild(p);
  return Buffer.from(document.toString());
}

export function serveDaily(config: DailyPaths): Promise<void> {
  const [host, portText] = config.listen.split(":");
  const port = Number(portText);
  if (!host || !Number.isInteger(port)) throw new Error("listen 必须是 主机:端口");
  const base = `http://${host}:${port}`;
  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0]!;
    const state = existsSync(config.listingState) ? JSON.parse(readFileSync(config.listingState, "utf8")) as { hold?: string[]; extend?: string[] } : {};
    if (path === "/listing") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(listing(base, config.listingState));
      return;
    }
    const key = path.startsWith("/items/") ? path.slice("/items/".length) : "";
    if (key === "denied") {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      res.end("refused");
      return;
    }
    if (state.hold?.includes(key)) return;
    const file = config.samples[key];
    if (!file || !existsSync(file)) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(page(file, state.extend?.includes(key) === true));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      console.log(JSON.stringify({ serving: base }));
      resolve();
    });
  });
}
