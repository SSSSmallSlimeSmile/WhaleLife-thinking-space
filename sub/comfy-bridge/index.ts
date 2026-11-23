/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 *
 * 思维画布桥：把「画布能导入什么」摆到台面上。
 *
 * 四件事想清楚才这么写：
 * 1. 平级子插件：跟 canvas 一样挂在 thinking-space/sub/ 下，启停跟着思维空间，
 *    端口进程那一套一点不沾，只读文件、只回话。
 * 2. 不重复造生图。工作流从《生图》插件的 workflows 目录里读，出图仍然调它的
 *    comfy_generate。这边只解决「画布不知道有哪些工作流」这一个缺口。
 * 3. 生图插件不在，这个插件也不能麻利地消失——不然画布页少一块，用户不知道
 *    为什么。所以它自己照常起来，把「要先装什么」写在页面和工具回执里。
 * 4. 两个目录都读：workflows/ 是 ComfyUI 的 API 格式，给 comfy_generate 用；
 *    canvas-flows/ 是画布的功能包，给「注册功能」用。它们由 ComfyUI 那个导出
 *    扩展一次写两份，同名不同目录——这里只负责列出来，不生成、不改写。
 *
 * 为什么还要「设置」：画布能导入什么是有硬规矩的（schemaVersion 必须 1、
 * flow id 只认 [A-Za-z0-9_-]），这些规矩住在画布代码里，导出端看不见。把
 * 它们摆到桥的页面上，谁都能对着查；strict 开着时，不合格的包直接不列出来，
 * 免得用户点了「注册功能」才发现导不进。
 */
import type { Context } from "whalelife";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** 展示用字段：日常版宿主认识 displayName，上游宿主没有，运行时忽略即可。 */
declare module "whalelife" {
  interface ToolDefinition<Arguments = Record<string, unknown>, Result = unknown> {
    displayName?: string;
  }
}

const here = dirname(fileURLToPath(import.meta.url));
// plugins/thinking-space/sub/comfy-bridge → 回到 plugins，再进兄弟目录 comfy。
// 不写盘符：包发到谁的机器上都能用。
const comfyDir = join(here, "..", "..", "..", "comfy");
const workflowsDir = join(comfyDir, "workflows");
const canvasFlowsDir = join(comfyDir, "canvas-flows");
const pagePath = "/plugins/thinking-space/comfy-bridge/";
const dataPath = "/plugins/thinking-space/comfy-bridge/workflows";
const flowsPath = "/plugins/thinking-space/comfy-bridge/flows";
const settingsPath = "/plugins/thinking-space/comfy-bridge/settings";
const settingsFile = "bridge.json";

/** 画布导入器的硬规矩，抄自画布 index.html 的 importFlowBundle 校验。 */
const FLOW_ID = /^[A-Za-z0-9_-]{1,80}$/;

type Settings = { strict: boolean; defaultWorkflow: string };
type Workflow = { name: string; size: number; mtime: string };
type CanvasFlow = { name: string; slug: string; mtime: string; bundle: unknown; problems: string[] };

const DEFAULTS: Settings = { strict: true, defaultWorkflow: "" };

