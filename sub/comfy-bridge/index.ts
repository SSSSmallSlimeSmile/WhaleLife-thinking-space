/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 *
 * ComfyUI 联动：给思维画布用的生图入口。
 *
 * 三件事想清楚才这么写：
 * 1. 平级子插件：跟 canvas 一样挂在 thinking-space/sub/ 下，启停跟着思维空间，
 *    端口进程那一套一点不沾，只读文件、只回话。
 * 2. 不重复造生图。工作流从《生图》插件的 workflows 目录里读，出图仍然调它的
 *    comfy_generate。这边只解决「画布不知道有哪些工作流」这一个缺口。
 * 3. 生图插件不在，这个插件也不能麻利地消失——不然画布页少一块，用户不知道
 *    为什么。所以它自己照常起来，把「要先装什么」写在页面和工具回执里。
 */
import type { Context } from "whalelife";
import { existsSync, readdirSync, statSync } from "node:fs";
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
const pagePath = "/plugins/thinking-space/comfy-bridge/";
const dataPath = "/plugins/thinking-space/comfy-bridge/workflows";

type Workflow = { name: string; size: number; mtime: string };

function escape(value: unknown) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function html(title: string, body: string) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title>
<style>
:root{--line:rgba(127,127,127,.28);--surface:rgba(127,127,127,.06)}
body{margin:0 auto;padding:28px 22px 60px;max-width:820px;font:15px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
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
</style></head><body><h1>${escape(title)}</h1>${body}</body></html>`;
}

export async function apply(ctx: Context) {
  const installed = () => existsSync(join(comfyDir, "plugin.yaml"));
  const toolReady = () => ctx.tools.list().some((tool: any) => tool.function?.name === "comfy_generate");

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

  function status() {
    const has = installed();
    const ready = toolReady();
    const workflows = has ? readWorkflows() : [];
    const note = !has
      ? "没装《生图》插件（comfy）。装上之后这里才列得出工作流，出图本身也走它。"
      : !ready
        ? "《生图》插件在，但 comfy_generate 还没注册上——多半是它自己没加载成功，去控制台看它的报错。"
        : workflows.length ? "" : "《生图》插件在，但 workflows 目录里没有 .json 工作流。去 ComfyUI 里导出 API 格式，放进那个目录。";
    return { ok: has && ready, installed: has, toolReady: ready, dir: workflowsDir, workflows, note };
  }

  ctx.tools.register({
    name: "comfy_workflow_list", displayName: "列生图工作流", danger: "safe",
    description: "列出生图插件（comfy）里可用的 ComfyUI 工作流文件名与大小，拿来填 comfy_generate 的 workflow。只读，不起任何任务；没装生图插件时也说清要先装什么。",
    schema: { type: "object", properties: {}, additionalProperties: false },
    async run() { return status(); },
  });

  ctx.web.page(pagePath, async (_req: any, res: any) => {
    const current = status();
    const rows = current.workflows.length
      ? current.workflows.map((w) => `<tr><td><code>${escape(w.name)}</code></td><td>${Math.round(w.size / 102.4) / 10} KB</td><td>${escape(w.mtime.slice(0, 19).replace("T", " "))}</td></tr>`).join("")
      : `<tr><td colspan="3" class="muted">没有工作流文件</td></tr>`;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(html("ComfyUI 联动", `
<section class="panel">
  <h2>依赖</h2>
  <p><span class="badge${current.installed ? "" : " warn"}">生图插件：${current.installed ? "已安装" : "没装"}</span><span class="badge${current.toolReady ? "" : " warn"}">comfy_generate：${current.toolReady ? "可用" : "没注册上"}</span></p>
  ${current.note ? `<p class="muted">${escape(current.note)}</p>` : ""}
  <p class="muted">这个子插件只列工作流，不自己出图。出图、看图都走《生图》插件，所以那边缺了这里也不会假装能用。</p>
</section>
<section class="panel">
  <h2>工作流（${current.workflows.length}）</h2>
  <p class="muted">目录：<code>${escape(current.dir)}</code></p>
  <table><thead><tr><th>文件名</th><th>大小</th><th>修改时间</th></tr></thead><tbody>${rows}</tbody></table>
  <p class="muted" style="margin-top:12px">在画布上的用法：放一个 comfy_generate 节点，workflow 填上面某个文件名；留空就用那边默认的。</p>
</section>`));
  }, { title: "ComfyUI 联动" });

  ctx.web.page(dataPath, async (_req: any, res: any) => {
    const current = status();
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(current));
  });

  ctx.logger.info(`ComfyUI 联动：工作流目录 ${workflowsDir}`);
}
