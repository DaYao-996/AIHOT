// Serves saved listing bytes on localhost. Does not fetch anything itself.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";

const root = process.argv[2];
const port = Number(process.argv[3] ?? "8765");
if (!root) throw new Error("需要目录");
const server = createServer((req, res) => {
  const name = decodeURIComponent((req.url ?? "/").split("?")[0] ?? "/").replace(/^\//, "");
  try {
    const body = readFileSync(`${root}/${name}`);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
server.listen(port, "127.0.0.1", () => {
  console.log(`replay ${port}`);
});
