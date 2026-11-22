/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 *
 * 技能壳 · 画布状态两次读：手搓的第一个壳，用来验「技能 → 子插件」这条路。
 *
 * 三条定死的规矩，不是偏好，是职责：
 * 1. 壳只存 SKILL_ID 和参数映射，运行的时候调真技能，不复制技能内容。
 *    复制成代码，技能一改壳就旧了，两份对不上时你不知道该信谁。
 * 2. 危险等级写死 ask。壳不能自己给自己降级——确认点在壳这一层，
 *    因为用户看到的是壳，不是里面那条技能。
 * 3. 卸载不自己删自己：Windows 下正在运行的目录删不动。只写墓碑标记，
 *    宿主下次启动、在子插件被扫到之前，由父插件清掉。
 *
 * 可以改的（设置页里）：开关、显示名、单次超时、要不要记调用。
 * 写死的（改代码才能动）：技能 id、工具名、危险等级、目录路径。
 */
import type { Context } from "whalelife";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** 展示用字段：日常版宿主认识 displayName，上游宿主没有。运行时原样传过去，
 *  不认识的宿主会忽略它，不影响工具本身。 */
declare module "whalelife" {
  interface ToolDefinition<Arguments = Record<string, unknown>, Result = unknown> {
    displayName?: string;
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const pagePath = "/plugins/thinking-space/skill-demo-canvas-twice/";
const actionPath = pagePath + "action";
const callsFile = join(here, "data", "calls.jsonl");
const flagFile = join(here, "data", "uninstall.flag");

/** 写死：技能 id。壳和技能靠它对齐，改了就不是同一条东西。 */
const SKILL_ID = "demo-canvas-twice";
/** 写死：工具名。宿主按名字记账，改名等于换了一个工具。 */
const TOOL_NAME = "skill_demo_canvas_twice";
/** 写死：危险等级。壳不能自己给自己降级。 */
const DANGER = "ask" as const;

const DEFAULTS = {
  /** 关掉就不注册工具，页面还能看和改。 */
  enabled: true,
  /** 工具在宿主里的显示名，随便改。 */
  displayName: "画布状态两次读",
  /** 单次执行上限，毫秒。超了只报「先停在这里」，不假装技能已经结束。 */
  timeoutMs: 90000,
  /** 记不记调用：只记时间、成败、耗时，不记参数（壳本来也没有参数）。 */
  recordCalls: false,
};
type Config = typeof DEFAULTS;

function escape(value: unknown) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function html(title: string, body: string) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title>
<style>
:root{--line:rgba(127,127,127,.28);--surface:rgba(127,127,127,.06)}
body{margin:0;padding:28px 22px 60px;font:15px/1.65 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;max-width:820px;margin:0 auto}
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
code{font-family:ui-monospace,Consolas,monospace;font-size:13px}
</style></head><body><h1>${escape(title)}</h1>${body}</body></html>`;
}

export async function apply(ctx: Context) {
  let cfg: Config = { ...DEFAULTS };
  try {
    const saved = await ctx.config.read<Partial<Config>>("config.json");
    const timeout = Math.floor(Number(saved?.timeoutMs));
    cfg = {
      enabled: saved?.enabled !== false,
      displayName: typeof saved?.displayName === "string" && saved.displayName.trim() ? saved.displayName.trim().slice(0, 40) : DEFAULTS.displayName,
      timeoutMs: Number.isInteger(timeout) && timeout >= 5000 && timeout <= 600000 ? timeout : DEFAULTS.timeoutMs,
      recordCalls: saved?.recordCalls === true,
    };
  } catch { /* 读不到就用默认 */ }

  /** 最近一次运行，只放内存；重启就没了，不当历史用。 */
  let last: { at: string; ok: boolean; took: number; status: string; note: string } | null = null;

  function record(ok: boolean, took: number, status: string, note: string) {
    last = { at: new Date().toISOString(), ok, took, status, note };
    if (!cfg.recordCalls) return;
    try {
      mkdirSync(dirname(callsFile), { recursive: true });
      appendFileSync(callsFile, JSON.stringify({ at: last.at, ok, took, status }) + "\n", "utf8");
    } catch { /* 记不上就算了，不影响这次运行 */ }
  }

  /** 调真技能。壳自己不理解步骤，也不重排——那是技能的事。 */
  async function runSkill(session: any) {
    const started = Date.now();
    let timer: any;
    const timeout = new Promise<never>((_, fail) => {
      timer = setTimeout(() => fail(new Error(`超过 ${cfg.timeoutMs} 毫秒还没回执，先停在这里；技能本身可能还在跑。`)), cfg.timeoutMs);
    });
    try {
      const raw: any = await Promise.race([
        ctx.tools.call("space_run", {
          id: SKILL_ID,
          params: {},
          // 壳是确认点：工具本身 danger=ask，用户点过之后这里才把副作用放行。
          confirmSideEffects: true,
          via: "self",
        }, {
          permission: "ask",
          signal: session?.signal,
          origin: { plugin: "thinking-space/skill-demo-canvas-twice", action: "run" },
        } as any),
        timeout,
      ]);
      const took = Date.now() - started;
      if (!raw || raw.ok !== true) {
        const reason = typeof raw?.result === "string" ? raw.result : "没拿到回执。";
        record(false, took, "failed", reason);
        return { status: "failed", skill: SKILL_ID, note: reason };
      }
      const result: any = raw.result && typeof raw.result === "object" && "status" in raw.result ? raw.result : { status: "ok", raw: raw.result };
      const note = result.status === "ok" ? "跑完了。" : String(result.error ?? "没跑成。");
      record(result.status === "ok", took, String(result.status ?? "ok"), note);
      return { status: String(result.status ?? "ok"), skill: SKILL_ID, runId: result.runId ?? null, steps: Array.isArray(result.steps) ? result.steps.length : 0, note, took };
    } catch (error) {
      const took = Date.now() - started;
      const message = error instanceof Error ? error.message : String(error);
      record(false, took, "failed", message);
      return { status: "failed", skill: SKILL_ID, note: message };
    } finally {
      clearTimeout(timer);
    }
  }

  if (cfg.enabled) {
    ctx.tools.register({
      name: TOOL_NAME,
      displayName: cfg.displayName,
      danger: DANGER,
      description: `跑思维空间技能「${SKILL_ID}」：先读一次画布状态，再停一次画布。` +
        `壳只是转发，步骤和参数以技能本身为准。要确认的东西在壳这一层，因为看到的是壳。`,
      schema: { type: "object", properties: {}, additionalProperties: false },
      async run(_args: unknown, session: any) {
        return await runSkill(session);
      },
    });

    // 卸载：只登记，不当场删。正在跑的目录 Windows 删不掉，硬删会留半份残骸。
    ctx.tools.register({
      name: TOOL_NAME + "_uninstall",
      displayName: "卸载这个技能壳",
      danger: "full",
      description: "给这个手搓的技能壳登记卸载：写一个墓碑标记，宿主下次启动时由思维空间删掉目录。" +
        "不会当场删，因为正在运行的目录删不掉；重启前这个壳还会照常加载。",
      schema: { type: "object", properties: { reason: { type: "string", description: "为什么卸，留个记录。" } }, additionalProperties: false },
      async run(args: any) {
        try {
          mkdirSync(dirname(flagFile), { recursive: true });
          writeFileSync(flagFile, JSON.stringify({ at: new Date().toISOString(), reason: String(args?.reason ?? "").slice(0, 200) }, null, 2), "utf8");
        } catch (error) {
          return { status: "failed", note: "墓碑写不进去：" + (error instanceof Error ? error.message : String(error)) };
        }
        return { status: "pending", at: flagFile, note: "已登记卸载。宿主重启后由思维空间清掉目录，在那之前这个壳还会加载。" };
      },
    });
  }

  function panel() {
    const running = last;
    return html("技能壳 · 画布状态两次读", `
<section class="panel">
  <h2>状态</h2>
  <p>
    <span class="badge${cfg.enabled ? "" : " warn"}">${cfg.enabled ? "工具已注册" : "已关掉，工具不注册"}</span>
    <span class="badge">技能 ${escape(SKILL_ID)}</span>
    <span class="badge">工具 ${escape(TOOL_NAME)}</span>
    <span class="badge">危险 ${DANGER}</span>
  </p>
  <p class="muted">${running ? `上次运行：${escape(running.at)} · ${escape(running.status)} · ${running.took} 毫秒 · ${escape(running.note)}` : "这个宿主起来之后还没跑过。"}</p>
  <p class="muted">壳里没有技能内容。步骤、参数都以技能本身为准，技能一改，壳跟着变。</p>
  <p class="muted">${existsSync(flagFile) ? "⚠ 已经写过卸载墓碑：宿主下次启动会删掉这个目录。" : ""}</p>
</section>
<section class="panel">
  <h2>可以改的</h2>
  <form method="post" action="${actionPath}">
    <label class="check"><input type="checkbox" name="enabled"${cfg.enabled ? " checked" : ""}><span>注册这个工具（关掉以后壳还在，但工具不出现在工具表里）</span></label>