function escape(value: unknown) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function html(title: string, body: string) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title>
<style>
:root{--line:rgba(127,127,127,.28);--surface:rgba(127,127,127,.06)}
body{margin:0 auto;padding:28px 22px 60px;max-width:860px;font:15px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
h1{font-size:19px;margin:0 0 18px}
.panel{border:1px solid var(--line);border-radius:14px;padding:18px 20px;margin:0 0 14px;background:var(--surface)}
.panel>h2{margin:0 0 12px;padding-bottom:10px;font-size:15px;font-weight:700;border-bottom:1px solid var(--line)}
.badge{display:inline-block;margin:0 8px 6px 0;padding:2px 10px;border:1px solid var(--line);border-radius:999px;font-size:12px}
.badge.warn{border-color:#c98;color:#a63}
.muted{opacity:.72;font-size:13px}
table{border-collapse:collapse;width:100%;font-size:13px}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line)}
th{font-weight:600;opacity:.75}
code{font-size:13px}
form{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-top:4px}
label{font-size:13px;display:flex;gap:6px;align-items:center}
input[type=text]{padding:5px 8px;border:1px solid var(--line);border-radius:8px;background:transparent;color:inherit;min-width:220px}
button{padding:6px 14px;border:1px solid var(--line);border-radius:999px;background:transparent;color:inherit;font:inherit;font-size:13px;cursor:pointer}
button:hover{background:rgba(127,127,127,.12)}
</style></head><body><h1>${escape(title)}</h1>${body}</body></html>`;
}

export async function apply(ctx: Context) {
  const installed = () => existsSync(join(comfyDir, "plugin.yaml"));
  const toolReady = () => ctx.tools.list().some((tool: any) => tool.function?.name === "comfy_generate");

  async function readSettings(): Promise<Settings> {
    try {
      const raw = await ctx.config.read<Partial<Settings>>(settingsFile);
      const merged = { ...DEFAULTS, ...(raw ?? {}) };
      return { strict: merged.strict !== false, defaultWorkflow: String(merged.defaultWorkflow ?? "").slice(0, 200) };
    } catch {
      return { ...DEFAULTS };
    }
  }

  /** 读目录时坏掉一个文件不该让整页翻白，跳过那一个就行。 */
  function readWorkflows(): Workflow[] {
    if (!existsSync(workflowsDir)) return [];
    const out: Workflow[] = [];
    for (const entry of readdirSync(workflowsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".json")) continue;
      try {
        const info = statSync(join(workflowsDir, entry.name));
        out.push({ name: entry.name, size: info.size, mtime: info.mtime.toISOString() });
      } catch { /* 这个文件读不到就算了，别的照列 */ }
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  /** 按画布导入器的规矩逐条挑毛病；problems 为空才算能导。 */
  function inspectBundle(bundle: any): string[] {
    const problems: string[] = [];
    if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) return ["不是 JSON 对象"];
    if (bundle.schemaVersion !== 1) problems.push("schemaVersion 不是 1");
    if (!Array.isArray(bundle.flows) || !bundle.flows.length) problems.push("flows 不是非空数组");
    else {
      bundle.flows.forEach((flow: any, index: number) => {
        const id = flow?.id;
        if (typeof id !== "string" || !FLOW_ID.test(id)) problems.push(`flows[${index}].id 不符合 [A-Za-z0-9_-]{1,80}`);
        if (!Array.isArray(flow?.nodes)) problems.push(`flows[${index}].nodes 不是数组`);
        else {
          flow.nodes.forEach((node: any, n: number) => {
            if (typeof node?.id !== "string" || !node.id) problems.push(`flows[${index}].nodes[${n}].id 缺失`);
            if (typeof node?.type !== "string" || !node.type) problems.push(`flows[${index}].nodes[${n}].type 缺失`);
          });
        }
      });
    }
    return problems;
  }

  function readCanvasFlows(): CanvasFlow[] {
    if (!existsSync(canvasFlowsDir)) return [];
    const out: CanvasFlow[] = [];
    for (const entry of readdirSync(canvasFlowsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".json")) continue;
      const full = join(canvasFlowsDir, entry.name);
      try {
        const bundle = JSON.parse(readFileSync(full, "utf-8"));
        const problems = inspectBundle(bundle);
        const title = typeof bundle?.flows?.[0]?.name === "string" ? bundle.flows[0].name : "";
        out.push({
          name: title || entry.name.replace(/\.json$/i, ""),
          slug: entry.name.replace(/\.json$/i, ""),
          mtime: statSync(full).mtime.toISOString(),
          bundle,
          problems,
        });
      } catch { /* 手改坏的跳过 */ }
    }
    out.sort((a, b) => a.slug.localeCompare(b.slug));
    return out;
  }

  async function status() {
    const settings = await readSettings();
    const has = installed();
    const ready = toolReady();
    const workflows = has ? readWorkflows() : [];
    const allFlows = has ? readCanvasFlows() : [];
    const flows = settings.strict ? allFlows.filter((flow) => !flow.problems.length) : allFlows;
    const rejected = allFlows.length - flows.length;
    const note = !has
      ? "没装《生图》插件（comfy）。装上之后这里才列得出工作流，出图本身也走它。"
      : !ready
        ? "《生图》插件在，但 comfy_generate 还没注册上——多半是它自己没加载成功，去控制台看它的报错。"
        : workflows.length ? "" : "《生图》插件在，但 workflows 目录里没有 .json 工作流。去 ComfyUI 里点「存到 WhaleLife」导出一份。";
    return {
      ok: has && ready,
      installed: has,
      toolReady: ready,
      dir: workflowsDir,
      flowsDir: canvasFlowsDir,
      workflows,
      flows,
      rejected,
      settings,
      note,
    };
  }

  ctx.tools.register({
    name: "comfy_workflow_list",
    displayName: "列生图工作流",
    danger: "safe",
    description:
      "列出生图插件（comfy）里可用的 ComfyUI 工作流文件名与大小，拿来填 comfy_generate 的 workflow；同时列出画布可导入的功能包，标出哪些不合格。只读，不起任何任务；没装生图插件时也说清要先装什么。",
    schema: { type: "object", properties: {}, additionalProperties: false },
    async run() {
      const current = await status();
      return {
        ok: current.ok,
        installed: current.installed,
        toolReady: current.toolReady,
        workflows: current.workflows,
        canvasFlows: current.flows.map(({ slug, name, mtime }) => ({ slug, name, mtime })),
        rejectedCount: current.rejected,
        strict: current.settings.strict,
        defaultWorkflow: current.settings.defaultWorkflow,
        note: current.note,
      };
    },
  });

  ctx.web.page(pagePath, async (_req: any, res: any) => {
    const current = await status();
    const rows = current.workflows.length
      ? current.workflows.map((w) => `<tr><td><code>${escape(w.name)}</code></td><td>${Math.round(w.size / 102.4) / 10} KB</td><td>${escape(w.mtime.slice(0, 19).replace("T", " "))}</td></tr>`).join("")
      : `<tr><td colspan="3" class="muted">没有工作流文件</td></tr>`;

    const flowRows = current.flows.length
      ? current.flows.map((f) => `<tr><td><code>${escape(f.slug)}</code></td><td>${escape(f.name)}</td><td>${f.problems.length ? `<span class="badge warn">${escape(f.problems[0])}</span>` : `<span class="badge">可导入</span>`}</td><td>${escape(f.mtime.slice(0, 19).replace("T", " "))}</td></tr>`).join("")
      : `<tr><td colspan="4" class="muted">${current.rejected ? `有 ${current.rejected} 条没通过校验，关掉 strict 才看得见` : "还没有导出的功能包"}</td></tr>`;

    const strictChecked = current.settings.strict ? " checked" : "";
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(html("思维画布桥", `
<section class="panel">
  <h2>依赖</h2>
  <p><span class="badge${current.installed ? "" : " warn"}">生图插件：${current.installed ? "已安装" : "没装"}</span><span class="badge${current.toolReady ? "" : " warn"}">comfy_generate：${current.toolReady ? "可用" : "没注册上"}</span></p>
  ${current.note ? `<p class="muted">${escape(current.note)}</p>` : ""}
  <p class="muted">这个子插件只列东西，不自己出图。出图、看图都走《生图》插件，所以那边缺了这里也不会假装能用。</p>
