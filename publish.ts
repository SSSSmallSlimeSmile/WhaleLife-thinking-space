/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 *
 * 技能 → 子插件（技能壳）的发布与回退。
 *
 * 三件事分开做，不混在一起：
 *   1. 保存技能 = 写 skills.json，不生成任何文件，不重载。这条路在 index.ts 里。
 *   2. 发布 = 生成 sub/<subId>/ 两个文件、把 id 加进父清单 sub:、留备份，然后**等重载**。
 *   3. 回退 = 把备份铺回去、清单复原。第一次发布失败就是撤掉新增的文件和登记。
 *
 * 为什么发布之后要等外面来重载：插件没有重载插件的权限（宿主不向插件暴露
 * runtime.action），能重载的只有两处——宿主启动，或者浏览器带着会话 cookie 调
 * POST /api/plugin。所以这里只做文件，重载和验收由页面上的按钮串起来跑。
 *
 * 生成的东西不是任意代码，是「固定模板 + 三个常量」。所以发布前的检查不是
 * 「编译一遍」，是查模板变量有没有漏、清单能不能解析、目录和工具名有没有撞车。
 * 这一点在交付里写清楚了，没验的就是没验。
 */
import type { Context } from "whalelife";
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type PublishSkill = {
  id: string;
  name: string;
  description?: string;
  kind: string;
  danger: string;
  /** 发布那一刻技能是第几版。壳里写死这个数，运行时用来对「技能改没改过」。 */
  revision?: number;
  steps: { id: string; tool: string; plugin: string }[];
};

export type PublishHooks = {
  /** 父插件目录。 */
  here: string;
  /** 父插件运行时 id。 */
  parentId: string;
  readSkills: () => Promise<PublishSkill[]>;
  /** 当前宿主里的工具名集合，用来查撞车。 */
  toolNames: () => Promise<{ name: string; plugin?: string }[]>;
  readBody: (req: any, limit?: number) => Promise<string>;
  escape: (value: unknown) => string;
  html: (title: string, body: string) => string;
};

type Stage = "staged" | "written" | "verified" | "failed" | "rolled-back" | "withdrawn";

type PublishRecord = {
  subId: string;
  skillId: string;
  toolName: string;
  displayName: string;
  version: string;
  danger: string;
  fingerprint: string;
  /** 发布时技能的 revision，页面上拿来比对技能改没改过。 */
  skillRevision?: number;
  stage: Stage;
  at: string;
  /** 上一版整目录的备份，相对 data/publish-backups/；首次发布为 null。 */
  backup: string | null;
  /** 本版发布时被替换掉的版本号，回退时退回去；首次发布为 null。 */
  replacedVersion?: string | null;
  /** 父清单的备份目录（同一个 stamp 目录）。 */
  manifestBackup: string;
  /** 这一版是哪一次发布写下去的，前端拿它对账，避免旧页面回退别的轮次。 */
  publishId?: string;
  reason?: string;
  history: { at: string; action: string; note?: string }[];
};

type PublishFile = { schemaVersion: 1; items: PublishRecord[] };

/**
 * 发布作业。放在改正式目录之前落盘：宿主半路退出时，靠它认回「该退到哪一版」。
 * 没有它，旧目录已经删掉、登记还没写，重启时就不知道备份是给谁的。
 */
type JobPhase = "preparing" | "written";
type PendingJob = {
  publishId: string;
  subId: string;
  skillId: string;
  version: string;
  /** 首次发布：没有旧目录可退，只能撤回。 */
  first: boolean;
  /** 旧目录备份目录名，相对 data/publish-backups/；首次发布为 null。 */
  backup: string | null;
  manifestBackup: string;
  phase: JobPhase;
  at: string;
  note?: string;
};
type PendingFile = { schemaVersion: 1; jobs: PendingJob[] };

const SUB_PREFIX = "skill-";
/** 模板版本。模板改了就把这个加一，否则同一个技能会因为「指纹没变」被判定成复用。 */
const TEMPLATE_VERSION = 3;
const MAX_SUB_ID = 40;

/** 技能 id → 子插件目录名。只留小写字母、数字、连字符，稳定不随版本变。 */
export function subIdFor(skillId: string): string {
  const body = skillId
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  const trimmed = (SUB_PREFIX + body).slice(0, MAX_SUB_ID).replace(/-$/, "");
  return trimmed === SUB_PREFIX ? SUB_PREFIX + "unnamed" : trimmed;
}

/** 子插件 id → 工具名。宿主按名字记账，所以只能是小写字母数字下划线。 */
export function toolNameFor(subId: string): string {
  const name = subId.replace(/-/g, "_");
  return /^[a-z]/.test(name) ? name.slice(0, 60) : "t_" + name.slice(0, 58);
}

function stamp() {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    String(now.getFullYear()) + pad(now.getMonth() + 1) + pad(now.getDate()) + "-" +
    pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds()) + "-" +
    Math.random().toString(16).slice(2, 6)
  );
}