    <div class="field">显示名</div>
    <input type="text" name="displayName" maxlength="40" value="${escape(cfg.displayName)}">
    <p class="muted" style="margin-top:6px">工具在宿主里叫什么。只影响显示，不影响行为。</p>

    <div class="field">单次超时（毫秒）</div>
    <input type="number" name="timeoutMs" min="5000" max="600000" step="1000" value="${cfg.timeoutMs}">
    <p class="muted" style="margin-top:6px">默认 90000。超了只报「先停在这里」，不会假装技能已经结束。</p>

    <label class="check" style="margin-top:18px"><input type="checkbox" name="recordCalls"${cfg.recordCalls ? " checked" : ""}><span>记调用（时间、成败、耗时，不记参数）</span></label>

    <p style="margin-top:16px"><button class="primary" type="submit">保存设置</button></p>
  </form>
</section>
<section class="panel">
  <h2>写死的</h2>
  <p class="muted" style="margin:0">技能 id、工具名、危险等级、目录路径。这四样改代码才能动——
  壳能改自己的显示，不能改自己的权限。</p>
</section>`);
  }

  ctx.web.page(pagePath, async (req: any, res: any) => {
    try {
      const note = String(new URL(req.url ?? "/", "http://local").searchParams.get("note") ?? "");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(note ? panel().replace("<h1>", `<p class="notice">${escape(note)}</p><h1>`) : panel());
    } catch (error) {
      res.writeHead(503, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(html("技能壳", `<p>暂时读不到状态：${escape(error instanceof Error ? error.message : "")}</p>`));
    }
  }, { title: "技能壳·画布状态两次读", settings: true });

  ctx.web.api(actionPath, async (req: any, res: any) => {
    let note = "";
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      const rawTimeout = Math.floor(Number(form.get("timeoutMs")));
      cfg = {
        enabled: form.get("enabled") === "on",
        displayName: String(form.get("displayName") ?? "").trim().slice(0, 40) || DEFAULTS.displayName,
        timeoutMs: Number.isInteger(rawTimeout) && rawTimeout >= 5000 && rawTimeout <= 600000 ? rawTimeout : cfg.timeoutMs,
        recordCalls: form.get("recordCalls") === "on",
      };
      await ctx.config.save("config.json", cfg);
      // 开关和显示名要重启插件才生效：工具已经注册出去，运行中改名会跟工具表对不上。
      note = "存下了。开关和显示名要重载这个子插件才生效，超时和记调用立刻生效。";
    } catch (error) {
      note = "没存成：" + (error instanceof Error ? error.message : String(error));
    }
    res.writeHead(303, { Location: pagePath + "?note=" + encodeURIComponent(note) });
    res.end();
  });

  ctx.logger.info(`技能壳 ${SKILL_ID}：${cfg.enabled ? "注册" : "未注册"}工具 ${TOOL_NAME}，超时 ${cfg.timeoutMs} 毫秒`);
}
