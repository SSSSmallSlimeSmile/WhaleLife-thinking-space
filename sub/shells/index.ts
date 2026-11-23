/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 *
 * 技能壳 · 固定子插件。
 *
 * 和上一版（每个壳一个目录、运行时生成程序文件）的根本区别：**这里不生成任何程序文件。**
 * 程序是一次写好、随包发布的；运行时只往自己的 data/shells.json 里记一条，
 * 按记录调用 ctx.tools.register() 把工具挂出去，删的时候注销。
 *
 * 这么做是因为：生成程序文件要把文件名、清单、子插件登记、重载、核对全串起来，
 * 每一步都会留下半成品状态（待确认、幽灵记录、写一半的目录）。数据不用重载，
 * 写坏了也只坏一条记录。
 *
 * 三条规矩：
 * 1. 壳只记 skillId 和工具名，运行时调真技能（space_run），不复制技能内容。
 * 2. 危险等级从技能本身推导，不由壳自己填——壳不能给自己降级。
 * 3. 权限透传调用者：不写死 permission，也不无条件放行副作用。
 *
 * 不读别的插件的文件：技能目录靠 ctx.tools.call("space_skills") 问，
 * 这是公开的工具接口，不碰磁盘、不猜路径。
 */
import type { Context, ToolSession } from "whalelife";

/** 展示用字段：日常版宿主认识 displayName，上游宿主没有。原样传过去，不认识的宿主会忽略。 */
declare module "whalelife" {
  interface ToolDefinition<Arguments = Record<string, unknown>, Result = unknown> {
    displayName?: string;
  }
}

const pagePath = "/plugins/thinking-space/shells/";
const apiBase = pagePath;
const storeFile = "shells.json";

type Danger = "safe" | "ask" | "full";

interface Shell {
  /** 技能 id，壳和技能靠它对齐。 */
  skillId: string;
  /** 宿主里的工具名，全局唯一。 */
  toolName: string;
  /** 工具显示名。 */
  label: string;
  /** 从技能推导出来的危险等级，不让壳自己填。 */
  danger: Danger;
  /** 加壳那一刻技能的版本，只在页面上比对，不参与运行。 */
  skillRevision: number;
  /** 关掉就不注册工具，记录还在。 */
  enabled: boolean;
  addedAt: string;
}

interface Store {
  schemaVersion: number;
  items: Shell[];
}

/** 技能声明的参数。和父插件 Skill.params 一一对应，只取生成 schema 要用的字段。 */
interface Param {
  name: string;
  type: string;
  required: boolean;
  label?: string | null;
  aliases?: string[];
}

/** 从父插件拿到的一条技能声明。 */
interface SkillInfo {
  id: string;
  name: string;
  description: string;
  kind: string;
  danger: Danger;
  revision: number;
  stepCount: number;
  params: Param[];
}

const EMPTY: Store = { schemaVersion: 1, items: [] };

function escape(value: unknown) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** 工具名：只留字母数字下划线，长度限 60。名字全局唯一，撞了加后缀。 */
function toToolName(skillId: string) {
  const base = "skill_" + skillId.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase();
  return (base.length > 60 ? base.slice(0, 60) : base) || "skill_tool";
}

function uniqueName(want: string, taken: Set<string>) {
  if (!taken.has(want)) return want;
  for (let n = 2; n < 100; n++) {
    const candidate = want + "_" + n;
    if (!taken.has(candidate)) return candidate;
  }
  return want + "_" + Date.now().toString(36);
}

/** 技能参数类型 → JSON Schema 类型。父插件只认这六种，正好都是 JSON Schema 的合法类型。 */
const JSON_TYPES = new Set(["string", "integer", "number", "boolean", "object", "array"]);

