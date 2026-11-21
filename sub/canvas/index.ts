/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 *
 * 思维画布：从思维空间里拆出来的子插件。
 *
 * 三件事想清楚才这么写：
 * 1. 画布是独立的 node 进程，端口和脚本都由自己管，不再塞进父插件的设置页。
 * 2. 画布进程「跟着思维空间走」：父插件一停，宿主会先把子插件停掉，这里的
 *    effect 清理负责把进程一起收掉。不要这个行为，就在设置页把开关关掉。
 * 3. 画布要连的是「这个宿主」，不是脚本里默认的 9270：端口从宿主
 *    config/config.json 的 web.port 读，读不到才退回脚本默认值。
 */
import type { Context } from "whalelife";
import { execFile, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
const pagePath = "/plugins/thinking-space/canvas/";
const actionPath = "/plugins/thinking-space/canvas/action";
const settingsPath = "/plugins/thinking-space/canvas/settings";
const scriptName = "whalelife-workbench.cjs";

const DEFAULTS = {
  /** 画布自己监听的端口。宿主端口不能和它一样。 */
  port: 9281,
  /** 空着就用插件目录里那份脚本。 */
  canvasScript: "",
  /** 思维空间停掉时，画布进程一起收掉。默认开。 */
  stopWithSpace: true,
};
type Config = typeof DEFAULTS;

function escape(value: unknown) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function html(title: string, body: string) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title>
<style>
:root{--line:rgba(127,127,127,.28);--surface:rgba(127,127,127,.06);--ink:inherit}
body{margin:0;padding:28px 22px 60px;font:15px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;max-width:860px;margin:0 auto}
h1{font-size:19px;margin:0 0 18px}
.panel{border:1px solid var(--line);border-radius:14px;padding:18px 20px;margin:0 0 14px;background:var(--surface)}
.panel>h2{margin:0 0 12px;padding-bottom:10px;font-size:15px;font-weight:700;border-bottom:1px solid var(--line)}
.badge{display:inline-block;margin-right:8px;padding:2px 10px;border:1px solid var(--line);border-radius:999px;font-size:12px}
.badge.warn{border-color:#c98;color:#a63}
.muted{opacity:.7;font-size:13px}
.field{font-weight:600;font-size:14px;margin:16px 0 6px}
input[type=text],input[type=number]{width:100%;max-width:420px;padding:9px 11px;border:1px solid var(--line);border-radius:9px;background:transparent;color:inherit;font:inherit}
.check{display:flex;gap:8px;align-items:flex-start;margin:12px 0;font-size:14px}
button{padding:9px 18px;border-radius:9px;border:1px solid var(--line);background:transparent;color:inherit;font:inherit;font-weight:600;cursor:pointer}
button.primary{border-color:#4a8;color:#2a7}
.notice{padding:10px 12px;border:1px solid var(--line);border-radius:10px;margin:0 0 14px;font-size:14px}
.open-canvas{display:inline-flex;align-items:center;gap:6px;margin-left:10px;padding:10px 22px;border-radius:10px;background:#6158d9;color:#fff!important;text-decoration:none;font-weight:700;font-size:17px;letter-spacing:.02em;box-shadow:0 4px 14px rgba(97,88,217,.28)}
.open-canvas:hover{background:#4d45bd}
a{color:inherit}
</style></head><body><h1>${escape(title)}</h1>${body}</body></html>`;
}

function decodeOutput(raw: string): string {
  // PowerShell 5.1 往管道里写的是控制台代码页（中文机器是 GBK）。整段能严格解成
  // UTF-8 就说明是 UTF-8；解不成再按 GBK 回退。
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(raw, "utf8"));
    return text;
  } catch {
    try { return new TextDecoder("gbk").decode(Buffer.from(raw, "utf8")); } catch { return raw; }
  }
}

export async function apply(ctx: Context) {
  let cfg: Config = { ...DEFAULTS };
  const load = async () => {
    try {
      const saved = await ctx.config.read<Partial<Config>>("config.json");
      const port = Math.floor(Number(saved?.port));
      const script = typeof saved?.canvasScript === "string" ? saved.canvasScript.trim() : "";
      cfg = {
        port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : DEFAULTS.port,
        canvasScript: script,
        stopWithSpace: saved?.stopWithSpace !== false,
      };
    } catch { /* 读不到就用默认 */ }
  };
  await load();

  let canvasError: string | undefined;
  /** 这个实例亲手拉起来的画布，宿主退出时按它收。 */
  let canvasHostPid: number | null = null;

  // 脚本落成临时 .ps1 再 -File 执行：双引号里的 $ 不会被外层命令行先展开。
  function ps(script: string): Promise<{ code: number; out: string; err: string }> {
    const file = join(tmpdir(), `canvas-${randomUUID().slice(0, 12)}.ps1`);
    const body = "\uFEFF" + "$OutputEncoding=[Console]::OutputEncoding=[Text.Encoding]::UTF8\n" + script + "\n";
    try { writeFileSync(file, body, "utf8"); } catch (error) {
      return Promise.resolve({ code: 1, out: "", err: `写临时脚本失败：${error instanceof Error ? error.message : ""}` });
    }
    return new Promise((done) => {
      execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file],
        { windowsHide: true, timeout: 20000 },
        (error, stdout, stderr) => {
          try { unlinkSync(file); } catch { /* 临时文件删不掉不算失败 */ }
          const raw = (error as { code?: unknown } | null)?.code;
          const code = error ? (typeof raw === "number" ? raw : 1) : 0;
          done({ code, out: decodeOutput(String(stdout ?? "")), err: decodeOutput(String(stderr ?? "")) });
        });
    });
  }

  async function canvasPid(): Promise<number | null> {
    const result = await ps(`(Get-NetTCPConnection -LocalPort ${cfg.port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`);
    const pid = Number(result.out.trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  }
  async function cmdlineOf(pid: number): Promise<string> {
    const result = await ps(`(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue).CommandLine`);
    return result.out.trim();
  }

  /** 读宿主自己的端口：config/config.json 里的 web.port 才是准的。 */
  function locateUpstream(port: number): { root: string; port: number } | null {
    const argRoots = process.argv
      .filter((item) => /^[A-Za-z]:[\\/]/.test(item) && !/\.[A-Za-z0-9]{1,6}$/.test(item))
      .map((item) => resolve(item));
    const bases = [...argRoots, process.cwd(), resolve(process.cwd(), ".."), resolve(process.cwd(), "..", "..")];
    for (const base of bases) {
      const configFile = join(base, "config", "config.json");
      if (!existsSync(configFile)) continue;
      try {
        const raw = JSON.parse(readFileSync(configFile, "utf8"));
        const found = Math.floor(Number(raw?.web?.port));
        if (Number.isInteger(found) && found > 0 && found <= 65535 && found !== port) return { root: base, port: found };
      } catch { /* 读不动就换下一个候选 */ }
    }
    return null;
  }

  function locateScript(): string {
    if (cfg.canvasScript) return cfg.canvasScript;
    const beside = join(here, scriptName);
    if (existsSync(beside)) return beside;
    const inCanvas = join(here, "canvas", scriptName);
    if (existsSync(inCanvas)) return inCanvas;
    return "";
  }

  async function state() {
    const pid = await canvasPid();
    const upstream = locateUpstream(cfg.port);
    return {
      running: !!pid,
      pid,
      port: cfg.port,
      upstreamPort: upstream?.port ?? null,
      script: locateScript(),
      stopWithSpace: cfg.stopWithSpace,
      error: canvasError ?? null,
    };
  }

  async function start(): Promise<string> {
    const running = await canvasPid();
    if (running) { canvasHostPid = running; canvasError = undefined; return `画布已经在跑了（PID ${running}，端口 ${cfg.port}）。`; }
    const script = locateScript();
    if (!script) { canvasError = "找不到画布脚本：插件目录里没有 " + scriptName + "，也没在设置里指定路径。"; return canvasError; }
    if (!existsSync(script)) { canvasError = `找不到脚本：${script}`; return canvasError; }
    const upstream = locateUpstream(cfg.port);
    if (!upstream) { canvasError = "读不到宿主端口：没找到带 web.port 的 config/config.json。画布不起来，免得连到别的实例上。"; return canvasError; }
    try {
      const child = spawn(process.execPath, [script, "--port", String(cfg.port), "--upstream", String(upstream.port)],
        { cwd: dirname(script), detached: true, stdio: "ignore", windowsHide: true });
      child.unref();
      canvasHostPid = child.pid ?? null;
      const owner = canvasHostPid;
      child.once("exit", () => { if (canvasHostPid === owner) canvasHostPid = null; });
    } catch (error) {
      canvasError = `拉不起来：${error instanceof Error ? error.message : ""}`;
      return canvasError;
    }
    for (let i = 0; i < 24; i += 1) {
      await new Promise((done) => setTimeout(done, 250));
      const pid = await canvasPid();
      if (pid) { canvasError = undefined; return `画布起来了（PID ${pid}，端口 ${cfg.port}，连宿主 ${upstream.port}）。`; }
    }
    canvasError = "脚本已经拉起，但 6 秒内没等到端口，去看一下脚本自己有没有报错。";
    return canvasError;
  }

  async function stop(): Promise<string> {
    const pid = await canvasPid();
    if (!pid) { canvasError = undefined; return "本来就没在跑。"; }
    if (canvasHostPid !== pid) {
      const cmd = await cmdlineOf(pid);
      if (!cmd || !new RegExp(scriptName.replace(/\./g, "\\."), "i").test(cmd)) {
        canvasError = `端口 ${cfg.port} 上的进程（PID ${pid}）看起来不是画布脚本，没有动它。命令行：${cmd || "（读不到）"}`;
        return canvasError;
      }
    }
    await ps(`taskkill /PID ${pid} /F | Out-Null`);
    if (await canvasPid()) { canvasError = `停不下来（PID ${pid}）。`; return canvasError; }
    canvasHostPid = null;
    canvasError = undefined;
    return `画布已停（PID ${pid}）。`;
  }

  // 跟着思维空间走：父插件停 → 宿主先停子插件 → 这里把画布进程一起收掉。
  // 用同步 taskkill：插件 stop 只等一眼，异步 PowerShell 来不及。
  ctx.effect(() => () => {
    if (!cfg.stopWithSpace) return;
    const pid = canvasHostPid;
    if (!pid) return;
    try { spawnSync("taskkill", ["/PID", String(pid), "/F"], { windowsHide: true, stdio: "ignore" }); }
    catch { /* 已经退了就算了 */ }
    canvasHostPid = null;
  });

  ctx.tools.register({
    name: "canvas_status", displayName: "看画布状态", danger: "safe",
    description: "查思维画布在不在跑：端口、PID、连的是哪个宿主端口、脚本路径、是否随思维空间一起停。只读。",
    schema: { type: "object", properties: {}, additionalProperties: false },
    async run() { return { status: "ok", ...(await state()) }; },
  });

  ctx.tools.register({
    name: "canvas_start", displayName: "启动画布", danger: "ask",
    description: "拉起思维画布的 node 进程：端口取插件设置，上游端口取宿主 config/config.json 的 web.port，因为脚本已拉起但端口没通而失败时说明原因。",
    schema: { type: "object", properties: {}, additionalProperties: false },
    async run() { const note = await start(); return { status: canvasError ? "failed" : "ok", note, ...(await state()) }; },
  });

  ctx.tools.register({
    name: "canvas_stop", displayName: "停止画布", danger: "ask",
    description: "停掉端口上的画布进程。命令行看起来不是画布脚本时拒绝，不误杀本地别的服务。",
    schema: { type: "object", properties: {}, additionalProperties: false },
    async run() { const note = await stop(); return { status: canvasError ? "failed" : "ok", note, ...(await state()) }; },
  });

  function panel(current: Awaited<ReturnType<typeof state>>, note: string) {
    return html("思维画布", `${note ? `<p class="notice">${escape(note)}</p>` : ""}
<section class="panel">
  <h2>状态</h2>
  <p><span class="badge${current.running ? "" : " warn"}">${current.running ? `运行中 · PID ${current.pid}` : "没在跑"}</span><span class="badge">端口 ${current.port}</span><span class="badge">连宿主 ${current.upstreamPort ?? "没读到"}</span></p>
  <p class="muted">画布是独立的 node 脚本，开机不会自己起来。要用的时候点启动，不用了点停止。${current.error ? `上次出错：${escape(current.error)}` : ""}</p>
  <p class="muted">脚本：<code>${escape(current.script || "（没找到）")}</code></p>
  <p>
    <form method="post" action="${actionPath}" style="display:inline-flex;margin:0"><input type="hidden" name="action" value="start"><button class="primary" type="submit">启动画布</button></form>
    <form method="post" action="${actionPath}" style="display:inline-flex;margin:0 0 0 10px"><input type="hidden" name="action" value="stop"><button type="submit">停止</button></form>
    ${current.running ? `<a class="open-canvas" href="http://127.0.0.1:${current.port}/" target="_blank" rel="noopener">前往画布 →</a>` : ""}
  </p>
</section>
<section class="panel">
  <h2>设置</h2>
  <form method="post" action="${settingsPath}">
    <div class="field">画布端口</div>
    <input type="number" name="port" min="1024" max="65535" value="${current.port}">
    <p class="muted" style="margin-top:6px">默认 9281。不能和宿主端口相同，改完要重启画布才生效。</p>

    <div class="field">画布脚本路径</div>
    <input type="text" name="canvasScript" value="${escape(cfg.canvasScript)}">
    <p class="muted" style="margin-top:6px">留空就用插件目录里的 ${scriptName}。只有想换成别处的副本时才填。</p>

    <label class="check" style="margin-top:18px"><input type="checkbox" name="stopWithSpace"${current.stopWithSpace ? " checked" : ""}><span>思维空间停掉时，画布一起收掉</span></label>
    <p class="muted">默认勾。勾着时停用思维空间会顺手停掉画布进程；不勾就各停各的，画布会一直挂到宿主退出或你手动停。</p>

    <p style="margin-top:16px"><button class="primary" type="submit">保存设置</button></p>
  </form>
</section>`);
  }

  ctx.web.page(pagePath, async (req: any, res: any) => {
    try {
      const note = String(new URL(req.url ?? "/", "http://local").searchParams.get("note") ?? "");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(panel(await state(), note));
    } catch (error) {
      res.writeHead(503, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(html("思维画布", `<p>暂时读不到画布状态：${escape(error instanceof Error ? error.message : "")}</p>`));
    }
  }, { title: "思维画布", settings: true });

  ctx.web.api(actionPath, async (req: any, res: any) => {
    let note = "";
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks).toString("utf8");
      const form = new URLSearchParams(raw);
      note = form.get("action") === "stop" ? await stop() : await start();
    } catch (error) {
      note = `没做成：${error instanceof Error ? error.message : ""}`;
    }
    res.writeHead(303, { Location: pagePath + "?note=" + encodeURIComponent(note) });
    res.end();
  });

  ctx.web.api(settingsPath, async (req: any, res: any) => {
    let note = "";
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      const rawPort = Math.floor(Number(form.get("port")));
      const nextPort = Number.isInteger(rawPort) && rawPort >= 1024 && rawPort <= 65535 ? rawPort : cfg.port;
      const script = String(form.get("canvasScript") ?? "").trim().slice(0, 500);
      const stopWithSpace = form.get("stopWithSpace") === "on";
      cfg = { port: nextPort, canvasScript: script, stopWithSpace };
      await ctx.config.save("config.json", cfg);
      note = "设置存下了。端口改动要重启画布才生效。";
    } catch (error) {
      note = `没存成：${error instanceof Error ? error.message : ""}`;
    }
    res.writeHead(303, { Location: pagePath + "?note=" + encodeURIComponent(note) });
    res.end();
  });

  ctx.logger.info(`思维画布：端口 ${cfg.port}，随思维空间停止 ${cfg.stopWithSpace ? "开" : "关"}`);
}