/** 固定模板。占位符用 __X__，避免和代码里的 ${} 混。 */
const SHELL = `/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 *
 * 技能壳 · 由思维空间按「__SKILL_NAME__」生成，别手改；技能改了请重新发布。
 *
 * 三条定死的规矩，不是偏好，是职责：
 * 1. 壳只存技能 id 和参数映射，运行时调真技能，不复制技能内容。
 *    复制成代码，技能一改壳就旧了，两份对不上时你不知道该信谁。
 * 2. 危险等级写死 ask。壳不能自己给自己降级——确认点在这一层，
 *    因为用户看到的是壳，不是里面那条技能。
 * 3. 卸载不自己删自己：Windows 下正在运行的目录删不动。只写墓碑，
 *    宿主下次启动、在子插件被扫到之前，由父插件清掉。
 */
import type { Context } from "whalelife";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

declare module "whalelife" {
  interface ToolDefinition<Arguments = Record<string, unknown>, Result = unknown> {
    displayName?: string;
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const pagePath = "/plugins/thinking-space/__SUB_ID__/";
const actionPath = pagePath + "action";
const callsFile = join(here, "data", "calls.jsonl");
const flagFile = join(here, "data", "uninstall.flag");

/** 写死：技能 id。壳和技能靠它对齐，改了就不是同一条东西。 */
const SKILL_ID = __SKILL_ID__;
/** 写死：工具名。宿主按名字记账，改名等于换了一个工具。 */
const TOOL_NAME = __TOOL_NAME__;
/** 壳自身的版本，重新发布时跟着变，用来辨认跑的是哪一版。 */
const SHELL_VERSION = __VERSION__;
/** 发布时技能是第几版。运行时拿它和技能现在的 rev 对一下，对不上也照跑，但会说明。 */
const SKILL_REVISION = __SKILL_REVISION__;
/** 写死：危险等级。壳不能自己给自己降级。 */
const DANGER = "ask" as const;

const DEFAULTS = {
  enabled: true,
  displayName: __DISPLAY_NAME__,
  timeoutMs: 90000,
  recordCalls: false,
};
type Config = typeof DEFAULTS;

function escape(value: unknown) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function html(title: string, body: string) {
  return \`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>\${escape(title)}</title>
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
</style></head><body><h1>\${escape(title)}</h1>\${body}</body></html>\`;
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

  let last: { at: string; ok: boolean; took: number; status: string; note: string } | null = null;

  function record(ok: boolean, took: number, status: string, note: string) {
    last = { at: new Date().toISOString(), ok, took, status, note };
    if (!cfg.recordCalls) return;
    try {
      mkdirSync(dirname(callsFile), { recursive: true });
      appendFileSync(callsFile, JSON.stringify({ at: last.at, ok, took, status }) + "\\n", "utf8");
    } catch { /* 记不上就算了 */ }
  }

  /**
   * 技能还在不在、是不是发布时那一版。只读，不执行技能。
   * 读不到就当没发现问题，交给 space_run 自己报错——这里不该替它下结论。
   */
  async function lookUpSkill(session: any): Promise<{ state: "ok" | "missing" | "changed"; revision: number | null }> {
    try {
      const raw: any = await (ctx.tools as any).call("space_skills", {}, { permission: "full", signal: session?.signal });
      const body = raw && raw.ok === true ? raw.result : null;
      const list = Array.isArray(body?.skills) ? body.skills : null;
      if (!list) return { state: "ok", revision: null };
      const found = list.find((item: any) => String(item?.id) === SKILL_ID);
      if (!found) return { state: "missing", revision: null };
      const now = Number(found.revision ?? 0);
      return { state: now === SKILL_REVISION ? "ok" : "changed", revision: now };
    } catch {
      return { state: "ok", revision: null };
    }
  }

  async function runSkill(session: any) {
    const started = Date.now();
    const look = await lookUpSkill(session);
    if (look.state === "missing") {
      const gone = "技能 " + SKILL_ID + " 已经不在了（被删或被改名）。这个壳没用了，建议卸载。";
      record(false, 0, "failed", gone);
      return { status: "failed", skill: SKILL_ID, note: gone };
    }
    let timer: any;
    const timeout = new Promise<never>((_, fail) => {
      timer = setTimeout(() => fail(new Error(\`超过 \${cfg.timeoutMs} 毫秒还没回执，先停在这里；技能本身可能还在跑。\`)), cfg.timeoutMs);
    });
    try {
      const raw: any = await Promise.race([
        (ctx.tools as any).call("space_run", {
          id: SKILL_ID, params: {}, confirmSideEffects: true, via: "self",
        }, {
          // 用户已经在壳这一层确认过（壳本身 danger=ask）。内部这一步必须按 full 放行，
          // 否则每一层都会被审批卡住——M0 没有审批界面，permission 传 ask 会直接判 ask 然后报错。
          permission: "full", signal: session?.signal,
          origin: { plugin: "__SUB_ID__", action: "run" },
        }),
        timeout,
      ]);
      const took = Date.now() - started;
      if (!raw || raw.ok !== true) {
        const reason = typeof raw?.result === "string" ? raw.result : "没拿到回执。";
        record(false, took, "failed", reason);
        return { status: "failed", skill: SKILL_ID, note: reason };
      }
      const result: any = raw.result && typeof raw.result === "object" && "status" in raw.result ? raw.result : { status: "ok", raw: raw.result };
      const drift = look.state === "changed"
        ? "技能改过：发布时 rev " + SKILL_REVISION + "，现在 rev " + look.revision + "，这次按新定义跑的。"
        : "";
      const tail = result.status === "ok" ? "跑完了。" : String(result.error ?? "没跑成。");
      const note = [tail, drift].filter(Boolean).join(" ");
      record(result.status === "ok", took, String(result.status ?? "ok"), note);
      return { status: String(result.status ?? "ok"), skill: SKILL_ID, runId: result.runId ?? null, steps: Array.isArray(result.steps) ? result.steps.length : 0, revision: look.revision, note, took };
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
      description: __DESCRIPTION__,
      schema: { type: "object", properties: {}, additionalProperties: false },
      async run(_args: unknown, session: any) { return await runSkill(session); },
    });

    // 只读探针：不跑技能，也不碰任何东西。发布之后靠它确认这一版真的在跑。
    ctx.tools.register({
      name: TOOL_NAME + "_probe",
      displayName: "技能壳只读探针",
      danger: "safe",
      description: "只读探针：不执行技能，只回报这个壳的技能 id、壳版本和工具名。用来确认发布有没有生效。",
      schema: { type: "object", properties: {}, additionalProperties: false },
      async run() {
        return { status: "ok", skill: SKILL_ID, tool: TOOL_NAME, version: SHELL_VERSION, skillRevision: SKILL_REVISION, enabled: cfg.enabled, at: new Date().toISOString() };
      },
    });

    ctx.tools.register({
      name: TOOL_NAME + "_uninstall",
      displayName: "卸载这个技能壳",
      danger: "full",
      description: "给这个技能壳登记卸载：写一个墓碑标记，宿主下次启动时由思维空间删掉目录。不会当场删，因为正在运行的目录删不掉。",
      schema: { type: "object", properties: { reason: { type: "string", description: "为什么卸，留个记录。" } }, additionalProperties: false },
      async run(args: any) {
        try {
          mkdirSync(dirname(flagFile), { recursive: true });
          writeFileSync(flagFile, JSON.stringify({ at: new Date().toISOString(), reason: String(args?.reason ?? "").slice(0, 200) }, null, 2), "utf8");
        } catch (error) {
          return { status: "failed", note: "墓碑写不进去：" + (error instanceof Error ? error.message : String(error)) };
        }
        return { status: "pending", at: flagFile, note: "已登记卸载。宿主重启后由思维空间清掉目录。" };
      },
    });
  }

  function panel() {
    const running = last;
    return html("技能壳 · " + DEFAULTS.displayName, \`
<section class="panel">
  <h2>状态</h2>
  <p>
    <span class="badge\${cfg.enabled ? "" : " warn"}">\${cfg.enabled ? "工具已注册" : "已关掉，工具不注册"}</span>
    <span class="badge">技能 \${escape(SKILL_ID)}</span>
    <span class="badge">壳版本 \${escape(SHELL_VERSION)}</span>
    <span class="badge">危险 \${DANGER}</span>
  </p>
  <p class="muted">\${running ? \`上次运行：\${escape(running.at)} · \${escape(running.status)} · \${running.took} 毫秒 · \${escape(running.note)}\` : "这个宿主起来之后还没跑过。"}</p>
  <p class="muted">壳里没有技能内容。步骤、参数都以技能本身为准，技能一改，壳跟着变。</p>
  <p class="muted">\${existsSync(flagFile) ? "⚠ 已经写过卸载墓碑：宿主下次启动会删掉这个目录。" : ""}</p>
</section>
<section class="panel">
  <h2>可以改的</h2>
  <form method="post" action="\${actionPath}">
    <label class="check"><input type="checkbox" name="enabled"\${cfg.enabled ? " checked" : ""}><span>注册这个工具</span></label>
    <div class="field">显示名</div>
    <input type="text" name="displayName" maxlength="40" value="\${escape(cfg.displayName)}">
    <div class="field">单次超时（毫秒）</div>
    <input type="number" name="timeoutMs" min="5000" max="600000" step="1000" value="\${cfg.timeoutMs}">
    <label class="check" style="margin-top:18px"><input type="checkbox" name="recordCalls"\${cfg.recordCalls ? " checked" : ""}><span>记调用（时间、成败、耗时，不记参数）</span></label>
    <p style="margin-top:16px"><button class="primary" type="submit">保存设置</button></p>
  </form>
</section>
<section class="panel">
  <h2>写死的</h2>
  <p class="muted" style="margin:0">技能 id、工具名、危险等级、目录路径。这四样改代码才能动——壳能改自己的显示，不能改自己的权限。</p>
</section>\`);
  }

  ctx.web.page(pagePath, async (req: any, res: any) => {
    try {
      const note = String(new URL(req.url ?? "/", "http://local").searchParams.get("note") ?? "");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(note ? panel().replace("<h1>", \`<p class="notice">\${escape(note)}</p><h1>\`) : panel());
    } catch (error) {
      res.writeHead(503, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(html("技能壳", \`<p>暂时读不到状态：\${escape(error instanceof Error ? error.message : "")}</p>\`));
    }
  }, { title: "技能壳·" + DEFAULTS.displayName, settings: true });

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
      note = "存下了。开关和显示名要重载这个子插件才生效，超时和记调用立刻生效。";
    } catch (error) {
      note = "没存成：" + (error instanceof Error ? error.message : String(error));
    }
    res.writeHead(303, { Location: pagePath + "?note=" + encodeURIComponent(note) });
    res.end();
  });

  ctx.logger.info(\`技能壳 \${SKILL_ID} v\${SHELL_VERSION}：\${cfg.enabled ? "注册" : "未注册"}工具 \${TOOL_NAME}\`);
}
`;