/** 把技能声明的参数翻成工具 schema。 */
function schemaFor(params: Param[]) {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const param of params) {
    if (!param || typeof param.name !== "string" || !param.name) continue;
    const type = JSON_TYPES.has(String(param.type)) ? String(param.type) : "string";
    const node: Record<string, unknown> = { type };
    if (typeof param.label === "string" && param.label.trim()) node.description = param.label.trim();
    properties[param.name] = node;
    if (param.required === true) required.push(param.name);
  }
  return { type: "object", properties, additionalProperties: false, ...(required.length ? { required } : {}) };
}

/** 只留技能声明过的参数（含别名），别把无关字段透过去。 */
function pickParams(args: unknown, params: Param[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!args || typeof args !== "object" || Array.isArray(args)) return out;
  const given = args as Record<string, unknown>;
  for (const param of params) {
    if (!param || typeof param.name !== "string") continue;
    const keys = [param.name, ...(Array.isArray(param.aliases) ? param.aliases : [])];
    const hit = keys.find(key => Object.hasOwn(given, key));
    if (hit !== undefined) out[param.name] = given[hit];
  }
  return out;
}

function html(title: string, body: string) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title>
<style>
:root{--line:rgba(127,127,127,.28);--surface:rgba(127,127,127,.06)}
body{margin:0 auto;padding:28px 22px 60px;max-width:900px;font:15px/1.65 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
h1{font-size:19px;margin:0 0 6px}
.lead{opacity:.72;font-size:13px;margin:0 0 20px}
.panel{border:1px solid var(--line);border-radius:14px;padding:18px 20px;margin:0 0 16px;background:var(--surface)}
.panel>h2{margin:0 0 14px;padding-bottom:10px;font-size:15px;font-weight:700;border-bottom:1px solid var(--line)}
.cost{margin:0;padding-left:20px;font-size:13px;line-height:1.75}
.cost li{margin:6px 0}
.cost b{font-weight:600}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:middle}
th{font-weight:600;font-size:12px;opacity:.7}
tr:last-child td{border-bottom:0}
.badge{display:inline-block;margin-right:6px;padding:1px 9px;border:1px solid var(--line);border-radius:999px;font-size:12px}
.badge.warn{border-color:#c98;color:#a63}
.badge.ok{border-color:#4a8;color:#2a7}
.muted{opacity:.7;font-size:13px}
button{padding:7px 15px;border-radius:9px;border:1px solid var(--line);background:transparent;color:inherit;font:inherit;font-weight:600;cursor:pointer}
button.primary{border-color:#4a8;color:#2a7}
button.danger{border-color:#c88;color:#a44}
select,input[type=text]{width:100%;max-width:460px;padding:8px 11px;border:1px solid var(--line);border-radius:9px;background:transparent;color:inherit;font:inherit}
.notice{padding:10px 14px;border:1px solid var(--line);border-radius:10px;margin:0 0 16px;font-size:14px}
.notice.ok{border-color:#4a8}
.notice.bad{border-color:#c88}
code{font-family:ui-monospace,Consolas,monospace;font-size:13px}
</style></head><body><h1>${escape(title)}</h1>${body}</body></html>`;
}

export async function apply(ctx: Context) {
  /** 内存里的记录表，和 data/shells.json 对应。 */
  let store: Store = { ...EMPTY, items: [] };
  /** 当前注册出去的工具的注销函数，按 skillId 存。 */
  const disposers = new Map<string, () => void>();
  /** 最近一次操作的结果，只给页面看。 */
  let lastNote = "";

  async function readStore(): Promise<Store> {
    try {
      const raw = await ctx.config.read<Store>(storeFile);
      if (!raw || !Array.isArray(raw.items)) return { ...EMPTY, items: [] };
      const items = raw.items.filter(item => item && typeof item.skillId === "string" && typeof item.toolName === "string")
        .map(item => ({
          skillId: item.skillId,
          toolName: item.toolName,
          label: typeof item.label === "string" && item.label.trim() ? item.label : item.skillId,
          danger: (item.danger === "full" || item.danger === "safe" ? item.danger : "ask") as Danger,
          skillRevision: Number.isInteger(item.skillRevision) ? item.skillRevision : 0,
          enabled: item.enabled !== false,
          addedAt: typeof item.addedAt === "string" ? item.addedAt : new Date().toISOString(),
        }));
      return { schemaVersion: 1, items };
    } catch {
      return { ...EMPTY, items: [] };
    }
  }

  async function saveStore() {
    await ctx.config.save(storeFile, store);
  }

  /** 已加载的技能声明，按 id 存。加壳时 refresh，注册时从这里取参数。 */
  let skillIndex = new Map<string, SkillInfo>();

  /** 问父插件要技能声明。
   *  先走公开服务 thinking-space.skills（带参数声明，作者要求的做法）；
   *  服务不在就退回 space_skills 工具（只有摘要，没参数——壳照旧能建，只是不带入参）。 */
  async function fetchSkills(): Promise<{ ok: boolean; items: SkillInfo[]; via: "service" | "tool"; error?: string }> {
    try {
      const service: any = ctx.get("thinking-space.skills", false);
      if (service && typeof service.describe === "function") {
        const list = await service.describe();
        const items = (Array.isArray(list) ? list : []).map((item: any) => ({
          id: String(item?.id ?? ""),
          name: String(item?.name ?? ""),
          description: String(item?.description ?? ""),
          kind: String(item?.kind ?? "single"),
          danger: (item?.danger === "safe" || item?.danger === "full" ? item.danger : "ask") as Danger,
          revision: Number(item?.revision ?? 0),
          stepCount: Number(item?.stepCount ?? 0),
          params: Array.isArray(item?.params) ? item.params : [],
        })).filter((item: SkillInfo) => !!item.id);
        return { ok: true, items, via: "service" };
      }
    } catch { /* 服务不在就退回工具，下面接着试 */ }
    try {
      const raw: any = await ctx.tools.call("space_skills", {}, { permission: "ask" } as any);
      const body = raw && raw.ok === true ? raw.result : null;
      const items = (Array.isArray(body?.skills) ? body.skills : []).map((item: any) => ({
        id: String(item?.id ?? ""),
        name: String(item?.name ?? ""),
        description: String(item?.description ?? ""),
        kind: String(item?.kind ?? "single"),
        danger: (item?.danger === "safe" || item?.danger === "full" ? item.danger : "ask") as Danger,
        revision: Number(item?.revision ?? 0),
        stepCount: Number(item?.stepCount ?? 0),
        params: [],
      })).filter((item: SkillInfo) => !!item.id);
      return { ok: true, items, via: "tool" };
    } catch (error) {
      return { ok: false, items: [], via: "tool", error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** 刷新技能索引。注册壳之前调一次，保证 schema 跟得上技能声明。 */
  async function refreshSkills(): Promise<{ ok: boolean; via: "service" | "tool"; error?: string }> {
    const { ok, items, via, error } = await fetchSkills();
    if (ok) skillIndex = new Map(items.map(item => [item.id, item]));
    return { ok, via, error };
  }

  /** 按一条记录注册工具。返回注销函数。 */
  function registerShell(shell: Shell): () => void {
    return ctx.tools.register({
      name: shell.toolName,
      displayName: shell.label,
      danger: shell.danger,
      description: `跑思维空间技能「${shell.skillId}」。壳只转发：步骤、参数、失败原因都以技能本身为准，技能改了壳跟着变。` +
        `参数就是技能自己声明的那几个，必填/可选照技能的定义。危险等级 ${shell.danger} 来自技能自己声明的步骤，不由壳指定。`,
      schema: schemaFor(skillIndex.get(shell.skillId)?.params ?? []),
      async run(args: unknown, session: ToolSession) {
        const started = Date.now();
        const params = pickParams(args, skillIndex.get(shell.skillId)?.params ?? []);
        try {
          // 危险等级只决定「要不要问」。放行条件是：用户对这一次执行明确确认过。
          // 拿不到确认就不跑，指路到能确认的入口——壳不替用户点头。
          let confirmed = false;
          if (shell.danger !== "safe") {
            const verdict: any = await Promise.resolve()
              .then(() => ctx.approval?.request())
              .catch(() => ({ approved: false }));
            confirmed = verdict?.approved === true;
            if (!confirmed) {
              const why =
                typeof verdict?.reason === "string" && verdict.reason
                  ? "（宿主：" + verdict.reason + "）"
                  : "";
              return {
                status: "needs_confirmation",
                skill: shell.skillId,
                note:
                  "这条技能含副作用步骤，要先对本次执行明确确认。" +
                  why +
                  "当前入口拿不到确认，请在能确认的地方再跑一次（例如在聊天里直接让助手执行这条技能，由宿主来问）。",
                took: Date.now() - started,
              };
            }
          }
          const raw: any = await ctx.tools.call("space_run", {
            id: shell.skillId,
            params,
            confirmSideEffects: confirmed,
            via: "self",
          }, {
            // 透传调用者的权限，不写死；放不放行由上一步的确认单独决定。
            permission: session?.permission,
            signal: session?.signal,
            origin: { plugin: "thinking-space/shells", action: shell.skillId },
          } as any);
          if (!raw || raw.ok !== true) {
            return { status: "failed", skill: shell.skillId, note: typeof raw?.result === "string" ? raw.result : "没拿到回执。" };
          }
          const result: any = raw.result && typeof raw.result === "object" ? raw.result : { status: "ok", raw: raw.result };
          const note = result.status === "ok" ? "跑完了。" : String(result.error ?? "没跑成。");
          return {
            status: String(result.status ?? "ok"),
            skill: shell.skillId,
            runId: result.runId ?? null,
            steps: Array.isArray(result.steps) ? result.steps.length : 0,
            note,
            ...(result.staleDefinition ? { staleDefinition: result.staleDefinition } : {}),
            took: Date.now() - started,
          };
        } catch (error) {
          return { status: "failed", skill: shell.skillId, note: error instanceof Error ? error.message : String(error), took: Date.now() - started };
        }
      },
    });
  }

  /** 把内存记录和实际注册对齐。 */
  function syncRegistrations() {
    const wanted = new Map(store.items.filter(item => item.enabled).map(item => [item.skillId, item]));
    // 注销不再需要的
    for (const [skillId, dispose] of disposers) {
      if (!wanted.has(skillId)) {
        try { dispose(); } catch { /* 注销失败不影响后面 */ }
        disposers.delete(skillId);
      }
    }
    // 注册新的 / 名字变了的
    for (const shell of wanted.values()) {
      const had = store.items.find(item => item.skillId === shell.skillId);
      if (!had) continue;
      if (!disposers.has(shell.skillId)) {
        try {
          disposers.set(shell.skillId, registerShell(shell));
        } catch (error) {
          lastNote = `工具 ${shell.toolName} 注册失败：${error instanceof Error ? error.message : String(error)}`;
        }
      }
    }
  }

  /** 删掉一条记录并注销工具。只动自己的数据。 */
  async function removeShell(skillId: string) {
    const idx = store.items.findIndex(item => item.skillId === skillId);
    if (idx < 0) return false;
    const dispose = disposers.get(skillId);
    if (dispose) {
      try { dispose(); } catch { /* 已经没了就算了 */ }
      disposers.delete(skillId);
    }
    store.items.splice(idx, 1);
    await saveStore();
    return true;
  }

  // —— 启动：读记录、刷技能声明、注册 ——
  store = await readStore();
  const boot = await refreshSkills();
  if (!boot.ok) lastNote = "读不到技能声明，壳先按无参数注册：" + (boot.error ?? "未知原因");
  syncRegistrations();

  // —— 页面 ——
  async function renderPanel(note: string, tone: "ok" | "bad" | "") {
    const { ok: skillsOk, items: skills, error: skillsError } = await fetchSkills();
    const taken = new Set<string>(store.items.map(item => item.toolName));
    const revisions = new Map<string, number>(skills.map(item => [String(item.id), Number(item.revision ?? 0)]));

    const rows = store.items.map(item => {
      const nowRev = revisions.get(item.skillId);
      const drift = nowRev !== undefined && nowRev !== item.skillRevision;
      const missing = skillsOk && nowRev === undefined;
      return `<tr>
  <td><code>${escape(item.skillId)}</code><div class="muted">${escape(item.label)}</div></td>
  <td><code>${escape(item.toolName)}</code></td>
  <td><span class="badge${item.danger === "safe" ? "" : " warn"}">${escape(item.danger)}</span></td>
  <td>${item.enabled ? '<span class="badge ok">已注册</span>' : '<span class="badge warn">已关</span>'}
    ${missing ? '<span class="badge warn">技能已不在</span>' : ""}
    ${drift ? `<span class="badge warn">rev ${item.skillRevision}→${nowRev}</span>` : ""}</td>
  <td><form method="post" action="${apiBase}remove" style="margin:0"><input type="hidden" name="skillId" value="${escape(item.skillId)}"><button class="danger" type="submit">删除壳</button></form></td>
</tr>`;
    }).join("");

    const options = (skillsOk ? skills : [])
      .filter(item => !store.items.some(shell => shell.skillId === String(item.id)))
      .map(item => `<option value="${escape(item.id)}">${escape(item.name)}（${escape(item.kind)} · ${Number(item.stepCount ?? 0)} 步 · ${escape(item.danger)}）</option>`)
      .join("");

    const notice = note ? `<p class="notice ${tone}">${escape(note)}</p>` : "";

    return html("技能壳", `
<p class="lead">把技能注册成工具入口。程序在这里一次写好，加壳删壳只动一个数据文件，不生成程序文件、不改 <code>plugin.yaml</code>、不重载。<b>但每个壳都是常驻成本，能不加就不加——加之前先看下面那块。</b></p>
${notice}
<section class="panel">
  <h2>现在的壳（${store.items.length}）</h2>
  ${store.items.length ? `<table><thead><tr><th>技能</th><th>工具名</th><th>危险</th><th>状态</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
    : '<p class="muted" style="margin:0">还没有。下面挑一条技能加壳。</p>'}
</section>
<section class="panel" style="border-color:rgba(200,140,60,.55)">
  <h2>加壳的代价</h2>
  <ul class="cost">
    <li><b>每轮都在付 token。</b>一个壳就是一个常驻工具，工具定义每轮请求都发；不用它也在付。壳多了，小上下文模型还没开始聊就撑满了。</li>
    <li><b>所有壳共用一个进程。</b>以前一个壳一个子插件，崩一个不连坐；现在全在 <code>thinking-space/shells</code> 里，它挂了壳一起没。</li>
    <li><b>技能改了参数，要重载一次子插件。</b>加壳删壳立刻生效，但技能自己改了参数声明，工具表不会自己跟上。</li>
    <li><b>依赖一个没写进契约的能力。</b>「apply 之后注册工具」是实测能用的，作者没在插件契约里承诺过；哪天收紧，这里要重做。</li>
    <li><b>壳不等于技能。</b>删壳只是注销工具，技能还在；反过来技能删了，壳留在那儿但一调就失败。</li>
  </ul>
  <p class="muted" style="margin:12px 0 0"><b>先让技能跑熟，再考虑固化成壳。</b>一次性的、只自己偶尔用的、带一堆参数的，都别加——直接让模型 <code>space_run</code> 就行。壳只为两种情况存在：<b>必须每轮被看见</b>，或者<b>要交给别人用</b>。</p>
</section>
<section class="panel">
  <h2>加一个壳</h2>
  ${skillsOk
    ? (options ? `<form method="post" action="${apiBase}add">
    <select name="skillId">${options}</select>
    <p class="muted" style="margin-top:10px">危险等级从技能自己声明的步骤推导，不让壳自己填；工具名按技能 id 生成，撞了自动加后缀。</p>
    <p style="margin-top:12px"><button class="primary" type="submit">加壳</button></p>
  </form>` : '<p class="muted" style="margin:0">技能库里每一条都已经有壳了，或者一条技能都没有。</p>')
    : `<p class="muted" style="margin:0">读不到技能列表：${escape(skillsError ?? "未知原因")}。父插件可能没装或没启用。</p>`}
</section>
<section class="panel">
  <h2>为什么是一个数据文件</h2>
  <p class="muted" style="margin:0">上一版每个壳生成一个子插件目录、改父 <code>plugin.yaml</code> 的 <code>sub:</code>、再重载宿主。
  那条路上每一步都会留半成品：待确认的发布、点开 404 的幽灵页、写一半的目录。
  现在壳是固定的程序，记录落在 <code>data/shells.json</code>：加一条就注册一个工具，删一条就注销一个，立刻生效，不用重载。</p>
</section>`);
  }

  ctx.web.page(pagePath, async (req: any, res: any) => {
    try {
      const note = String(new URL(req.url ?? "/", "http://local").searchParams.get("note") ?? "");
      const tone = String(new URL(req.url ?? "/", "http://local").searchParams.get("tone") ?? "") as "ok" | "bad" | "";
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(await renderPanel(note, tone === "ok" || tone === "bad" ? tone : ""));
    } catch (error) {
      res.writeHead(503, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(html("技能壳", `<p>暂时读不到状态：${escape(error instanceof Error ? error.message : "")}</p>`));
    }
  }, { title: "技能壳", settings: true });

  async function readForm(req: any) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
  }

  function redirect(res: any, note: string, tone: "ok" | "bad") {
    res.writeHead(303, { Location: pagePath + "?tone=" + tone + "&note=" + encodeURIComponent(note) });
    res.end();
  }

  ctx.web.api(apiBase + "add", async (req: any, res: any) => {
    try {
      const form = await readForm(req);
      const skillId = String(form.get("skillId") ?? "").trim();
      if (!skillId) return redirect(res, "没选技能。", "bad");
      if (store.items.some(item => item.skillId === skillId)) return redirect(res, "这条技能已经有壳了。", "bad");

      // 校验技能真的存在，并拿它的危险等级和参数声明。
      const { ok, items, error } = await fetchSkills();
      if (!ok) return redirect(res, "读不到技能列表：" + (error ?? "未知原因"), "bad");
      const skill = items.find(item => String(item.id) === skillId);
      if (!skill) return redirect(res, "技能库里没有 " + skillId + "。", "bad");

      const danger: Danger = skill.danger === "safe" || skill.danger === "full" ? skill.danger : "ask";
      const taken = new Set<string>(store.items.map(item => item.toolName));
      const shell: Shell = {
        skillId,
        toolName: uniqueName(toToolName(skillId), taken),
        label: String(skill.name ?? skillId).slice(0, 40),
        danger,
        skillRevision: Number(skill.revision ?? 0),
        enabled: true,
        addedAt: new Date().toISOString(),
      };
      skillIndex.set(skillId, skill);
      store.items.push(shell);
      await saveStore();
      syncRegistrations();
      const count = Array.isArray(skill.params) ? skill.params.length : 0;
      return redirect(res, `已加壳：工具 ${shell.toolName} 现在就出现在工具表里了（带 ${count} 个参数）。`, "ok");
    } catch (error) {
      return redirect(res, "没加成：" + (error instanceof Error ? error.message : String(error)), "bad");
    }
  });

  ctx.web.api(apiBase + "remove", async (req: any, res: any) => {
    try {
      const form = await readForm(req);
      const skillId = String(form.get("skillId") ?? "").trim();
      const gone = await removeShell(skillId);
      return redirect(res, gone ? "已删除，工具当场注销。" : "没有这条记录。", gone ? "ok" : "bad");
    } catch (error) {
      return redirect(res, "没删成：" + (error instanceof Error ? error.message : String(error)), "bad");
    }
  });

  ctx.logger.info(`技能壳：${store.items.filter(item => item.enabled).length} 个工具已注册（共 ${store.items.length} 条记录）`);
}
