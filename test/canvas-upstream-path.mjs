// 画布代理会不会把宿主地址里的子路径带上。
//
// 场景（作者复测用的就是它）：宿主挂在 http://127.0.0.1:PORT/review-prefix，
// 探活走带前缀的地址能通，但页面里的 /plugins/... 被投到根上 → 404。
//
// 跑法：node test/canvas-upstream-path.mjs
import http from "node:http";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "..", "sub", "canvas", "whalelife-workbench.cjs");

const ECHO_PORT = 9399;
const WB_PORT = 9388;

const seen = [];
const echo = http.createServer((req, res) => {
  seen.push({ url: req.url, method: req.method });
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, seen: req.url }));
});

const results = [];
const check = (label, ok, extra = "") => {
  results.push({ label, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
};

await new Promise((resolve) => echo.listen(ECHO_PORT, "127.0.0.1", resolve));

const child = spawn(
  process.execPath,
  [script, "--port", String(WB_PORT), "--upstream", String(ECHO_PORT), "--upstream-path", "/review-prefix",
    "--owner", "probe", "--parent-pid", "0"],
  { stdio: "ignore", env: { ...process.env, WORKBENCH_WATCH_PARENT: "0" } },
);

await new Promise((r) => setTimeout(r, 900));

async function get(p) {
  return fetch(`http://127.0.0.1:${WB_PORT}${p}`, { headers: { host: `127.0.0.1:${WB_PORT}` } });
}

try {
  await get("/plugins/thinking-space/flows");
  const flows = seen.at(-1);
  check("流程请求带上前缀", flows?.url === "/review-prefix/plugins/thinking-space/flows", flows?.url);

  await get("/api/status");
  const status = seen.at(-1);
  check("状态请求带上前缀", status?.url === "/review-prefix/api/status", status?.url);

  await get("/market/official-plugins");
  const market = seen.at(-1);
  check("市场请求带上前缀", market?.url === "/review-prefix/market/official-plugins", market?.url);
} finally {
  child.kill();
  echo.close();
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