/** 生成两个文件的内容。纯函数，好测。 */
export function renderShell(skill: PublishSkill, subId: string, version: string) {
  const toolName = toolNameFor(subId);
  const steps = skill.steps.map((step, index) => `${index + 1} ${step.tool}`).join(" → ");
  const description =
    `跑思维空间技能「${skill.name}」：${steps || "（没有步骤）"}。` +
    `壳只是转发，步骤和参数以技能本身为准。危险等级写死 ask，确认点在这一层。`;
  const source = SHELL
    .replace("__SKILL_NAME__", skill.name.replace(/\*\//g, "* /"))
    .replace(/__SUB_ID__/g, subId)
    .replace(/__SKILL_ID__/g, JSON.stringify(skill.id))
    .replace(/__TOOL_NAME__/g, JSON.stringify(toolName))
    .replace(/__VERSION__/g, JSON.stringify(version))
    .replace(/__SKILL_REVISION__/g, String(Number(skill.revision ?? 0)))
    .replace(/__DISPLAY_NAME__/g, JSON.stringify(skill.name.slice(0, 40)))
    .replace(/__DESCRIPTION__/g, JSON.stringify(description));
  const manifest = [
    `id: ${subId}`,
    `name: 技能壳·${skill.name.replace(/\n/g, " ").slice(0, 60)}`,
    `description: 由思维空间按技能「${skill.id}」发布的壳。只存技能 id，运行时调真技能。`,
    `version: ${version}`,
    `apiVersion: "1.0.0"`,
    `depends: [web]`,
    "",
  ].join("\n");
  return { source, manifest, toolName, description, steps };
}

/** 发布前的静态检查。模板是固定的，所以这里查的是「有没有漏填、撞车、清单能不能用」。 */
export function checkRendered(rendered: { source: string; manifest: string }, subId: string, toolName: string) {
  const problems: string[] = [];
  if (/__[A-Z_]+__/.test(rendered.source)) problems.push("源码里还有没替换的占位符。");
  if (!rendered.source.includes("export async function apply")) problems.push("源码缺少 apply 入口。");
  if (!rendered.source.includes(toolName)) problems.push("源码里没有工具名。");
  if (!rendered.source.includes("_probe")) problems.push("源码里没有只读探针。");
  const open = (rendered.source.match(/\{/g) ?? []).length;
  const close = (rendered.source.match(/\}/g) ?? []).length;
  if (Math.abs(open - close) > 0) problems.push(`花括号不配平（{ ${open} / } ${close}）。`);
  if (!new RegExp(`^id: ${subId}$`, "m").test(rendered.manifest)) problems.push("清单 id 和目录名不一致。");
  for (const key of ["id", "name", "description", "version", "apiVersion"]) {
    if (!new RegExp(`^${key}: `, "m").test(rendered.manifest)) problems.push("清单缺少 " + key + "。");
  }
  return problems;
}

function fingerprintOf(skill: PublishSkill, subId: string) {
  // 只看壳里真正装进去的东西：技能 id、名字、步骤链。版本号不参与，
  // 否则每发布一次指纹就变一次，「同内容重复发布」永远判不出来。
  return createHash("sha256")
    .update("v" + TEMPLATE_VERSION)
    .update("\u0000")
    .update(subId)
    .update("\u0000")
    .update(skill.id)
    .update("\u0000")
    .update(skill.name)
    .update("\u0000")
    .update(skill.steps.map((step) => step.tool).join(">"))
    .update("\u0000")
    .update(String(Number(skill.revision ?? 0)))
    .digest("hex")
    .slice(0, 16);
}

/** 把 id 加进父清单的 sub: 列表。没有这一行就补一行。 */
export function addToManifest(manifest: string, id: string) {
  const line = /^sub:\s*\[(.*?)\]\s*$/m.exec(manifest);
  if (line) {
    const items = line[1].split(",").map((item) => item.trim()).filter(Boolean);
    if (items.includes(id)) return manifest;
    items.push(id);
    return manifest.replace(line[0], `sub: [${items.join(", ")}]`);
  }
  return manifest.replace(/\s*$/, "") + `\nsub: [${id}]\n`;
}

export function removeFromManifest(manifest: string, id: string) {
  const line = /^sub:\s*\[(.*?)\]\s*$/m.exec(manifest);
  if (!line) return manifest;
  const items = line[1].split(",").map((item) => item.trim()).filter(Boolean).filter((item) => item !== id);
  return items.length
    ? manifest.replace(line[0], `sub: [${items.join(", ")}]`)
    : manifest.replace(line[0] + "\n", "");
}

export function registerSkillPublish(ctx: Context, hooks: PublishHooks) {
  const dataDir = join(hooks.here, "data");
  const subRoot = join(hooks.here, "sub");
  const registryFile = join(dataDir, "publishes.json");
  const pendingFile = join(dataDir, "publish-pending.json");
  const stagingRoot = join(dataDir, "publish-staging");
  const backupRoot = join(dataDir, "publish-backups");
  const manifestFile = join(hooks.here, "plugin.yaml");
  const pagePath = "/plugins/thinking-space/shells";
  const apiBase = "/plugins/thinking-space/shells";

  function readRegistry(): PublishFile {
    try {
      const parsed = JSON.parse(readFileSync(registryFile, "utf8"));
      if (parsed?.schemaVersion === 1 && Array.isArray(parsed.items)) return parsed;
    } catch { /* 没有或坏了，当空 */ }
    return { schemaVersion: 1, items: [] };
  }
  function writeRegistry(next: PublishFile) {
    mkdirSync(dataDir, { recursive: true });
    // 先写临时文件再改名：写一半断电不会留下半份 json。
    const temp = registryFile + ".tmp";
    writeFileSync(temp, JSON.stringify(next, null, 2), "utf8");
    renameSync(temp, registryFile);
  }
  function pushHistory(record: PublishRecord, action: string, note?: string) {
    record.history = [...(record.history ?? []), { at: new Date().toISOString(), action, ...(note ? { note } : {}) }].slice(-20);
  }

  function readPending(): PendingFile {
    try {
      const parsed = JSON.parse(readFileSync(pendingFile, "utf8"));
      if (parsed?.schemaVersion === 1 && Array.isArray(parsed.jobs)) return parsed;
    } catch { /* 没有或坏了，当空 */ }
    return { schemaVersion: 1, jobs: [] };
  }
  function writePending(next: PendingFile) {
    mkdirSync(dataDir, { recursive: true });
    // 和发布登记一样：先写临时文件再改名，写一半断电不会留下半份 json。
    const temp = pendingFile + ".tmp";
    writeFileSync(temp, JSON.stringify(next, null, 2), "utf8");
    renameSync(temp, pendingFile);
  }
  function saveJob(job: PendingJob) {
    const file = readPending();
    file.jobs = file.jobs.filter((item) => item.subId !== job.subId && item.publishId !== job.publishId);
    file.jobs.push(job);
    writePending(file);
  }
  function dropJob(publishId: string) {
    if (!publishId) return;
    const file = readPending();
    const jobs = file.jobs.filter((item) => item.publishId !== publishId);
    if (jobs.length !== file.jobs.length) writePending({ schemaVersion: 1, jobs });
  }

  function dirOf(subId: string) {
    return join(subRoot, subId);
  }

  // 发布串行：同一父插件下不允许两条发布同时改文件。
  let queue: Promise<unknown> = Promise.resolve();
  function serial<T>(task: () => Promise<T>): Promise<T> {
    const next = queue.then(task, task);
    queue = next.catch(() => undefined);
    return next;
  }

  /**
   * 用备份铺回去。备份不存在 = 首次发布，直接撤掉。
   * 清单只动这一次发布涉及的条目：整份回拷会把之后别的发布一起抹掉。
   */
  function restoreFrom(record: { subId: string; backup: string | null }) {
    const dir = dirOf(record.subId);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    if (record.backup) {
      const from = join(backupRoot, record.backup, "dir");
      if (!existsSync(from)) throw new Error("备份目录不在了：" + from);
      cpSync(from, dir, { recursive: true });
    }
    const current = readFileSync(manifestFile, "utf8");
    // 退回去的那一版本来就登记着，所以有备份时是「确保仍在」，首次发布才是「拿掉」。
    const next = record.backup
      ? addToManifest(current, record.subId)
      : removeFromManifest(current, record.subId);
    if (next !== current) writeFileSync(manifestFile, next, "utf8");
  }

  /** 静态自检：目录在、入口在、清单登记在。启动时先跑这个，不依赖子插件能不能加载。 */
  function staticProblem(record: PublishRecord): string | null {
    const dir = dirOf(record.subId);
    if (!existsSync(dir)) return "目录不在：" + record.subId;
    const entry = join(dir, "index.ts");
    if (!existsSync(entry)) return "入口不在：" + record.subId + "/index.ts";
    const source = readFileSync(entry, "utf8");
    if (!source.includes(record.toolName)) return "入口里没有工具名 " + record.toolName;
    if (/__[A-Z_]+__/.test(source)) return "入口里还有没替换的占位符";
    const manifest = readFileSync(manifestFile, "utf8");
    if (!new RegExp(`^sub:\\s*\\[.*\\b${record.subId}\\b.*\\]`, "m").test(manifest)) return "父清单没有登记 " + record.subId;
    return null;
  }

  /** 启动时的自愈：上次发布停在半路（写完但没验过）的，先静态查，坏了就回退。 */
  function healOnBoot() {
    let registry: PublishFile;
    try { registry = readRegistry(); } catch { return; }
    let changed = false;
    for (const record of registry.items) {
      if (record.stage !== "written" && record.stage !== "staged") continue;
      const problem = staticProblem(record);
      if (!problem) continue;
      try {
        restoreFrom(record);
        record.stage = "failed";
        record.reason = "启动自检没过：" + problem;
        pushHistory(record, "rollback", record.reason);
        ctx.logger.warn(`思维空间：技能壳 ${record.subId} 启动自检没过，已回退（${problem}）`);
      } catch (error) {
        record.reason = "回退失败：" + (error instanceof Error ? error.message : String(error));
        pushHistory(record, "rollback-failed", record.reason);
        ctx.logger.error(`思维空间：技能壳 ${record.subId} 回退失败`, error);
      }
      changed = true;
    }
    if (changed) writeRegistry(registry);
  }

  /** 盘上这一版的版本号；读不到返回 null。 */
  function versionOnDisk(subId: string): string | null {
    try {
      const manifest = readFileSync(join(subRoot, subId, "plugin.yaml"), "utf8");
      return /^version:\s*(.+)$/m.exec(manifest)?.[1]?.trim() ?? null;
    } catch { return null; }
  }
  function manifestHas(subId: string) {
    try {
      const manifest = readFileSync(manifestFile, "utf8");
      return new RegExp("^sub:\\s*\\[.*\\b" + subId + "\\b.*\\]", "m").test(manifest);
    } catch { return false; }
  }
  /** 目录里的入口、版本，加上父清单登记，三样都已经是这一版。 */
  function writtenAs(job: PendingJob) {
    const entry = join(subRoot, job.subId, "index.ts");
    if (!existsSync(entry)) return false;
    try {
      if (!readFileSync(entry, "utf8").includes(toolNameFor(job.subId))) return false;
    } catch { return false; }
    if (versionOnDisk(job.subId) !== job.version) return false;
    return manifestHas(job.subId);
  }
  function markRolledBack(job: PendingJob, reason: string) {
    const registry = readRegistry();
    let record = registry.items.find((item) => item.subId === job.subId) ?? null;
    if (!record) {
      // 半路退出时登记还没写。补一条，备份位置和原因不能丢，接手的人得看得见。
      record = {
        subId: job.subId, skillId: job.skillId, toolName: toolNameFor(job.subId),
        displayName: job.skillId, version: job.version, danger: "ask", fingerprint: "",
        stage: "failed", at: new Date().toISOString(), backup: job.backup,
        manifestBackup: job.manifestBackup, history: [], publishId: job.publishId,
      };
      registry.items.push(record);
    }
    record.fingerprint = "";
    record.stage = job.first ? "withdrawn" : "rolled-back";
    record.reason = reason;
    pushHistory(record, job.first ? "withdraw" : "rollback", reason);
    writeRegistry(registry);
  }
  /** 把半截发布退回去：目录、清单、登记三样都要对齐，退成功了才销掉作业记录。 */
  function rollbackJob(job: PendingJob, reason: string) {
    restoreFrom({ subId: job.subId, backup: job.backup });
    markRolledBack(job, reason);
  }
  /**
   * 启动时先看有没有半截的发布。
   * 可重复跑：已经退干净的再跑一次只是重新铺一遍同样的文件，不会多删东西。
   */
  function recoverPending() {
    let file: PendingFile;
    try { file = readPending(); } catch { return; }
    if (!file.jobs.length) return;
    const keep: PendingJob[] = [];
    for (const job of file.jobs) {
      try {
        const written = writtenAs(job);
        if (job.phase === "preparing") {
          if (written) {
            job.phase = "written";
            job.note = "上次发布写完文件和清单，但没走到重载。";
            keep.push(job);
            ctx.logger.warn("思维空间：技能壳 " + job.subId + " 停在待重载，保留记录等核对。");
          } else {
            rollbackJob(job, "上次发布在替换中途中断，已回退");
            ctx.logger.warn("思维空间：技能壳 " + job.subId + " 上次发布半路中断，已回退。");
          }
        } else if (written) {
          job.note = "上次发布已写入，还没验收。";
          keep.push(job);
          ctx.logger.warn("思维空间：技能壳 " + job.subId + " 上次发布还没验收（v" + job.version + "）。");
        } else {
          rollbackJob(job, "上次发布文件或清单不完整，已回退");
          ctx.logger.warn("思维空间：技能壳 " + job.subId + " 的文件与清单对不上，已回退。");
        }
      } catch (error) {
        job.note = "恢复失败：" + (error instanceof Error ? error.message : String(error));
        keep.push(job);
        ctx.logger.error("思维空间：技能壳 " + job.subId + " 恢复失败", error);
      }
    }
    writePending({ schemaVersion: 1, jobs: keep });
  }

  recoverPending();
  healOnBoot();

  async function probe(record: PublishRecord) {
    const tools = await hooks.toolNames();
    const present = tools.some((tool) => tool.name === record.toolName);
    const probeTool = record.toolName + "_probe";
    const hasProbe = tools.some((tool) => tool.name === probeTool);
    if (!present) return { ok: false, reason: "重载后工具表里没有 " + record.toolName, present, hasProbe, probe: null };
    let answer: any = null;
    try {
      answer = await (ctx.tools as any).call(probeTool, {}, { permission: "full", origin: { plugin: hooks.parentId, action: "publish-probe" } });
    } catch (error) {
      return { ok: false, reason: "探针调不动：" + (error instanceof Error ? error.message : String(error)), present, hasProbe, probe: null };
    }
    const payload = answer?.result ?? null;
    const got = String(payload?.version ?? "");
    const want = String(record.version ?? "");
    const answered = answer?.ok === true && payload?.status === "ok";
    // 工具在、探针也回话还不够：版本得是这一版，否则内存里跑的还是旧壳。
    const ok = answered && (!want || got === want);
    return {
      ok,
      reason: answered
        ? (ok ? "" : "探针返回 v" + (got || "?") + "，目标 v" + want)
        : "探针没回 ok：" + JSON.stringify(answer ?? null).slice(0, 200),
      present, hasProbe,
      probe: payload,
      version: payload?.version ?? null,
      expectedVersion: want,
    };
  }

  function send(res: any, status: number, body: unknown) {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
  }

  // —— 发布 ——
  ctx.web.api(apiBase + "/publish", async (req: any, res: any) => {
    try {
      if (String(req.method ?? "GET").toUpperCase() !== "POST") return send(res, 405, { ok: false, error: "只支持 POST。" });
      const raw = await hooks.readBody(req, 64 * 1024);
      const parsed = raw ? JSON.parse(raw) : {};
      const skillId = String(parsed?.skillId ?? "").trim();
      if (!skillId) return send(res, 400, { ok: false, error: "缺少 skillId。" });
      const result = await serial(() => publish(skillId, parsed || {}));
      return send(res, result.ok ? 200 : 422, result);
    } catch (error) {
      return send(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  async function publish(skillId: string, input: any) {
    const skills = await hooks.readSkills();
    const skill = skills.find((item) => item.id === skillId);
    if (!skill) return { ok: false, error: "找不到技能 " + skillId + "。先保存再发布。" };
    if (!Array.isArray(skill.steps) || !skill.steps.length) return { ok: false, error: "这条技能没有步骤，发布成工具没有意义。" };

    const subId = subIdFor(skillId);
    const toolName = toolNameFor(subId);
    const dir = dirOf(subId);
    const registry = readRegistry();
    const known = registry.items.find((item) => item.subId === subId) ?? null;

    // 目录在、但没有我们的登记 → 不是我们建的，不碰。
    if (existsSync(dir) && !known) {
      return { ok: false, error: `目录 sub/${subId} 已经存在，但不是从这里发布的，不覆盖。` };
    }

    // 工具名撞车：同名的工具已经属于别的插件。
    // 上游宿主的 list() 不报 plugin 字段，所以「是不是我们自己的」只能按发布记录认：
    // 有记录的 subId，它的三个工具名就是我们的；没有记录还撞上了，才算真的撞车。
    const tools = await hooks.toolNames();
    const ours = new Set([toolName, toolName + "_probe", toolName + "_uninstall"]);
    const clash = known ? null : tools.find((tool) => ours.has(tool.name));
    if (clash) return { ok: false, error: `工具名 ${clash.name} 已经被${clash.plugin ? " " + clash.plugin : "别的插件"}占用。` };

    // 版本：内容变了才升一格。指纹没变就沿用旧版本号，避免每次发布都涨版本。
    const fingerprint = fingerprintOf(skill, subId);
    // 指纹一样还不够：撤回或回退之后目录可能已经不在了，这时候必须重写，不能报「复用」。
    const same = Boolean(known && known.fingerprint === fingerprint && existsSync(dir));
    const version = known ? (same ? known.version : bump(known.version)) : "0.1.0";
    const rendered = renderShell(skill, subId, version);
    const problems = checkRendered(rendered, subId, rendered.toolName);
    if (problems.length) return { ok: false, error: "静态检查没过：" + problems.join("；") };

    // 同一份内容重复发布：不写、不登记、不重载，直接把上一次的结果还回去。
    if (known && same) {
      return {
        ok: true, reused: true, subId, toolName: known.toolName, version: known.version,
        stage: known.stage, wroteFiles: 0, reloaded: false,
        ...(known.stage === "verified" ? {} : { needsReload: true, reloadId: hooks.parentId }),
        note: known.stage === "verified"
          ? "同一个技能、同一份内容，已经发布过并且验过了。没有重复写入，也没有重复重载。"
          : "同一个技能、同一份内容，文件已经写好了，只差重载。这次没有重复写入。",
      };
    }

    // 1) 先放暂存目录，检查都过了才往 sub/ 搬。
    const stageDir = join(stagingRoot, subId);
    if (existsSync(stageDir)) rmSync(stageDir, { recursive: true, force: true });
    mkdirSync(stageDir, { recursive: true });
    writeFileSync(join(stageDir, "index.ts"), rendered.source, "utf8");
    writeFileSync(join(stageDir, "plugin.yaml"), rendered.manifest, "utf8");

    // 2) 备份：旧目录整份 + 父清单。首次发布没有旧目录，记 null。
    const stampId = stamp();
    const backupDir = join(backupRoot, stampId);
    mkdirSync(backupDir, { recursive: true });
    copyFileSync(manifestFile, join(backupDir, "plugin.yaml"));
    const hadDir = existsSync(dir);
    if (hadDir) cpSync(dir, join(backupDir, "dir"), { recursive: true });

    // 2.5) 先落盘作业记录，再碰正式目录。写不进去就不发布，旧版原样留着。
    const publishId = stampId;
    const job: PendingJob = {
      publishId, subId, skillId, version, first: !hadDir,
      backup: hadDir ? stampId : null, manifestBackup: stampId,
      phase: "preparing", at: new Date().toISOString(),
    };
    try {
      saveJob(job);
    } catch (error) {
      return {
        ok: false,
        error: "恢复记录写不进去，已停止发布（旧版没动）：" + (error instanceof Error ? error.message : String(error)),
      };
    }

    // 3) 搬进 sub/，把旧 data/ 带过去（配置、调用记录不能因为换版本丢）。
    if (hadDir) rmSync(dir, { recursive: true, force: true });
    // 测试专用：在隔离实例里让进程停在「旧目录已移走、新文件还没写」这一刻。
    // 只在环境变量显式打开时生效，正常跑不会碰到。
    if (process.env.WL_PUBLISH_FAULT === "exit-after-remove") process.exit(37);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "index.ts"), rendered.source, "utf8");
    writeFileSync(join(dir, "plugin.yaml"), rendered.manifest, "utf8");
    if (hadDir) {
      const oldData = join(backupDir, "dir", "data");
      if (existsSync(oldData)) cpSync(oldData, join(dir, "data"), { recursive: true });
    }

    // 4) 父清单登记。
    const manifest = readFileSync(manifestFile, "utf8");
    const nextManifest = addToManifest(manifest, subId);
    if (nextManifest !== manifest) writeFileSync(manifestFile, nextManifest, "utf8");

    // 5) 登记发布记录，等重载。
    const record: PublishRecord = known ? { ...known } : {
      subId, skillId, toolName, displayName: skill.name, version, danger: "ask", fingerprint,
      stage: "written", at: new Date().toISOString(), backup: null, manifestBackup: stampId, history: [],
    };
    record.skillId = skillId;
    record.toolName = rendered.toolName;
    record.displayName = skill.name;
    record.version = version;
    record.fingerprint = fingerprint;
    record.skillRevision = Number(skill.revision ?? 0);
    record.stage = "written";
    record.at = new Date().toISOString();
    record.backup = hadDir ? stampId : null;
    record.replacedVersion = known ? known.version : null;
    record.manifestBackup = stampId;
    record.publishId = publishId;
    record.reason = undefined;
    pushHistory(record, known ? "republish" : "publish", `v${version}`);
    const items = registry.items.filter((item) => item.subId !== subId);
    items.push(record);
    writeRegistry({ schemaVersion: 1, items });

    rmSync(stageDir, { recursive: true, force: true });

    // 6) 文件和清单都写完了，阶段推到「等重载验收」。记录还在，验收或回退之后才销。
    try {
      job.phase = "written";
      saveJob(job);
    } catch {
      // 文件已经落地，记录写失败不推翻这次发布：启动自检还能兜住不一致的情况。
    }
    return {
      ok: true, reused: false, subId, toolName: rendered.toolName, version, publishId,
      stage: record.stage, wroteFiles: 2, reloaded: false,
      backup: record.backup, manifestBackup: stampId,
      needsReload: true, reloadId: hooks.parentId,
      note: "文件写好了、清单登记了。还没重载，所以现在跑的还是旧版本。",
    };
  }

  function bump(version: string) {
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version ?? ""));
    if (!match) return "0.1.0";
    return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
  }

  // —— 验收 ——
  ctx.web.api(apiBase + "/verify", async (req: any, res: any) => {
    try {
      // ctx.web.api 在宿主里是 POST-only，所以这里从请求体取 subId，查询串只作兜底。
      const raw = await hooks.readBody(req, 8 * 1024).catch(() => "");
      const parsed = raw ? JSON.parse(raw) : {};
      const url = new URL(String(req.url ?? "/"), "http://local");
      const subId = String(parsed?.subId ?? url.searchParams.get("subId") ?? "").trim();
      const registry = readRegistry();
      const record = registry.items.find((item) => item.subId === subId);
      if (!record) return send(res, 404, { ok: false, error: "没有这个发布记录：" + subId });
      const result = await probe(record);
      if (result.ok && record.stage !== "verified") {
        record.stage = "verified";
        record.at = new Date().toISOString();
        pushHistory(record, "verify", `v${record.version} 探针返回 ${String(result.version ?? "")}`);
        writeRegistry(registry);
        dropJob(record.publishId ?? "");
      }
      return send(res, 200, { ...result, subId, toolName: record.toolName, version: result.version ?? record.version, stage: record.stage });
    } catch (error) {
      return send(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  // —— 回退 ——
  ctx.web.api(apiBase + "/rollback", async (req: any, res: any) => {
    try {
      if (String(req.method ?? "GET").toUpperCase() !== "POST") return send(res, 405, { ok: false, error: "只支持 POST。" });
      const raw = await hooks.readBody(req, 16 * 1024);
      const parsed = raw ? JSON.parse(raw) : {};
      const subId = String(parsed?.subId ?? "").trim();
      const reason = String(parsed?.reason ?? "").slice(0, 200);
      const result = await serial(async () => {
        const registry = readRegistry();
        const record = registry.items.find((item) => item.subId === subId);
        if (!record) return { ok: false, error: "没有这个发布记录：" + subId };
        try {
          restoreFrom(record);
        } catch (error) {
          record.stage = "failed";
          record.reason = "回退失败：" + (error instanceof Error ? error.message : String(error));
          pushHistory(record, "rollback-failed", record.reason);
          writeRegistry(registry);
          return { ok: false, error: record.reason, stage: record.stage, keptBackup: record.manifestBackup };
        }
        const first = !record.backup;
        if (!first) {
          if (record.replacedVersion) record.version = record.replacedVersion;
          record.replacedVersion = null;
        }
        // 不论撤回还是回退，盘上的文件都变了，指纹一律作废：
        // 不清掉的话，同内容再发布会判成「复用」，而目录其实已经不在了。
        record.fingerprint = "";
        record.stage = first ? "withdrawn" : "rolled-back";
        record.reason = reason || (first ? "首次发布撤回" : "回退到上一版");
        pushHistory(record, first ? "withdraw" : "rollback", record.reason);
        writeRegistry(registry);
        dropJob(record.publishId ?? "");
        return {
          ok: true, subId, stage: record.stage, removed: first, restored: !first,
          backup: record.manifestBackup, needsReload: true, reloadId: hooks.parentId,
          note: first ? "首次发布失败：目录和登记都撤掉了。" : "上一版铺回来了。内存里跑的还是失败那版，要再重载一次才会换回旧工具。",
        };
      });
      return send(res, result.ok ? 200 : 500, result);
    } catch (error) {
      return send(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  // —— 状态（给页面用） ——
  ctx.web.api(apiBase + "/status", async (_req: any, res: any) => {
    try {
      const registry = readRegistry();
      const tools = await hooks.toolNames();
      const items = registry.items.map((record) => ({
        subId: record.subId, skillId: record.skillId, toolName: record.toolName,
        displayName: record.displayName, version: record.version, stage: record.stage,
        at: record.at, reason: record.reason ?? null, publishId: record.publishId ?? null,
        present: tools.some((tool) => tool.name === record.toolName),
        history: record.history.slice(-5),
      }));
      const pending = readPending().jobs.map((job) => ({
        publishId: job.publishId, subId: job.subId, version: job.version,
        phase: job.phase, at: job.at, note: job.note ?? null,
      }));
      return send(res, 200, { ok: true, items, pending });
    } catch (error) {
      return send(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  // —— 页面 ——
  ctx.web.page(pagePath, async (_req: any, res: any) => {
    try {
      const skills = await hooks.readSkills();
      const registry = readRegistry();
      const published = new Map(registry.items.map((item) => [item.skillId, item]));
      const rowOf = (skill: any) => {
        const record = published.get(skill.id);
        const nowRevision = Number(skill.revision ?? 0);
        const state = record
          ? `<span class="badge">${hooks.escape(record.stage)}</span><code>${hooks.escape(record.subId)}</code>` +
            `<div class="space-muted">发布时 rev ${hooks.escape(String(record.skillRevision ?? "?"))} · 现在 rev ${hooks.escape(String(nowRevision))}` +
            (Number(record.skillRevision ?? -1) === nowRevision ? "" : " · <strong>技能改过，壳跑的是新定义</strong>") + `</div>`
          : `<span class="badge">未发布</span><div class="space-muted">现在 rev ${hooks.escape(String(nowRevision))}</div>`;
        return `<tr><td>${hooks.escape(skill.name)}<div class="space-muted"><code>${hooks.escape(skill.id)}</code></div></td>` +
          `<td>${skill.steps.length} 步</td><td>${state}</td>` +
          `<td><button data-publish="${hooks.escape(skill.id)}">发布</button>` +
          (record ? ` <button data-rollback="${hooks.escape(record.subId)}">回退</button>` : "") +
          (record && record.stage === "written" && record.publishId ? ` <button data-resume="${hooks.escape(record.publishId)}">核对</button>` : "") +
          `</td></tr>`;
      };
      const sectionOf = (kind: string, title: string) => {
        const group = skills.filter((skill) => skill.kind === kind);
        return `<h3 style="margin:18px 0 8px;font-size:14px">${title}（${group.length}）</h3>` +
          `<table style="width:100%;border-collapse:collapse;font-size:13px;text-align:left">` +
          `<thead><tr><th>技能</th><th>规模</th><th>已发布</th><th></th></tr></thead><tbody>` +
          (group.map(rowOf).join("") || `<tr><td colspan="4">还没有。</td></tr>`) +
          `</tbody></table>`;
      };
      const sections = sectionOf("single", "功能库") + sectionOf("composite", "复合功能库");
      const pendingRows = readPending().jobs.map((job) =>
        "<li><code>" + hooks.escape(job.subId) + "</code> v" + hooks.escape(job.version) +
        " · " + hooks.escape(job.phase) +
        (job.note ? " · " + hooks.escape(job.note) : "") + "</li>").join("");
      const script = [
        "const report = document.getElementById(\"report\");",
        "function say(line) { report.textContent += line + String.fromCharCode(10); }",
        "async function api(path, body) {",
        "  const res = await fetch(path, body === undefined ? {} : { method: \"POST\", headers: { \"Content-Type\": \"application/json\" }, body: JSON.stringify(body) });",
        "  return await res.json().catch(() => ({ ok: false, error: \"返回不是 JSON\" }));",
        "}",
        "async function probe(path) {",
        "  try {",
        "    const res = await fetch(path, { headers: { Accept: \"application/json\" }, cache: \"no-store\" });",
        "    if (!res.ok) return { kind: \"rejected\", status: res.status };",
        "    const body = await res.json().catch(() => null);",
        "    if (!body) return { kind: \"rejected\", status: res.status, detail: \"返回不是 JSON\" };",
        "    return { kind: \"ok\", body: body };",
        "  } catch (error) {",
        "    return { kind: \"unreachable\", detail: String((error && error.message) || error) };",
        "  }",
        "}",
        "async function reloadParent(id) {",
        "  try {",
        "    const res = await fetch(\"/api/plugin\", { method: \"POST\", headers: { \"Content-Type\": \"application/json\" }, body: JSON.stringify({ id: id, action: \"reload\" }) });",
        "    if (!res.ok) return { kind: \"rejected\", status: res.status };",
        "    const body = await res.json().catch(() => null);",
        "    if (body && body.ok === false) return { kind: \"rejected\", detail: JSON.stringify(body).slice(0, 200) };",
        "    return { kind: \"ok\" };",
        "  } catch (error) {",
        "    return { kind: \"unreachable\", detail: String((error && error.message) || error) };",
        "  }",
        "}",
        "function pluginEntry(status, id) {",
        "  const list = status && status.plugins;",
        "  if (!Array.isArray(list)) return null;",
        "  for (const item of list) if (item && item.id === id) return item;",
        "  return null;",
        "}",
        "function pendingHas(status, publishId) {",
        "  const list = status && status.pending;",
        "  if (!Array.isArray(list)) return true;",
        "  if (!publishId) return false;",
        "  return list.some((item) => item.publishId === publishId);",
        "}",
        "async function settle(job, tries, wait) {",
        "  let last = \"还没核对\";",
        "  let anyStatus = false;",
        "  for (let i = 0; i < tries; i += 1) {",
        "    const st = await probe(\"/api/status?t=\" + Date.now());",
        "    if (st.kind === \"ok\") {",
        "      anyStatus = true;",
        "      const entry = pluginEntry(st.body, job.reloadId + \"/\" + job.subId);",
        "      if (entry) {",
        "        if (entry.enabled === false) return { state: \"disabled\", detail: \"插件是停用状态\" };",
        "        if (String(entry.version) === String(job.version)) {",
        "          const v = await api(\"/plugins/thinking-space/shells/verify\", { subId: job.subId });",
        "          if (v && v.ok) return { state: \"ok\", detail: \"探针返回 v\" + (v.version || job.version) };",
        "          last = (v && v.error) ? v.error : \"探针没通过\";",
        "        } else { last = \"宿主里还是 v\" + entry.version; }",
        "      } else { last = \"工具表里还没有 \" + job.toolName; }",
        "    } else { last = \"状态接口连不上：\" + (st.detail || st.status); }",
        "    if (i < tries - 1) await new Promise((done) => setTimeout(done, wait));",
        "  }",
        "  return { state: anyStatus ? \"stale\" : \"unknown\", detail: last };",
        "}",
        "const resumeJobs = {};",
        "function showResume(job) {",
        "  resumeJobs[job.publishId] = job;",
        "  const bar = document.getElementById(\"resume\");",
        "  if (!bar) return;",
        "  bar.textContent = \"有一条发布待确认：\" + job.subId + \" v\" + job.version + \" \";",
        "  const button = document.createElement(\"button\");",
        "  button.textContent = \"继续核对\";",
        "  button.addEventListener(\"click\", () => resume(job.publishId));",
        "  bar.appendChild(button);",
        "}",
        "async function resume(publishId) {",
        "  const job = resumeJobs[publishId];",
        "  if (!job) { say(\"这条发布不在本页记录里，刷新页面再核对。\"); return; }",
        "  const st = await probe(\"/api/status?t=\" + Date.now());",
        "  if (st.kind === \"ok\" && !pendingHas(st.body, publishId)) { say(\"这条发布已经不是待确认状态（可能已回退或被别的发布顶掉），不再自动处理。\"); return; }",
        "  say(\"── 继续核对 \" + job.subId);",
        "  return await finish(job, { kind: \"unknown\" });",
        "}",
        "async function finish(job, reload) {",
        "  const tries = reload.kind === \"ok\" ? 5 : 6;",
        "  const outcome = await settle(job, tries, 1200);",
        "  say(\"核对：\" + JSON.stringify(outcome));",
        "  if (outcome.state === \"ok\") { say(\"发布完成：\" + job.subId + \" v\" + job.version); return { state: \"ok\", subId: job.subId }; }",
        "  if (outcome.state === \"disabled\") { say(\"已写入，保持停用。启用这个子插件后再核对。\"); return { state: \"disabled\", subId: job.subId }; }",
        "  if (outcome.state === \"unknown\") { say(\"重载结果待确认：连宿主状态都查不到。没有自动回退。\"); showResume(job); return { state: \"unknown\", subId: job.subId }; }",
        "  say(\"重载没有换到新版本：\" + outcome.detail);",
        "  const why = reload.kind === \"rejected\" ? \"宿主拒绝重载\" : \"重载后版本没变\";",
        "  const back = await api(\"/plugins/thinking-space/shells/rollback\", { subId: job.subId, reason: why + \"：\" + outcome.detail });",
        "  say(\"回退：\" + JSON.stringify(back));",
        "  if (!back.ok) { say(\"回退失败，备份位置：\" + (back.keptBackup || \"\") + \"；恢复记录留在 data/publish-pending.json。\"); return { state: \"rollback-failed\", subId: job.subId }; }",
        "  const again = await reloadParent(job.reloadId);",
        "  say(\"回退后重载：\" + JSON.stringify(again));",
        "  return { state: \"rolled-back\", subId: job.subId };",
        "}",
        "async function full(skillId) {",
        "  say(\"── 发布 \" + skillId);",
        "  const beforeProbe = await probe(\"/api/status?t=\" + Date.now());",
        "  const pushed = await api(\"/plugins/thinking-space/shells/publish\", { skillId: skillId });",
        "  say(JSON.stringify(pushed));",
        "  if (!pushed.ok) return pushed;",
        "  const job = { subId: pushed.subId, toolName: pushed.toolName, version: pushed.version, reloadId: pushed.reloadId || \"thinking-space\", publishId: pushed.publishId };",
        "  const beforeEntry = beforeProbe.kind === \"ok\" ? pluginEntry(beforeProbe.body, job.reloadId + \"/\" + job.subId) : null;",
        "  const enabledBefore = beforeEntry ? beforeEntry.enabled !== false : true;",
        "  if (pushed.reused && !pushed.needsReload) { say(\"同一个技能、同一份内容，已经验过。没有重载，也不核对。\"); return pushed; }",
        "  if (!enabledBefore) { say(\"发布前这个子插件是停用的：文件和清单写好了，保持停用。启用之后再核对。\"); return { state: \"disabled\", subId: job.subId }; }",
        "  const reload = await reloadParent(job.reloadId);",
        "  say(\"重载：\" + JSON.stringify(reload));",
        "  return await finish(job, reload);",
        "}",
        "document.querySelectorAll(\"[data-publish]\").forEach((button) => button.addEventListener(\"click\", () => full(button.dataset.publish)));",
        "document.querySelectorAll(\"[data-rollback]\").forEach((button) => button.addEventListener(\"click\", async () => {",
        "  const back = await api(\"/plugins/thinking-space/shells/rollback\", { subId: button.dataset.rollback, reason: \"手动回退\" });",
        "  say(\"回退：\" + JSON.stringify(back));",
        "  if (back.ok) await reloadParent(back.reloadId);",
        "}));",
        "document.querySelectorAll(\"[data-resume]\").forEach((button) => button.addEventListener(\"click\", () => resume(button.dataset.resume)));",
        "window.__shells = { full: full, settle: settle, finish: finish, resume: resume, reloadParent: reloadParent, probe: probe, pendingHas: pendingHas, pluginEntry: pluginEntry };"
      ].join("\n");
      const body = `<p class="space-muted">发布不是保存。保存技能只写技能库；发布才会生成子插件目录、改父清单，然后要重载一次才生效。` +
        `重载由这一页来调——只有浏览器带着会话凭据，插件自己没这个权限。</p>` +
        `<p class="space-muted">壳只从这一页发布：技能先存在下面的功能库或复合功能库里，再来生成壳。画布上的「发布到思维空间」发的是技能，不是壳。</p>` +
        (pendingRows ? `<p class="space-muted">待确认的发布：</p><ul>` + pendingRows + `</ul>` : "") +
        `<div id="resume" class="space-muted"></div>
<p><button id="publish-all-verify">发布并验收（自动重载）</button></p>
` +
        sections + `
<pre id="report" style="margin-top:16px;white-space:pre-wrap;font-size:13px"></pre>
<script>
` + script + `</script>`;
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(hooks.html("技能壳", body));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(hooks.html("技能壳", `<p>读不出来：${hooks.escape(error instanceof Error ? error.message : "")}</p>`));
    }
  }, { title: "技能壳", navigation: false });

  return {
    list: (skillId: string) => readRegistry().items.find((item) => item.skillId === skillId) ?? null,
    dirs: () => readdirSync(subRoot).filter((name) => existsSync(join(subRoot, name, "plugin.yaml"))),
    isDir: (path: string) => { try { return statSync(path).isDirectory(); } catch { return false; } },
  };
}
