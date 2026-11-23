/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 *
 * 思维画布桥：把「画布能导入什么」摆到台面上，也给别的软件留一道门。
 *
 * 几件事想清楚才这么写：
 * 1. 平级子插件：跟 canvas 一样挂在 thinking-space/sub/ 下，启停跟着思维空间，
 *    端口进程那一套一点不沾，只读文件、只回话。
 * 2. 不重复造生图。工作流从《生图》插件的 workflows 目录里读，出图仍然调它的
 *    comfy_generate。这边只解决「画布看不到有哪些工作流、有哪些功能包」这个缺口。
 * 3. 生图插件不在，这个插件也不能麻利地消失——不然画布页少一块，用户不知道
 *    为什么。所以它自己照常起来，把「要先装什么」写在页面和工具回执里。
 * 4. 两个目录都读：workflows/ 是 ComfyUI 的 API 格式，给 comfy_generate 用；
 *    canvas-flows/ 是画布的功能包，给「注册功能」用。它们由 ComfyUI 那个导出
 *    扩展一次写两份，同名不同目录——这里只负责列出来，不生成、不改写。
 * 5. 中转：别的软件（Blender、Krita、自写的脚本）也能把自己的流程图推过来，
 *    走 POST /import 落成同一个格式的功能包。它们先注册一个「来源」，页面上
 *    就有自己的一块设置，值存在 data/providers.json。桥不猜它们的语义，只认
 *    画布那份校验——导不进画布的东西，这里也不许它落盘。
 *
 * 页面为什么必须带 settings:true —— 这是踩过的坑，记在这里：
 * 宿主控制台的插件页签只认带 settings 或 navigation 的页面（core/ui/extensions.js
 * 的 selection / groupPage 两处都是 p.settings || p.navigation）。只给 title 的话，
 * 页面本身能访问（200），但控制台里点进去永远是「暂无可用页面」。
 *
 * 另一个坑：ctx.web.api 只注册 POST，GET 一律 404。所以所有 GET 端点都用
 * ctx.web.page 注册，并且不传 entry —— 不传就不会出现在控制台的页面列表里。
 */
import type { Context } from "whalelife";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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
// 父插件的 data：画布自己 POST 上来的工程快照就在这儿，只读，用来判断「这条包导没导进画布」。
const spaceDataDir = join(here, "..", "..", "data");

const pagePath = "/plugins/thinking-space/comfy-bridge/";
const dataPath = "/plugins/thinking-space/comfy-bridge/workflows";
const flowsPath = "/plugins/thinking-space/comfy-bridge/flows";
const settingsPath = "/plugins/thinking-space/comfy-bridge/settings";
const deletePath = "/plugins/thinking-space/comfy-bridge/delete";
const apiPath = "/plugins/thinking-space/comfy-bridge/api";
const importPath = "/plugins/thinking-space/comfy-bridge/import";
const providersPath = "/plugins/thinking-space/comfy-bridge/providers";

const settingsFile = "bridge.json";
const providersFile = "providers.json";
const importsFile = "imports.json";

/** 画布导入器的硬规矩，抄自画布 index.html 的 importFlowBundle 校验。 */
const FLOW_ID = /^[A-Za-z0-9_-]{1,80}$/;

type Settings = { strict: boolean; defaultWorkflow: string; canvasUrl: string };
type Workflow = { name: string; size: number; mtime: string };
type Node = { id: string; type: string; prompt: string; workflow: string };
type ProviderField = { key: string; label: string; placeholder?: string };
type Provider = { id: string; name: string; description: string; fields: ProviderField[]; settings: Record<string, string>; addedAt: string };
type Imports = Record<string, { provider: string; providerName: string; at: string }>;
type CanvasFlow = {
  slug: string;
  name: string;
  size: number;
  mtime: string;
  flowId: string;
  nodes: Node[];
  tools: string[];
  prompts: string[];
  workflowFiles: string[];
  missingWorkflows: string[];
  registered: boolean;
  problems: string[];
  provider: string;
  providerName: string;
};

const DEFAULTS: Settings = { strict: true, defaultWorkflow: "", canvasUrl: "http://127.0.0.1:9281" };

