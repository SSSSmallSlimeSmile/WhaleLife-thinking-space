// 画布的 HTTP 转发使用保存的完整宿主地址，并保留旧的端口和子路径参数。
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../sub/canvas/whalelife-workbench.cjs", import.meta.url));
const routes = ["/plugins/thinking-space/flows", "/api/status", "/market/official-plugins"];

async function listen(host, handler) {
  const server = http.createServer(handler);
  server.listen(0, host);
  await once(server, "listening");
  return server;
}

async function checkForwarding(host, legacy) {
  const echo = await listen(host, (req, res) => {
    res.end(JSON.stringify({ url: req.url, host: req.headers.host, origin: req.headers.origin }));
  });
  const reservation = await listen("127.0.0.1");
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const upstreamPort = echo.address().port;
  const authority = `${host === "::1" ? "[::1]" : host}:${upstreamPort}`;
  const origin = `http://${authority}`;
  const upstreamArgs = legacy ? ["--upstream", String(upstreamPort)] : ["--upstream-url", origin + "/review-prefix"];
  const child = spawn(process.execPath, [
    script, "--port", String(port), ...upstreamArgs,
    "--upstream-path", "/review-prefix", "--owner", "probe", "--parent-pid", "0",
  ], { stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, WORKBENCH_WATCH_PARENT: "0" } });
  const closed = once(child, "close");
  try {
    const startup = await Promise.race([once(child.stdout, "data"), closed]);
    assert.match(String(startup[0]), /http:\/\/127\.0\.0\.1:/);
    for (const route of routes) {
      const response = await fetch(`http://127.0.0.1:${port}${route}`, { signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { url: "/review-prefix" + route, host: authority, origin });
    }
    console.log(`PASS  ${legacy ? "旧端口参数" : origin} · ${routes.length} 条路径`);
  } finally {
    child.kill();
    await Promise.all([closed, new Promise((resolve) => echo.close(resolve))]);
  }
}

await checkForwarding("127.0.0.1", true);
await checkForwarding("127.0.0.1", false);
await checkForwarding("::1", false);