</section>
<section class="panel">
  <h2>思维画布能导入什么</h2>
  <table><tbody>
    <tr><th>格式版本</th><td><code>schemaVersion: 1</code>，别的版本画布会直接拒</td></tr>
    <tr><th>flow id</th><td><code>[A-Za-z0-9_-]{1,80}</code>，中文名要在导出端换成哈希</td></tr>
    <tr><th>flows</th><td>非空数组；每条要有 <code>nodes</code> 数组，节点要有 <code>id</code> 和 <code>type</code></td></tr>
    <tr><th>入口</th><td>画布工具栏「注册功能」：从这份清单里挑，或粘贴 JSON</td></tr>
    <tr><th>导出端</th><td>ComfyUI 的 <code>ComfyUI-WhaleLife-thinkspace</code> 扩展「编辑 → 存到 WhaleLife」</td></tr>
  </tbody></table>
</section>
<section class="panel">
  <h2>画布功能包（${current.flows.length}${current.rejected ? ` · 另有 ${current.rejected} 条不合格被隐藏` : ""}）</h2>
  <p class="muted">目录：<code>${escape(current.flowsDir)}</code></p>
  <table><thead><tr><th>标识</th><th>名称</th><th>校验</th><th>导出时间</th></tr></thead><tbody>${flowRows}</tbody></table>
  <p class="muted" style="margin-top:12px">在 ComfyUI 里连好节点、点「存到 WhaleLife」，就会多一份到这里；去思维画布点「注册功能」直接导入。</p>
</section>
<section class="panel">
  <h2>设置</h2>
  <form method="post" action="${escape(settingsPath)}">
    <label><input type="checkbox" name="strict" value="1"${strictChecked}> 只列出能通过画布校验的包</label>
    <label>默认工作流 <input type="text" name="defaultWorkflow" value="${escape(current.settings.defaultWorkflow)}" placeholder="例如 nova-anime.json（留空则不指定）"></label>
    <button type="submit">保存</button>
  </form>
  <p class="muted" style="margin-top:12px">默认工作流只影响这里和工具回执里的提示；画布节点上没填 workflow 时用哪个，仍由画布和《生图》插件决定。</p>
</section>
<section class="panel">
  <h2>工作流（${current.workflows.length}）</h2>
  <p class="muted">目录：<code>${escape(current.dir)}</code></p>
  <table><thead><tr><th>文件名</th><th>大小</th><th>修改时间</th></tr></thead><tbody>${rows}</tbody></table>
  <p class="muted" style="margin-top:12px">在画布上的用法：放一个 comfy_generate 节点，workflow 填上面某个文件名；留空就用那边默认的。</p>
</section>`));
  }, { title: "思维画布桥" });

  // 表单提交走这里。保存完 303 回页面，免得刷新重发。
  ctx.web.api(settingsPath, async (req: any, res: any) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString("utf-8");
    const form = new URLSearchParams(body);
    const next: Settings = {
      strict: form.get("strict") === "1",
      defaultWorkflow: String(form.get("defaultWorkflow") ?? "").trim().slice(0, 200),
    };
    try {
      await ctx.config.save(settingsFile, next);
    } catch (error) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("保存失败：" + String(error));
      return;
    }
    res.writeHead(303, { Location: pagePath });
    res.end();
  });

  ctx.web.page(dataPath, async (_req: any, res: any) => {
    const current = await status();
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(current));
  });

  // 画布「注册功能」的接口：整包给，前端拿到就直接走它自己的导入校验。
  ctx.web.page(flowsPath, async (_req: any, res: any) => {
    const current = await status();
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ ok: current.installed, count: current.flows.length, flows: current.flows, note: current.note }));
  });

  ctx.logger.info(`思维画布桥：工作流目录 ${workflowsDir}，功能包目录 ${canvasFlowsDir}`);
}