function escape(value: unknown) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** 功能包落盘前的文件名净化：去掉路径分隔符，别的（含中文）都留着。 */
function safeSlug(raw: string, fallback: string) {
  const cleaned = String(raw ?? "").trim().replace(/[\\/:*?"<>|]/g, "").replace(/\.\./g, "").slice(0, 60);
  return cleaned || fallback;
}

function html(title: string, body: string) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title>
<style>
:root{--line:rgba(127,127,127,.28);--surface:rgba(127,127,127,.06);--ok:#2a7;--bad:#c55}
body{margin:0 auto;padding:28px 22px 60px;max-width:880px;font:15px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
h1{font-size:19px;margin:0 0 18px}
.panel{border:1px solid var(--line);border-radius:14px;padding:18px 20px;margin:0 0 14px;background:var(--surface)}
.panel>h2{margin:0 0 12px;padding-bottom:10px;font-size:15px;font-weight:700;border-bottom:1px solid var(--line)}
details.panel>summary{list-style:none;cursor:pointer;display:flex;align-items:center;gap:8px;font-size:15px;font-weight:700;padding-bottom:10px;border-bottom:1px solid var(--line);margin-bottom:12px}
details.panel>summary::-webkit-details-marker{display:none}
details.panel>summary::before{content:"▸";font-size:12px;opacity:.6;transition:transform .12s}
details.panel[open]>summary::before{transform:rotate(90deg)}
details.panel>summary .hint{margin-left:auto;font-weight:400;font-size:12.5px;opacity:.7}
.badge{display:inline-block;margin:0 8px 6px 0;padding:2px 10px;border:1px solid var(--line);border-radius:999px;font-size:12px}
.badge.ok{border-color:rgba(42,170,119,.5);color:var(--ok)}
.badge.warn{border-color:#c98;color:#a63}
.badge.bad{border-color:rgba(204,85,85,.55);color:var(--bad)}
.muted{opacity:.72;font-size:13px}
table{border-collapse:collapse;width:100%;font-size:13px}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-weight:600;opacity:.75}
code{font-size:12.5px}
pre{background:rgba(127,127,127,.1);border-radius:10px;padding:10px 12px;overflow:auto;font-size:12px;line-height:1.5}
form{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-top:4px}
label{font-size:13px;display:flex;gap:6px;align-items:center}
input[type=text]{padding:5px 8px;border:1px solid var(--line);border-radius:8px;background:transparent;color:inherit;min-width:220px}
button{padding:4px 12px;border:1px solid var(--line);border-radius:999px;background:transparent;color:inherit;font:inherit;font-size:12.5px;cursor:pointer}
button:hover{background:rgba(127,127,127,.12)}
button.danger{border-color:rgba(204,85,85,.55);color:var(--bad)}
details summary{cursor:pointer;font-size:12.5px;opacity:.8}
.node{font-size:12.5px;margin:2px 0}
.node b{font-weight:600}
.actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px;align-items:center}
.provider{border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin:0 0 10px}
.provider h3{margin:0 0 6px;font-size:14px}
</style></head><body><h1>${escape(title)}</h1>${body}</body></html>`;
}

export async function apply(ctx: Context) {
  const installed = () => existsSync(join(comfyDir, "plugin.yaml"));
  const toolReady = () => ctx.tools.list().some((tool: any) => tool.function?.name === "comfy_generate");

  async function readSettings(): Promise<Settings> {
    try {
      const raw = await ctx.config.read<Partial<Settings>>(settingsFile);
      const merged = { ...DEFAULTS, ...(raw ?? {}) };
      return {
        strict: merged.strict !== false,
        defaultWorkflow: String(merged.defaultWorkflow ?? "").slice(0, 200),
        canvasUrl: String(merged.canvasUrl ?? DEFAULTS.canvasUrl).trim().slice(0, 200) || DEFAULTS.canvasUrl,
      };
    } catch {
      return { ...DEFAULTS };
    }
  }

  async function readProviders(): Promise<Provider[]> {
    try {
      const raw = await ctx.config.read<any>(providersFile);
      const list = Array.isArray(raw?.providers) ? raw.providers : [];
      return list
        .filter((item: any) => item && typeof item.id === "string" && item.id)
        .map((item: any) => ({
          id: String(item.id).slice(0, 60),
          name: String(item.name ?? item.id).slice(0, 80),
          description: String(item.description ?? "").slice(0, 300),
          fields: Array.isArray(item.fields)
            ? item.fields
              .filter((field: any) => field && typeof field.key === "string" && field.key)
              .slice(0, 20)
              .map((field: any) => ({
                key: String(field.key).slice(0, 40),
                label: String(field.label ?? field.key).slice(0, 80),
                placeholder: String(field.placeholder ?? "").slice(0, 120),
              }))
            : [],
          settings: item.settings && typeof item.settings === "object" && !Array.isArray(item.settings)
            ? Object.fromEntries(Object.entries(item.settings).map(([k, v]) => [String(k).slice(0, 40), String(v ?? "").slice(0, 300)]))
            : {},
          addedAt: String(item.addedAt ?? ""),
        }));
    } catch {
      return [];
    }
  }

  async function saveProviders(providers: Provider[]) {
    await ctx.config.save(providersFile, { providers });
  }

  async function readImports(): Promise<Imports> {
    try {
      const raw = await ctx.config.read<any>(importsFile);
      const map = raw?.imports && typeof raw.imports === "object" ? raw.imports : {};
      const out: Imports = {};
      for (const [slug, value] of Object.entries(map as Record<string, any>)) {
        out[slug] = {
          provider: String(value?.provider ?? ""),
          providerName: String(value?.providerName ?? ""),
          at: String(value?.at ?? ""),
        };
      }
      return out;
    } catch {
      return {};
    }
  }

  async function saveImports(imports: Imports) {
    await ctx.config.save(importsFile, { imports });
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

  /** 画布工程快照里已经有的流程 id。读不到就当一条都没有，不影响别的。 */
  function registeredFlowIds(): Set<string> {
    const ids = new Set<string>();
    try {
      const raw = JSON.parse(readFileSync(join(spaceDataDir, "flows.json"), "utf-8"));
      const flows = Array.isArray(raw?.snapshot?.flows) ? raw.snapshot.flows : Array.isArray(raw?.flows) ? raw.flows : [];
      for (const flow of flows) if (typeof flow?.id === "string") ids.add(flow.id);
    } catch { /* 没存过工程、或者文件坏了，都当空 */ }
    return ids;
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

  /** 把包摊开：几个节点、用什么工具、提示词写什么、要哪个工作流。 */
  function readCanvasFlows(workflowNames: Set<string>, registered: Set<string>, imports: Imports): CanvasFlow[] {
    if (!existsSync(canvasFlowsDir)) return [];
    const out: CanvasFlow[] = [];
    for (const entry of readdirSync(canvasFlowsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".json")) continue;
      const full = join(canvasFlowsDir, entry.name);
      try {
        const bundle = JSON.parse(readFileSync(full, "utf-8"));
        const problems = inspectBundle(bundle);
        const flow = bundle?.flows?.[0] ?? {};
        const nodes: Node[] = (Array.isArray(flow.nodes) ? flow.nodes : []).map((node: any) => ({
          id: String(node?.id ?? ""),
          type: String(node?.type ?? ""),
          prompt: typeof node?.params?.prompt === "string" ? node.params.prompt : "",
          workflow: typeof node?.params?.workflow === "string" ? node.params.workflow : "",
        }));
        const tools = [...new Set(nodes.map((n) => n.type).filter(Boolean))];
        const prompts = nodes.map((n) => n.prompt).filter(Boolean);
        const workflowFiles = [...new Set(nodes.map((n) => n.workflow).filter(Boolean))];
        const info = statSync(full);
        const slug = entry.name.replace(/\.json$/i, "");
        const origin = imports[slug];
        out.push({
          slug,
          name: typeof flow?.name === "string" && flow.name ? flow.name : slug,
          size: info.size,
          mtime: info.mtime.toISOString(),
          flowId: typeof flow?.id === "string" ? flow.id : "",
          nodes,
          tools,
          prompts,
          workflowFiles,
          missingWorkflows: workflowFiles.filter((name) => !workflowNames.has(name)),
          registered: typeof flow?.id === "string" && registered.has(flow.id),
          problems,
          provider: origin?.provider ?? "",
          providerName: origin?.providerName ?? "",
        });
      } catch { /* 手改坏的跳过 */ }
    }
    out.sort((a, b) => a.slug.localeCompare(b.slug));
    return out;
  }

  async function status() {
    const settings = await readSettings();
    const providers = await readProviders();
    const imports = await readImports();
    const has = installed();
    const ready = toolReady();
    const workflows = has ? readWorkflows() : [];
    const workflowNames = new Set(workflows.map((w) => w.name));
    const allFlows = has ? readCanvasFlows(workflowNames, registeredFlowIds(), imports) : [];
    const flows = settings.strict ? allFlows.filter((flow) => !flow.problems.length) : allFlows;
    const rejected = allFlows.length - flows.length;
    const broken = flows.filter((flow) => flow.missingWorkflows.length);
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
      broken: broken.map((flow) => ({ slug: flow.slug, missing: flow.missingWorkflows })),
      providers,
      settings,
      note,
    };
  }

  /** 请求体：JSON 走 JSON.parse，表单走 URLSearchParams。两种都收，别的软件好接。 */
  async function body(req: any): Promise<{ form: URLSearchParams; json: any; text: string }> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString("utf-8");
    const type = String(req.headers?.["content-type"] ?? "");
    let json: any = null;
    let form = new URLSearchParams();
    if (type.includes("application/json")) {
      try { json = JSON.parse(text); } catch { json = null; }
    } else {
      form = new URLSearchParams(text);
    }
    return { form, json, text };
  }

  function jsonReply(res: any, code: number, payload: unknown) {
    res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(payload));
  }

  ctx.tools.register({
    name: "comfy_workflow_list",
    displayName: "列生图工作流",
    danger: "safe",
    description:
      "列出生图插件（comfy）里可用的 ComfyUI 工作流文件名与大小，拿来填 comfy_generate 的 workflow；同时列出画布可导入的功能包（含第三方来源推来的），标出哪些不合格、哪些引用的工作流已经不存在。只读，不起任何任务；没装生图插件时也说清要先装什么。",
    schema: { type: "object", properties: {}, additionalProperties: false },
    async run() {
      const current = await status();
      return {
        ok: current.ok,
        installed: current.installed,
        toolReady: current.toolReady,
        workflows: current.workflows,
        canvasFlows: current.flows.map(({ slug, name, flowId, tools, workflowFiles, missingWorkflows, registered, providerName, mtime }) => ({
          slug, name, flowId, tools, workflowFiles, missingWorkflows, registered, provider: providerName, mtime,
        })),
        providers: current.providers.map(({ id, name, fields }) => ({ id, name, fields: fields.map((f) => f.key) })),
        rejectedCount: current.rejected,
        strict: current.settings.strict,
        defaultWorkflow: current.settings.defaultWorkflow,
        note: current.note,
      };
    },
  });

  ctx.web.page(pagePath, async (_req: any, res: any) => {
    const current = await status();
    const settings = current.settings;

    const health = [
      `<span class="badge${current.installed ? " ok" : " bad"}">生图插件：${current.installed ? "已安装" : "没装"}</span>`,
      `<span class="badge${current.toolReady ? " ok" : " bad"}">comfy_generate：${current.toolReady ? "可用" : "没注册上"}</span>`,
      `<span class="badge${current.workflows.length ? "" : " warn"}">工作流 ${current.workflows.length} 个</span>`,
      `<span class="badge${current.flows.length ? "" : " warn"}">功能包 ${current.flows.length} 个${current.rejected ? ` · 隐藏 ${current.rejected}` : ""}</span>`,
      `<span class="badge${current.broken.length ? " bad" : " ok"}">缺工作流的包 ${current.broken.length} 个</span>`,
      `<span class="badge">已导入画布 ${current.flows.filter((flow) => flow.registered).length} 个</span>`,
      `<span class="badge">外部来源 ${current.providers.length} 个</span>`,
      `<span class="badge">画布 <code>${escape(settings.canvasUrl)}</code></span>`,
    ].join("");

    const flowRows = current.flows.length
      ? current.flows.map((flow) => {
        const verdict = flow.problems.length
          ? `<span class="badge bad">${escape(flow.problems[0])}</span>`
          : flow.missingWorkflows.length
            ? `<span class="badge bad">缺工作流 ${escape(flow.missingWorkflows.join("、"))}</span>`
            : `<span class="badge ok">可导入</span>`;
        const imported = flow.registered
          ? `<a href="${escape(settings.canvasUrl)}/?flow=${encodeURIComponent(flow.flowId)}" target="_blank" rel="noopener">打开这条流程</a>`
          : `<a href="${escape(settings.canvasUrl)}/" target="_blank" rel="noopener">去画布「注册功能」</a>`;
        const nodeLines = flow.nodes.length
          ? flow.nodes.map((node, index) => `<div class="node">${index + 1}. <b>${escape(node.type)}</b>${node.prompt ? ` · 提示词 <code>${escape(node.prompt.slice(0, 90))}${node.prompt.length > 90 ? "…" : ""}</code>` : ""}${node.workflow ? ` · 工作流 <code>${escape(node.workflow)}</code>` : ""}</div>`).join("")
          : `<div class="muted">包里没有节点</div>`;
        return `<tr>
  <td><code>${escape(flow.slug)}</code><div class="muted">${escape(flow.name)}</div></td>
  <td>${flow.nodes.length} 节点<div class="muted">${escape(flow.tools.join(" → ") || "无工具")}</div></td>
  <td>${flow.providerName ? `<span class="badge">${escape(flow.providerName)}</span>` : `<span class="muted">ComfyUI 扩展</span>`}</td>
  <td>${verdict}</td>
  <td>
    <details><summary>看内容 / 操作</summary>
      ${nodeLines}
      <div class="muted" style="margin-top:6px">画布里这条流程的 id：<code>${escape(flow.flowId || "（没有）")}</code> · ${Math.round(flow.size / 102.4) / 10} KB · ${escape(flow.mtime.slice(0, 19).replace("T", " "))}</div>
      <div class="actions">${imported}
        <form method="post" action="${escape(deletePath)}">
          <input type="hidden" name="slug" value="${escape(flow.slug)}">
          <button class="danger" type="submit">删除这个包</button>
        </form>
      </div>
    </details>
  </td>
</tr>`;
      }).join("")
      : `<tr><td colspan="5" class="muted">${current.rejected ? `有 ${current.rejected} 条没通过校验，关掉 strict 才看得见` : "还没有导出的功能包"}</td></tr>`;

    const workflowRows = current.workflows.length
      ? current.workflows.map((w) => `<tr><td><code>${escape(w.name)}</code></td><td>${Math.round(w.size / 102.4) / 10} KB</td><td>${escape(w.mtime.slice(0, 19).replace("T", " "))}</td></tr>`).join("")
      : `<tr><td colspan="3" class="muted">没有工作流文件</td></tr>`;

    const providerBlocks = current.providers.length
      ? current.providers.map((provider) => {
        const own = current.flows.filter((flow) => flow.provider === provider.id);
        const inputs = provider.fields.length
          ? provider.fields.map((field) => `<label>${escape(field.label)} <input type="text" name="s_${escape(field.key)}" value="${escape(provider.settings[field.key] ?? "")}" placeholder="${escape(field.placeholder ?? "")}"></label>`).join("")
          : `<span class="muted">这个来源没有声明设置项</span>`;
        return `<div class="provider">
  <h3>${escape(provider.name)} <code>${escape(provider.id)}</code></h3>
  ${provider.description ? `<p class="muted" style="margin:0 0 8px">${escape(provider.description)}</p>` : ""}
  <p class="muted" style="margin:0 0 8px">推上来 ${own.length} 个包${own.length ? `：${own.map((flow) => `<code>${escape(flow.slug)}</code>`).join("、")}` : ""}</p>
  <form method="post" action="${escape(providersPath)}">
    <input type="hidden" name="provider" value="${escape(provider.id)}">
    ${inputs}
    <button type="submit" name="action" value="save">保存</button>
    <button type="submit" name="action" value="delete" class="danger">移除来源</button>
  </form>
</div>`;
      }).join("")
      : `<p class="muted">还没有外部来源。别的软件可以往下看「给别的软件用」那段，推一个包过来就会出现在这里。</p>`;

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(html("思维画布桥", `
<section class="panel">
  <h2>体检</h2>
  <p>${health}</p>
  ${current.note ? `<p class="muted">${escape(current.note)}</p>` : ""}
  ${current.broken.length ? `<p class="muted">下面这些包引用的工作流在 workflows 目录里找不到，导进画布也画不出来：${current.broken.map((b) => `<code>${escape(b.slug)}</code> 要 ${escape(b.missing.join("、"))}`).join("；")}</p>` : ""}
  <p class="muted">这个子插件只列东西和转手，不自己出图。出图、看图都走《生图》插件，所以那边缺了这里也不会假装能用。</p>
</section>
<section class="panel">
  <h2>画布功能包（${current.flows.length}${current.rejected ? ` · 另有 ${current.rejected} 条不合格被隐藏` : ""}）</h2>
  <p class="muted">目录：<code>${escape(current.flowsDir)}</code></p>
  <table><thead><tr><th>包</th><th>内容</th><th>来源</th><th>校验</th><th>详情 / 操作</th></tr></thead><tbody>${flowRows}</tbody></table>
  <p class="muted" style="margin-top:12px">在 ComfyUI 里连好节点、点「存到 WhaleLife」，就会多一份到这里；去思维画布点「注册功能」直接导入。默认工作流：<code>${settings.defaultWorkflow ? escape(settings.defaultWorkflow) : "（未指定）"}</code></p>
</section>
<section class="panel">
  <h2>外部来源（${current.providers.length}）</h2>
  <p class="muted">别的软件把自己画好的流程推过来，落成和 ComfyUI 扩展同一个格式，画布那边一视同仁。每个来源自己的设置存在这里，不经过画布。</p>
  ${providerBlocks}
  <details>
    <summary>给别的软件用：接口怎么写</summary>
    <p class="muted">三条端点，都是同源的，不需要额外鉴权（宿主本来就是个本地服务）。</p>
    <table><tbody>
      <tr><th>看接口</th><td><code>GET ${escape(apiPath)}</code>：返回端点清单、模板和校验规则，机器可读</td></tr>
      <tr><th>注册来源</th><td><code>POST ${escape(providersPath)}</code>，JSON：<code>{"id":"blender","name":"Blender","description":"…","fields":[{"key":"engine","label":"引擎"}]}</code></td></tr>
      <tr><th>推一个包</th><td><code>POST ${escape(importPath)}</code>，JSON：<code>{"provider":{"id":"blender","name":"Blender"},"name":"包名","bundle":{…}}</code></td></tr>
    </tbody></table>
    <p class="muted" style="margin-top:10px">推包会被同一套校验先过一遍，过不了直接 400 并把问题列出来，不会落盘。示例：</p>
    <pre>curl -X POST ${escape(importPath)} \\
  -H "Content-Type: application/json" \\
  -d '{"provider":{"id":"blender","name":"Blender"},
       "name":"我的流程",
       "bundle":{"schemaVersion":1,"rootId":"my-flow",
                 "flows":[{"id":"my-flow","name":"我的流程",
                           "nodes":[{"id":"n1","type":"comfy_generate",
                                     "x":120,"y":120,
                                     "params":{"workflow":"我的工作流.json",
                                               "prompt":"\${prompt}"}}],
                           "edges":[]}]}}'</pre>
  </details>
</section>
<section class="panel">
  <h2>思维画布能导入什么</h2>
  <table><tbody>
    <tr><th>格式版本</th><td><code>schemaVersion: 1</code>，别的版本画布会直接拒</td></tr>
    <tr><th>flow id</th><td><code>[A-Za-z0-9_-]{1,80}</code>，中文名要在导出端换成哈希</td></tr>
    <tr><th>flows</th><td>非空数组；每条要有 <code>nodes</code> 数组，节点要有 <code>id</code> 和 <code>type</code></td></tr>
    <tr><th>入口</th><td>画布工具栏「注册功能」：选文件，或粘贴 JSON</td></tr>
    <tr><th>导出端</th><td>ComfyUI 的 <code>ComfyUI-WhaleLife-thinkspace</code> 扩展「编辑 → 存到 WhaleLife」；或任何软件打 <code>POST ${escape(importPath)}</code></td></tr>
  </tbody></table>
  <p class="muted">完整模板和注意事项写在插件的 <code>README.md</code> 里，跟着包一起发出去。</p>
</section>
<details class="panel">
  <summary>ComfyUI<span class="hint">工作流 ${current.workflows.length} 个 · 默认 ${settings.defaultWorkflow ? escape(settings.defaultWorkflow) : "未指定"} · 页面 ${settings.strict ? "只列合格包" : "全列"}</span></summary>
  <h2 style="font-size:14px;margin:0 0 10px">设置</h2>
  <form method="post" action="${escape(settingsPath)}">
    <label><input type="checkbox" name="strict" value="1"${settings.strict ? " checked" : ""}> 只列出能通过画布校验的包</label>
    <label>默认工作流 <input type="text" name="defaultWorkflow" value="${escape(settings.defaultWorkflow)}" placeholder="例如 nova-anime.json（留空则不指定）"></label>
    <label>画布地址 <input type="text" name="canvasUrl" value="${escape(settings.canvasUrl)}" placeholder="http://127.0.0.1:9281"></label>
    <button type="submit">保存</button>
  </form>
  <p class="muted" style="margin-top:10px">默认工作流只影响这里和工具回执里的提示；画布节点上没填 workflow 时用哪个，仍由画布和《生图》插件决定。画布地址只用来拼「打开这条流程」的链接，页面不会去连它。</p>
  <h2 style="font-size:14px;margin:18px 0 10px">工作流（${current.workflows.length}）</h2>
  <p class="muted">目录：<code>${escape(current.dir)}</code></p>
  <table><thead><tr><th>文件名</th><th>大小</th><th>修改时间</th></tr></thead><tbody>${workflowRows}</tbody></table>
  <p class="muted" style="margin-top:12px">在画布上的用法：放一个 comfy_generate 节点，workflow 填上面某个文件名；留空就用那边默认的。</p>
</details>`));
  }, { title: "思维画布桥", settings: true });

  // 表单提交走这里。保存完 303 回页面，免得刷新重发。
  ctx.web.api(settingsPath, async (req: any, res: any) => {
    const { form } = await body(req);
    const canvasUrl = String(form.get("canvasUrl") ?? "").trim().slice(0, 200);
    if (canvasUrl && !/^https?:\/\/[^\s"'<>]+$/i.test(canvasUrl)) {
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("画布地址要写成 http://主机:端口");
      return;
    }
    const next: Settings = {
      strict: form.get("strict") === "1",
      defaultWorkflow: String(form.get("defaultWorkflow") ?? "").trim().slice(0, 200),
      canvasUrl: canvasUrl || DEFAULTS.canvasUrl,
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

  // 删功能包。只认 canvas-flows 目录下的 .json，别的一律拒——删文件这件事宁可窄。
  ctx.web.api(deletePath, async (req: any, res: any) => {
    const { form } = await body(req);
    const slug = String(form.get("slug") ?? "");
    const base = resolve(canvasFlowsDir);
    const target = resolve(base, slug + ".json");
    if (!slug || !target.startsWith(base + "\\") || !/\.json$/i.test(target)) {
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("拒绝：只删 canvas-flows 目录里的 .json");
      return;
    }
    if (!existsSync(target)) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("没有这个功能包：" + slug);
      return;
    }
    try {
      unlinkSync(target);
    } catch (error) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("删除失败：" + String(error));
      return;
    }
    // 来源登记跟着走：包没了，别留一条指向空气的账。
    const imports = await readImports();
    if (Object.prototype.hasOwnProperty.call(imports, slug)) {
      delete imports[slug];
      await saveImports(imports);
    }
    ctx.logger.info(`思维画布桥：删掉功能包 ${slug}`);
    res.writeHead(303, { Location: pagePath });
    res.end();
  });

  // 外部来源：JSON 走注册/更新，表单走设置保存/移除。
  ctx.web.api(providersPath, async (req: any, res: any) => {
    const { form, json } = await body(req);
    const providers = await readProviders();

    if (json && typeof json === "object") {
      const id = safeSlug(String(json.id ?? ""), "");
      if (!id) {
        jsonReply(res, 400, { ok: false, error: "缺 id（来源标识，字母数字下划线减号，最长 60）" });
        return;
      }
      const fields: ProviderField[] = Array.isArray(json.fields)
        ? json.fields
          .filter((field: any) => field && typeof field.key === "string" && field.key)
          .slice(0, 20)
          .map((field: any) => ({
            key: String(field.key).slice(0, 40),
            label: String(field.label ?? field.key).slice(0, 80),
            placeholder: String(field.placeholder ?? "").slice(0, 120),
          }))
        : [];
      const existing = providers.find((item) => item.id === id);
      const next: Provider = {
        id,
        name: String(json.name ?? existing?.name ?? id).slice(0, 80),
        description: String(json.description ?? existing?.description ?? "").slice(0, 300),
        fields: fields.length ? fields : existing?.fields ?? [],
        settings: existing?.settings ?? {},
        addedAt: existing?.addedAt || new Date().toISOString(),
      };
      const merged = existing
        ? providers.map((item) => (item.id === id ? next : item))
        : [...providers, next];
      await saveProviders(merged);
      ctx.logger.info(`思维画布桥：登记来源 ${id}`);
      jsonReply(res, 200, { ok: true, provider: next, created: !existing });
      return;
    }

    const action = String(form.get("action") ?? "save");
    const id = String(form.get("provider") ?? "");
    const existing = providers.find((item) => item.id === id);
    if (!existing) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("没有这个来源：" + id);
      return;
    }
    if (action === "delete") {
      const next = providers.filter((item) => item.id !== id);
      await saveProviders(next);
      // 来源没了，它推的包不替人删——文件是用户的，留给他自己决定。
      res.writeHead(303, { Location: pagePath });
      res.end();
      return;
    }
    const settings: Record<string, string> = { ...existing.settings };
    for (const field of existing.fields) settings[field.key] = String(form.get(`s_${field.key}`) ?? "").slice(0, 300);
    const next = providers.map((item) => (item.id === id ? { ...item, settings } : item));
    await saveProviders(next);
    res.writeHead(303, { Location: pagePath });
    res.end();
  });

  // 别的软件推包过来。校验跟画布一模一样，过不了就不落盘。
  ctx.web.api(importPath, async (req: any, res: any) => {
    const { json } = await body(req);
    if (!json || typeof json !== "object" || Array.isArray(json)) {
      jsonReply(res, 400, { ok: false, error: "请求体得是 JSON 对象，带 provider / name / bundle" });
      return;
    }
    const bundle = json.bundle;
    const problems = inspectBundle(bundle);
    if (problems.length) {
      jsonReply(res, 400, { ok: false, error: "画布不收这个包", problems });
      return;
    }
    const flow = bundle.flows[0];
    const slug = safeSlug(String(json.name ?? flow?.name ?? flow?.id ?? ""), String(flow?.id ?? "flow"));
    if (!slug) {
      jsonReply(res, 400, { ok: false, error: "包名为空，name 或 flows[0].name 至少给一个" });
      return;
    }
    const providerId = safeSlug(String(json.provider?.id ?? ""), "");
    const providerName = String(json.provider?.name ?? providerId).slice(0, 80);
    if (providerId) {
      const providers = await readProviders();
      const known = providers.find((item) => item.id === providerId);
      if (!known) {
        // 没注册就直接推，替他补一条最小的，省得别人还得多打一次。
        await saveProviders([
          ...providers,
          { id: providerId, name: providerName || providerId, description: "", fields: [], settings: {}, addedAt: new Date().toISOString() },
        ]);
      }
    }
    try {
      mkdirSync(canvasFlowsDir, { recursive: true });
      writeFileSync(join(canvasFlowsDir, slug + ".json"), JSON.stringify(bundle, null, 2), { encoding: "utf-8" });
    } catch (error) {
      jsonReply(res, 500, { ok: false, error: "写文件失败：" + String(error) });
      return;
    }
    if (providerId) {
      const imports = await readImports();
      imports[slug] = { provider: providerId, providerName, at: new Date().toISOString() };
      await saveImports(imports);
    }
    ctx.logger.info(`思维画布桥：收到外部功能包 ${slug}（来源 ${providerId || "未署名"}）`);
    jsonReply(res, 200, {
      ok: true,
      slug,
      file: join(canvasFlowsDir, slug + ".json"),
      flowId: String(flow?.id ?? ""),
      provider: providerId,
      note: "已落成画布功能包。去画布点「注册功能」选它，或者下一次刷新页面就列在这里。",
    });
  });

  // 机器可读的接口说明：别的软件先读这个，不用翻 README 猜。
  ctx.web.page(apiPath, async (_req: any, res: any) => {
    const providers = await readProviders();
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify({
      ok: true,
      name: "思维画布桥",
      version: "0.3.0",
      endpoints: {
        list: { method: "GET", path: flowsPath, note: "列出当前可导入的功能包" },
        registerProvider: {
          method: "POST",
          path: providersPath,
          contentType: "application/json",
          body: { id: "来源标识", name: "显示名", description: "一句话", fields: [{ key: "设置键", label: "显示名", placeholder: "提示" }] },
        },
        importFlow: {
          method: "POST",
          path: importPath,
          contentType: "application/json",
          body: { provider: { id: "来源标识", name: "显示名" }, name: "包名", bundle: "功能包（见 template）" },
        },
      },
      template: {
        schemaVersion: 1,
        rootId: "my-flow",
        flows: [{
          id: "my-flow",
          name: "我的流程",
          nodes: [{ id: "n1", type: "comfy_generate", x: 120, y: 120, params: { workflow: "我的工作流.json", prompt: "${prompt}" } }],
          edges: [],
        }],
      },
      rules: {
        schemaVersion: "必须等于 1",
        "flows[].id": "只允许 [A-Za-z0-9_-]，长度 1–80",
        "flows[].nodes": "必须是数组，每个节点要有 id 和 type",
        "nodes[].type": "必须是画布上已存在的工具名",
        "params": "写成 ${参数名} 的会被提升成技能的可填参数",
        edges: "数组，元素是 [起点节点 id, 终点节点 id, 终点参数名]",
      },
      providers: providers.map(({ id, name, fields }) => ({ id, name, fields: fields.map((f) => f.key) })),
    }, null, 2));
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
