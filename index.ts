/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import type { Context } from "whalelife";
import { dirname, join, resolve } from "node:path";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** 展示用字段：日常版宿主认识 displayName，上游宿主没有。类型上补一次，
 *  运行时原样传过去，不认识的宿主会忽略它，不影响工具本身。 */
declare module "whalelife" {
  interface ToolDefinition<Arguments = Record<string, unknown>, Result = unknown> {
    displayName?: string;
  }
}

/** 工具目录条目的形状由宿主给出。上游宿主没有 catalog()，这里只声明本插件真正读的字段，
 *  缺的那几项按空处理，不假造。 */
type ToolContract = {
  name: string;
  description?: string;
  plugin?: string;
  danger?: string;
  displayName?: string;
  category?: string;
  inputSchema?: Record<string, unknown> | null;
  outputSchema?: Record<string, unknown> | null;
  visibleInputs?: string[];
  visibleOutputs?: string[];
};

const storeFile = "skills.json";
const settingsFile = "settings.json";
const flowsFile = "flows.json";
const localReportFile = "local-report.json";
const paramDefaultsFile = "param-defaults.json";
const pagePath = "/plugins/thinking-space/";
/** 插件目录。子插件的墓碑清扫要按它算路径。 */
const here = dirname(fileURLToPath(import.meta.url));
const defaultSpaceUrl = "http://127.0.0.1:9281/";
const defaultTriggerPhrase = "XXX，你学会了吗？";
const idPattern = /^[a-zA-Z0-9_-]{1,64}$/;
const parameterPattern = /^[\p{L}_][\p{L}\p{N}_-]{0,63}$/u;
const referencePattern = /^([\p{L}\p{N}_-]+)(?:((?:\.[\p{L}_][\p{L}\p{N}_-]*|\[\d+\])+))?$/u;
const types = ["string", "integer", "number", "boolean", "object", "array"] as const;
const dangers = ["safe", "ask", "full"] as const;
type Danger = typeof dangers[number];
type JsonObject = Record<string, unknown>;
type Parameter = { name: string; type: typeof types[number]; required: boolean; aliases?: string[]; label?: string };
type Step = { id: string; tool: string; plugin: string; params: JsonObject; next: string | null };
type Skill = { schemaVersion: 1; id: string; name: string; description: string; kind: "single" | "composite"; params: Parameter[]; steps: Step[]; danger: Danger; revision?: number; useWhen?: string; notFor?: string; outputs?: string };
type Store = { schemaVersion: 1; skills: Skill[] };
type Settings = { observeHands: boolean; allowRiskyChains: boolean; allowSave: boolean; allowUse: boolean; maxSteps: number; autoOrganize: boolean; spaceUrl: string; stepTimeoutSeconds: number; organizeThreshold: number; organizeWindowMinutes: number; autoSaveOrganized: boolean; learnOnRequest: boolean; triggerPhrase: string };

function withTimeout<T>(work: Promise<T>, seconds: number, tool: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`工具 ${tool} 超过 ${seconds} 秒未返回，结果未知。`)), seconds * 1000);
    work.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}
function isEmptyFeed(value: unknown): boolean {
  if (Array.isArray(value)) return value.length === 0;
  if (record(value)) {
    const arrays = Object.values(value).filter(Array.isArray);
    if (arrays.length && arrays.every(item => item.length === 0)) return true;
  }
  return false;
}
function unresolved(value: unknown): boolean {
  if (typeof value === "string") return /\$\{[^{}]+\}/.test(value);
  if (Array.isArray(value)) return value.some(unresolved);
  if (record(value)) return Object.values(value).some(unresolved);
  return false;
}
// 元信息键（$rank 等）不参与「下一步是否已就绪」的判定：可选参数不传时它们会留着占位符
function withoutMeta(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutMeta);
  if (record(value)) {
    const out: JsonObject = {};
    for (const [key, item] of Object.entries(value)) {
      if (key.startsWith("$") && key !== "$try") continue;
      out[key] = withoutMeta(item);
    }
    return out;
  }
  return value;
}
function record(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function validId(value: unknown): value is string {
  return typeof value === "string" && idPattern.test(value) && !unsafeKey(value);
}
function unsafeKey(value: string) {
  return ["__proto__", "constructor", "prototype"].includes(value);
}
function requireText(value: unknown, max: number, label: string, optional = false) {
  if (optional && value === undefined) return "";
  if (typeof value !== "string" || value.length > max || (!optional && !value.trim())) throw new Error(label + "无效。");
  return value.trim();
}
function validateValue(value: unknown, params: Set<string>, previous: Set<string>, depth = 0): void {
  if (depth > 10) throw new Error("参数嵌套过深。");
  if (typeof value === "string") {
    if (!value.includes("${")) return;
    const whole = /^\$\{([^{}]+)\}$/.exec(value);
    const inners = whole ? [whole[1]] : [...value.matchAll(/\$\{([^{}]+)\}/g)].map(m => m[1]);
    if (!inners.length) throw new Error("占位须使用已声明参数或前序步骤字段，例如 ${关键词} 或 ${n1.data.results[0].url}。");
    for (const inner of inners) {
      const path = referencePattern.exec(inner);
      if (!path || path[0].split(/[.\[\]]/).some(unsafeKey) ||
        (path[2] ? !previous.has(path[1]) : !params.has(path[1])))
        throw new Error("占位须使用已声明参数或前序步骤字段，例如 ${关键词} 或 ${n1.data.results[0].url}。");
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) validateValue(item, params, previous, depth + 1);
  } else if (record(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (unsafeKey(key)) throw new Error("参数键无效。");
      validateValue(item, params, previous, depth + 1);
    }
  } else if (value !== null && typeof value !== "boolean" && !(typeof value === "number" && Number.isFinite(value))) {
    throw new Error("参数须为 JSON 值。");
  }
}
function matchesLiteralType(value: unknown, type: unknown): boolean {
  if (record(value) && Array.isArray((value as any).$try)) return true;
  if (Array.isArray(type)) return type.some(item => matchesLiteralType(value, item));
  if (typeof value === "string" && value.startsWith("${")) return true;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return record(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "null") return value === null;
  return !["string", "number", "boolean"].includes(String(type)) || typeof value === type;
}
function dangerFor(steps: Step[], catalog: Map<string, ToolContract>, fallback: Danger): Danger {
  let highest = 0;
  let unknown = false;
  // 存盘的旧值本身也可能坏（手改过、旧版本写歪）。坏值不能当 safe 用，至少按 ask。
  const base: Danger = dangers.includes(fallback) ? fallback : "ask";
  for (const step of steps) {
    const tool = catalog.get(step.tool);
    const declared = tool && dangers.includes(tool.danger as Danger) ? tool.danger as Danger : undefined;
    if (tool && declared === undefined) unknown = true;
    const hazard = declared ?? (!tool && base === "safe" ? "ask" : base);
    highest = Math.max(highest, Math.max(0, dangers.indexOf(hazard)));
    // 写文件、跑命令、发消息、发声这几个：不管工具自己声明什么，都至少按 ask 算。
    // 预检早就这么判了，这里对齐，免得页面不显示确认框、预检又拦下来。
    if (sideEffectTools.has(step.tool)) highest = Math.max(highest, 1);
  }
  if (unknown && highest < 1) return "ask";
  return dangers[highest];
}
function validateSkill(id: unknown, spec: unknown, catalog: Map<string, ToolContract>, maxSteps = 20): Skill {
  if (!validId(id) || !record(spec) || spec.schemaVersion !== 1 || (spec.id !== undefined && spec.id !== id))
    throw new Error("技能 ID 或 schemaVersion 无效。");
  const { kind } = spec;
  if (kind !== "single" && kind !== "composite") throw new Error("kind 须为 single 或 composite。");
  const name = requireText(spec.name, 80, "技能名称");
  const description = requireText(spec.description, 500, "技能说明", true);
  const useWhen = spec.useWhen === undefined ? "" : requireText(spec.useWhen, 300, "适用目标", true);
  const notFor = spec.notFor === undefined ? "" : requireText(spec.notFor, 300, "不适用情形", true);
  const outputs = spec.outputs === undefined ? "" : requireText(spec.outputs, 300, "输出说明", true);
  if (!Array.isArray(spec.params) || spec.params.length > 32) throw new Error("params 须为参数列表，最多 32 项。");
  const declared = new Set<string>();
  const params: Parameter[] = spec.params.map(param => {
    if (!record(param) || typeof param.name !== "string" || !parameterPattern.test(param.name) || unsafeKey(param.name) ||
      declared.has(param.name) || !types.includes(param.type as Parameter["type"]) || typeof param.required !== "boolean")
      throw new Error("技能参数名称、类型或必填状态无效。");
    const rawAliases = param.aliases === undefined ? [] : param.aliases;
    if (!Array.isArray(rawAliases) || rawAliases.length > 6) throw new Error("参数 " + param.name + " 的 aliases 须为数组，最多 6 项。");
    const aliases: string[] = [];
    for (const item of rawAliases) {
      if (typeof item !== "string" || !parameterPattern.test(item) || unsafeKey(item) || item === param.name)
        throw new Error("参数 " + param.name + " 的别名无效。");
      if (declared.has(item) || aliases.includes(item)) throw new Error("参数别名 " + item + " 与已有参数或别名重复。");
      aliases.push(item);
    }
    const label = param.label === undefined ? "" : requireText(param.label, 20, "参数标签", true);
    declared.add(param.name);
    for (const item of aliases) declared.add(item);
    return { name: param.name, type: param.type as Parameter["type"], required: param.required,
      ...(aliases.length ? { aliases } : {}), ...(label ? { label } : {}) };
  });
  if (!Array.isArray(spec.steps) || spec.steps.length < 1 || spec.steps.length > maxSteps ||
    (kind === "single" ? spec.steps.length !== 1 : spec.steps.length < 2)) throw new Error("单步技能须有 1 步，复合技能须有 2–20 步。");
  const chain = spec.steps;
  const previous = new Set<string>();
  const steps: Step[] = chain.map((item, index) => {
    if (!record(item) || !validId(item.id) || previous.has(item.id) || declared.has(item.id)) throw new Error("第 " + (index + 1) + " 步的 ID 无效、重复或与参数重名。");
    const next = index === chain.length - 1 ? null : chain[index + 1]?.id;
    if (item.next !== next) throw new Error(item.id + " 的 next 须指向列表中的下一步，末步须为 null。");
    const tool = typeof item.tool === "string" ? catalog.get(item.tool) : undefined;
    const pluginKnown = typeof tool?.plugin === "string" && tool.plugin !== "";
    if (!tool || (pluginKnown && item.plugin !== undefined && item.plugin !== tool.plugin)) throw new Error(item.id + " 的工具在运行目录中不可用或来源不匹配。");
    if (!record(item.params)) throw new Error(item.id + " 的 params 须为对象。");
    const toolSchema: any = record(tool.inputSchema) ? tool.inputSchema : {};
    const { properties, required, additionalProperties } = toolSchema;
    if (Array.isArray(required) && required.some(key => !Object.hasOwn(item.params as JsonObject, key))) throw new Error(item.id + " 缺少工具必填参数。");
    if (additionalProperties === false && record(properties) && Object.keys(item.params).some(key => !Object.hasOwn(properties, key)))
      throw new Error(item.id + " 含有工具未声明的参数。");
    try { validateValue(item.params, declared, previous); }
    catch (error) { throw new Error(item.id + "：" + (error as Error).message); }
    if (record(properties)) {
      for (const [field, value] of Object.entries(item.params)) {
        const schema = Object.hasOwn(properties, field) ? properties[field] : undefined;
        if (record(schema) && !matchesLiteralType(value, schema.type))
          throw new Error(item.id + " 的参数 " + field + " 类型不匹配。");
      }
    }
    previous.add(item.id);
    return { id: item.id, tool: tool.name, plugin: tool.plugin ?? "", params: item.params, next };
  });
  return { schemaVersion: 1, id, name, description, kind, params, steps, danger: dangerFor(steps, catalog, "full"),
    ...(useWhen ? { useWhen } : {}), ...(notFor ? { notFor } : {}), ...(outputs ? { outputs } : {}) };
}

// ---- 执行器：第二阶段 ----
type RunStatus = "ok" | "empty" | "failed" | "uncertain" | "blocked" | "skipped";
type StepResult = { id: string; tool: string; plugin: string; status: RunStatus; elapsedMs: number; input: unknown; output: unknown; error?: string; attempts?: { value: unknown; status: string; elapsedMs: number; error?: string }[]; tries?: { key: string; hit: number; total: number }[] };
type CutNote = { key: string; kept: unknown; droppedCount: number };
type TrimNote = { from: number; to: number; dropped: { id: string; tool: string; why: string }[]; revision: number; cut?: CutNote[] };
type RelevanceNote = { status: "matched" | "weak" | "unrelated" | "unassessed"; hits: number; terms: number; ratio: number; basis: string };
type RunResult = { status: RunStatus; runId: string; skill: string; steps: StepResult[]; error?: string; trimmed?: TrimNote; trimSuggestion?: TrimNote; relevance?: RelevanceNote };

// 已知会动外部世界的工具：写盘、跑命令、发消息、发图、发声、出图。
// 名单不完备时仍要靠工具自己声明的 danger；这里只把「名字我们认得出」的那些兜住。
const sideEffectTools = new Set([
  "hands_write", "hands_run",
  "qq_send_image", "qq_send_meme", "qq_send_message", "bilibili_share_qq",
  "mouth_say", "speak",
  "comfy_generate",
  "space_skill_save",
]);

function pick(value: unknown, path: string[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number(key);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
    } else if (record(current)) {
      current = (current as JsonObject)[key];
    } else return undefined;
  }
  return current;
}

function fill(value: unknown, params: JsonObject, previous: Map<string, unknown>): unknown {
  if (typeof value === "string") {
    const whole = /^\$\{([^{}]+)\}$/.exec(value);
    if (whole) {
      const parts = whole[1].trim().split(/[.\[\]]+/).filter(Boolean);
      const source = previous.has(parts[0]) ? previous.get(parts[0]) : params[parts[0]];
      const resolved = pick(source, parts.slice(1));
      return resolved === undefined ? value : resolved;
    }
    if (!value.includes("${")) return value;
    return value.replace(/\$\{([^{}]+)\}/g, (origin, inner) => {
      const parts = String(inner).trim().split(/[.\[\]]+/).filter(Boolean);
      const source = previous.has(parts[0]) ? previous.get(parts[0]) : params[parts[0]];
      const resolved = pick(source, parts.slice(1));
      return resolved === undefined ? origin : String(resolved);
    });
  }
  if (Array.isArray(value)) return value.map(item => fill(item, params, previous));
  if (record(value)) {
    const out: JsonObject = {};
    for (const [key, item] of Object.entries(value)) out[key] = fill(item, params, previous);
    return out;
  }
  return value;
}

// 把参数里的 {"$try":[...]} 展开成若干份候选输入，按顺序试，第一个成功即采用。
function expandTry(input: JsonObject, rank?: number): JsonObject[] {
  const keys: { key: string; list: unknown[] }[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (record(value) && Array.isArray((value as any).$try)) keys.push({ key, list: (value as any).$try });
  }
  if (!keys.length) return [input];
  const len = Math.max(...keys.map(item => item.list.length));
  const out: JsonObject[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < len; i++) {
    if (rank !== undefined && i !== rank - 1) continue;
    const copy: JsonObject = { ...input };
    let usable = true;
    for (const item of keys) {
      const pick = item.list[Math.min(i, item.list.length - 1)];
      if (typeof pick === "string" && pick.includes("${")) { usable = false; break; }
      if (pick === undefined || pick === null || pick === "") { usable = false; break; }
      copy[item.key] = pick;
    }
    delete (copy as any).$rank;
    if (!usable) continue;
    // 同一次任务里同一个候选只读一次：链接重复的候选直接跳过
    const fingerprint = JSON.stringify(keys.map(item => copy[item.key]));
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    out.push(copy);
  }
  return out;
}

// 排名直取：步骤参数写成 { "$try": [...], "$rank": "${resultRank}" }
// 给定排名就只试那一条；越界、不是整数、缺参数各有明确原因。
function resolveRank(input: JsonObject): { rank?: number; total?: number; error?: string } {
  let rank: number | undefined;
  let total: number | undefined;
  for (const value of Object.values(input)) {
    if (!record(value) || !Object.hasOwn(value, "$rank")) continue;
    const raw = (value as any).$rank;
    if (typeof raw === "string" && raw.includes("${")) continue;
    if (raw === null || raw === undefined || raw === "") continue;
    const num = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isInteger(num)) return { error: "参数 resultRank 必须是整数，从 1 开始。" };
    const list = Array.isArray((value as any).$try) ? (value as any).$try : [];
    if (num < 1) return { error: "参数 resultRank 从 1 开始，不能小于 1。" };
    if (num > list.length) return { error: "排名越界：resultRank=" + num + "，这次只有 " + list.length + " 条候选。" };
    rank = num;
    total = num > 0 ? list.length : total;
  }
  return { rank, total };
}

// 字面相关性：把查询拆成词，看正文里命中几个。不判断语义，只报"出现了多少"。
// 目的是把"读到了"和"读到的东西和问题有关"分开，不是给内容打分。
function queryTerms(query: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (term: string) => {
    const clean = term.trim().toLowerCase();
    if (clean.length < 2 || seen.has(clean)) return;
    seen.add(clean);
    out.push(clean);
  };
  // 连写的中日韩文字：取整段（短）与相邻二字（长），不要单字，单字命中没意义
  for (const run of query.match(/[\u3400-\u9fff\uf900-\ufaff]{2,}/g) ?? []) {
    if (run.length <= 4) push(run);
    for (let i = 0; i + 2 <= run.length; i += 2) push(run.slice(i, i + 2));
  }
  for (const word of query.match(/[A-Za-z0-9][A-Za-z0-9._-]+/g) ?? []) push(word);
  return out.slice(0, 12);
}

function checkRelevance(query: string | undefined, output: unknown): RelevanceNote | null {
  if (!query || query.trim().length < 2 || output === null || output === undefined) return null;
  const terms = queryTerms(query);
  if (!terms.length) return null;
  const content = textLeaves(output).join("\n").toLowerCase();
  if (!content) return null;
  const hits = terms.filter(term => content.includes(term)).length;
  const ratio = hits / terms.length;
  const status: RelevanceNote["status"] = ratio >= 0.5 ? "matched" : ratio > 0 ? "weak" : "unrelated";
  return {
    status, hits, terms: terms.length, ratio: Number(ratio.toFixed(2)),
    basis: "按字面词重合判断，不是语义判断；查询词 " + hits + "/" + terms.length + " 出现在读到的正文里。",
  };
}

function namesOf(param: Parameter): string[] {
  return [param.name, ...(param.aliases ?? [])];
}
function pickParam(skill: Skill, given: JsonObject): JsonObject {
  const out: JsonObject = { ...given };
  for (const param of skill.params) {
    if (Object.hasOwn(given, param.name)) continue;
    const hit = (param.aliases ?? []).find(item => Object.hasOwn(given, item));
    if (hit !== undefined) out[param.name] = given[hit];
  }
  return out;
}
// 工具把失败写在正文里、宿主 ok 仍是 true 的情况（例如服务没起、资源不够）。
// 只认两类：明确的资源/服务状态词（可稍长），以及短句里的通用错误词（防止长正文误判）。
const FAIL_STRONG = /没在跑|不在运行|未启动|没启动|已停止|显存不够|显存不足|内存不够|内存不足|低于阈值|超过上限|请先启动|需要先启动/;
const FAIL_WEAK = /失败|错误|无法|找不到|拒绝|不支持|error|failed|denied|insufficient|not running|unavailable/i;

function textLeaves(value: unknown, depth = 0, out: string[] = []): string[] {
  if (out.length >= 40 || depth > 4) return out;
  if (typeof value === "string") {
    const text = value.trim();
    if (text) out.push(text.slice(0, 400));
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 20)) textLeaves(item, depth + 1, out);
    return out;
  }
  if (record(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (key === "ok" || key === "status") continue;
      textLeaves(item, depth + 1, out);
    }
    return out;
  }
  return out;
}

function smellBusinessFailure(output: unknown): string | null {
  for (const text of textLeaves(output)) {
    if (FAIL_STRONG.test(text)) return "工具返回：" + text.slice(0, 160);
    if (text.length <= 60 && FAIL_WEAK.test(text)) return "工具返回：" + text.slice(0, 160);
  }
  return null;
}

function dependents(skill: Skill, stepId: string): string[] {
  const index = skill.steps.findIndex(item => item.id === stepId);
  if (index < 0) return [];
  return skill.steps.slice(index + 1)
    .filter(item => JSON.stringify(item.params ?? {}).includes("${" + stepId))
    .map(item => item.id);
}
function missingParams(skill: Skill, given: JsonObject): string[] {
  return skill.params.filter(param => param.required && !namesOf(param).some(name => Object.hasOwn(given, name))).map(param => param.name);
}

function escape(value: unknown) {
  const chars: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return String(value ?? "").replace(/[&<>"']/g, char => chars[char]);
}
function html(title: string, body: string) {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)}</title>
<link rel="stylesheet" href="/ui/styles.css">
<style>
.space-toolbar{display:flex;justify-content:flex-start;gap:10px;margin-bottom:16px}
.space-secondary{display:inline-flex;align-items:center;padding:10px 18px;border:1px solid var(--line);border-radius:9px;background:var(--surface);color:inherit;text-decoration:none;font-size:14px;font-weight:600}
.space-secondary.strong{border-color:var(--accent);background:var(--accent);color:#fff;font-weight:700;box-shadow:0 4px 14px rgba(97,88,217,.28)}
.space-secondary.strong:hover{background:#3d2f9c}
.space-secondary.teal{border-color:rgba(50,139,109,.55);background:rgba(50,139,109,.14);color:#2f8f6d;font-weight:700}
.space-secondary.teal:hover{background:rgba(50,139,109,.24)}
.space-rules{margin:14px 0 0;padding:12px 14px;border:1px solid var(--line);border-radius:10px;background:rgba(127,127,127,.05)}.space-rules h3{margin:0 0 8px;font-size:13px;letter-spacing:.04em;color:var(--ink);opacity:.75}.space-rules ol{margin:0;padding-left:20px;font-size:13px;line-height:1.75}.space-rules li{margin:2px 0}.space-rules strong{font-weight:600}.space-panel{background:var(--surface)}
.space-panel form>p{margin-bottom:24px}
.space-panel form{display:block}
.space-wrap{max-width:1080px;margin:0 auto;padding:20px 24px 72px}
.space-panel{border:1px solid var(--line);border-radius:14px;padding:18px 20px;margin:0 0 14px;background:var(--surface)}
.space-panel>h2{margin:0 0 12px;padding-bottom:10px;font-size:15px;font-weight:700;letter-spacing:.2px;border-bottom:1px solid var(--line)}
.space-panel>p{margin:0 0 10px;line-height:1.65}
.space-panel>p:last-child{margin-bottom:0}
.space-notice{margin:0 0 16px;padding:10px 14px;border-radius:10px;font-size:14px;font-weight:600;line-height:1.55}
.space-notice.ok{border:1px solid rgba(46,160,90,.4);background:rgba(46,160,90,.1);color:#1f7a45}
.space-notice.err{border:1px solid rgba(210,70,70,.4);background:rgba(210,70,70,.1);color:#b03a3a}
.space-edit-list{margin:10px 0 18px;padding-left:0;list-style:none}
.space-edit-row{border:1px solid rgba(127,127,127,.2);border-radius:10px;padding:12px 14px;margin:0 0 12px}
.space-edit-row p{margin:0 0 8px}
.space-edit-row textarea{width:100%;box-sizing:border-box;padding:9px 12px;border-radius:8px;border:1px solid rgba(127,127,127,.35);background:transparent;color:inherit;font:13px/1.5 ui-monospace,Consolas,monospace;resize:vertical}
.space-edit-row textarea:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px rgba(97,88,217,.12)}
.space-edit-ops{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:10px 0 0}
.space-edit-ops .btn{padding:6px 14px;font-size:13px}
.space-edit-add{border:1px dashed rgba(127,127,127,.35);border-radius:10px;padding:12px 14px;margin:0 0 6px}
.space-edit-add legend{padding:0 6px;font-size:13px;font-weight:650}
.space-edit-add label{margin:0 0 12px}
.space-edit-add label:last-of-type{margin-bottom:0}
.space-edit-add input[type=text]{max-width:none}
.space-edit-add textarea{width:100%;box-sizing:border-box;padding:9px 12px;border-radius:8px;border:1px solid rgba(127,127,127,.35);background:transparent;color:inherit;font:13px/1.5 ui-monospace,Consolas,monospace;resize:vertical}
.space-edit-add textarea:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px rgba(97,88,217,.12)}
.space-panel label{display:block;margin:0 0 14px;font-weight:600;font-size:14px}
.space-panel label textarea{margin-top:6px}
.space-muted{color:var(--muted);font-size:13px;line-height:1.6}
.space-panel table{width:100%;border-collapse:collapse;font-size:13px;text-align:left}
.space-panel table th{font-weight:600;font-size:12px;letter-spacing:.04em;opacity:.7;padding:8px 10px;border-bottom:1px solid var(--line)}
.space-panel table td{padding:10px;border-bottom:1px solid rgba(127,127,127,.15);vertical-align:top}
.space-panel table tr:last-child td{border-bottom:none}.space-lede{font-size:13.5px;line-height:1.75;max-width:860px;margin:0 0 14px;opacity:.85}.space-lede:last-of-type{margin-bottom:10px}.space-toolbar{margin:14px 0 18px}.space-list{margin:0 0 14px;padding-left:20px;font-size:13px;line-height:1.7}.space-panel table th:nth-child(2),.space-panel table td:nth-child(2){width:84px;white-space:nowrap}.space-panel table th:nth-child(3),.space-panel table td:nth-child(3){width:250px}.space-panel table th:last-child,.space-panel table td:last-child{width:1%;white-space:nowrap;text-align:right}.space-panel table td:last-child button{margin-left:6px;margin-bottom:4px}.space-panel table td:last-child button:first-child{margin-left:0}.space-empty{opacity:.55;padding:16px 10px}.space-panel button{padding:7px 14px;border-radius:8px;border:1px solid rgba(127,127,127,.4);background:transparent;color:inherit;font:inherit;font-size:13px;cursor:pointer}.space-panel button:hover{border-color:var(--accent);color:var(--accent)}.space-panel button[data-delete]{border-color:rgba(200,60,60,.45);color:#c0392b}.space-panel button[data-delete]:hover{background:rgba(200,60,60,.08);border-color:rgba(200,60,60,.8)}.space-panel pre#report{margin:16px 0 0;padding:12px 14px;border-radius:10px;background:rgba(127,127,127,.07);border:1px solid var(--line);font-size:12px;line-height:1.6;min-height:0;max-height:280px;overflow:auto;white-space:pre-wrap}.space-panel pre#report:empty{display:none}
.space-panel table .badge{margin-right:6px}
#report{margin:16px 0 0;padding:12px 14px;border:1px solid var(--line);border-radius:12px;background:rgba(127,127,127,.06);font-family:ui-monospace,Consolas,monospace;font-size:12.5px;line-height:1.6;white-space:pre-wrap;word-break:break-all;max-height:420px;overflow:auto}
#report:empty{display:none}
button[data-delete]{border-color:rgba(200,80,80,.5);color:#c05555}
.space-open{display:inline-flex;align-items:center;gap:8px;padding:12px 24px;border-radius:10px;background:var(--accent);color:#fff!important;text-decoration:none;font-weight:700;font-size:17px;letter-spacing:.02em;box-shadow:0 4px 14px rgba(97,88,217,.28)}
.space-open:hover{background:#3d2f9c}
.space-row{display:inline-flex;align-items:center;gap:10px;flex-wrap:wrap}
.space-check{display:flex;gap:10px;align-items:flex-start;margin:0 0 4px;font-weight:650;font-size:15px;line-height:1.5}
.space-check input{margin:6px 0 0;flex:none}
.space-field{margin:18px 0 4px;font-weight:650;font-size:15px}
.space-panel input[type=number],.space-panel input[type=text]{padding:9px 12px;border-radius:8px;border:1px solid rgba(127,127,127,.35);background:transparent;color:inherit;font:inherit}
.space-panel input[type=number]{width:88px}
.space-panel input[type=text]{width:100%;max-width:420px;box-sizing:border-box}
.space-panel input:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px rgba(97,88,217,.12)}
.space-save{margin-top:20px;padding:9px 20px;border-radius:9px;border:1px solid var(--accent);background:var(--accent);color:#fff;font-weight:600;font-size:14px;cursor:pointer}
.space-save:hover{background:#3d2f9c}
.space-card{border:1px solid rgba(127,127,127,.2);border-radius:12px;padding:14px 16px;margin:0 0 12px}
.space-card:last-child{margin-bottom:0}
    .space-card-ops{margin:10px 0 4px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
    .space-card-ops form{display:inline-flex;margin:0}
    .space-card-ops .space-secondary{padding:6px 14px;font-size:13px}
    .space-trend-tabs{display:flex;gap:6px;margin:0 0 12px}
    .space-trend-tabs a{padding:5px 12px;border-radius:8px;border:1px solid var(--line);font-size:13px;text-decoration:none;color:inherit}
    .space-trend-tabs a.on{background:var(--accent);border-color:var(--accent);color:#fff}
    .space-bars{display:flex;align-items:flex-end;gap:4px;height:96px;padding:6px 0 0;overflow-x:auto}
    .space-bar{flex:1 1 0;min-width:10px;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;gap:2px}
    .space-bar-ok{width:100%;background:#328b6d;border-radius:3px 3px 0 0}
    .space-bar-fail{width:100%;background:#bf5762;border-radius:3px 3px 0 0}
    .space-bar>span{font-size:10px;opacity:.6;white-space:nowrap}
    .space-trend-table{width:100%;border-collapse:collapse;margin-top:10px;font-size:13px}
    .space-trend-table th,.space-trend-table td{text-align:left;padding:5px 8px;border-bottom:1px solid var(--line)}
    .space-trend-table th{font-weight:600;opacity:.75;font-size:12px}
    .space-trend-table td:not(:first-child){text-align:right}
.space-card h3{margin:0 0 6px;font-size:15px;font-weight:650}
.space-card p{margin:0 0 8px;line-height:1.6}
.space-badge{display:inline-flex;align-items:center;gap:5px;padding:3px 8px;border-radius:5px;font-size:11px;font-weight:500;white-space:nowrap;background:rgba(127,127,127,.1);color:inherit;opacity:.72;margin:0 6px 0 0;line-height:1.5}
.space-badge.ok{color:#328b6d;background:#eaf7f0}
.space-badge.warn{color:#a8771b;background:#fdf4e6}
.space-badge.err{color:#bf5762;background:#fceff0}
.space-steps{margin:8px 0 0;padding-left:20px}
.space-steps li{margin:8px 0}
.space-steps pre{white-space:pre-wrap;overflow-wrap:anywhere;background:rgba(127,127,127,.08);padding:8px 10px;border-radius:6px;margin:4px 0 0;font-size:12.5px;line-height:1.5}
.space-card summary{cursor:pointer;font-size:13.5px;color:var(--accent);margin-top:2px}
.space-empty{margin:0;color:var(--muted);font-size:14px}
.space-hints p{margin:0 0 8px;color:#a8661b;line-height:1.6}
.space-hints p:last-child{margin-bottom:0}
.space-panel .space-run{display:flex;flex-wrap:wrap;gap:10px 14px;align-items:flex-end;margin:12px 0 0;border-top:1px dashed rgba(127,127,127,.3);padding-top:12px}
    .space-run label{min-width:0}
    .space-run .space-save{margin-left:auto}
.space-run label{display:flex;flex-direction:column;gap:5px;font-size:13px;font-weight:600}
.space-run input[type=text],.space-run input[type=number]{padding:7px 10px;border-radius:8px;border:1px solid rgba(127,127,127,.35);background:transparent;color:inherit;font:inherit;font-size:13.5px;width:170px;box-sizing:border-box}
    .space-run input[type=text]{width:230px}
.space-run input:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px rgba(97,88,217,.12)}
.space-run button{margin-top:0}
.space-run-flag{display:flex;flex-direction:row;align-items:center;gap:7px;font-size:13px;font-weight:600;padding-bottom:8px}
</style>
<div class="space-wrap">${body}</div><script>(function(){fetch("/api/status",{credentials:"same-origin"}).then(function(r){return r.ok?r.json():null}).then(function(j){var v=j&&j.personaName;if(!v)return;v=String(v).replace(/[（(][^）)]*[）)]/g,"").trim()||String(v);var list=document.querySelectorAll("[data-persona]");for(var i=0;i<list.length;i++)list[i].textContent=v;}).catch(function(){});})();</script></html>`;
}
function organizeNote(saved: number, scanned: number, threshold: number, skipped = 0): string {
  if (!Number.isFinite(saved) || saved < 0) return "整理没有跑成。";
  const head = "扫了 " + (Number.isFinite(scanned) ? scanned : 0) + " 条工具调用记录，";
  const tail = skipped > 0 ? "另有 " + skipped + " 组链跳过（含需要确认的工具或已失效的工具）。" : "";
  if (saved > 0) return head + "新存了 " + saved + " 条技能，在下面直接跑。" + tail;
  if (skipped > 0) return head + "没有可自动保存的链；跳过了 " + skipped + " 组（含需要确认的工具或已失效的工具）。";
  return head + "没找到重复够 " + (threshold > 0 ? threshold : 3) + " 次的工具链，这次没有新技能。";
}
const REASON_LABEL: Record<string, string> = {
  input: "参数", timeout: "超时", external: "外部", empty: "无结果",
  skipped: "跳过", cancelled: "取消", blocked: "拦下", other: "其他",
};
type RunLog = { at: string; skill: string; status: RunStatus; source: "user" | "self" | "page" | "chat" };
function dayKeyOf(date: Date) {
  return date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0");
}
function renderTrend(runs: RunLog[], days: number, skills: { id: string; name: string }[]): string {
  const names = new Map(skills.map(skill => [skill.id, skill.name]));
  const now = new Date();
  const buckets = new Map<string, { ok: number; failed: number }>();
  for (let back = days - 1; back >= 0; back -= 1) {
    const day = new Date(now); day.setDate(day.getDate() - back);
    buckets.set(dayKeyOf(day), { ok: 0, failed: 0 });
  }
  const perSkill = new Map<string, { ok: number; failed: number }>();
  let ok = 0, failed = 0, older = 0;
  for (const run of runs) {
    const stamp = Date.parse(run.at);
    if (!Number.isFinite(stamp)) continue;
    const bucket = buckets.get(dayKeyOf(new Date(stamp)));
    if (!bucket) { older += 1; continue; }
    const item = perSkill.get(run.skill) ?? { ok: 0, failed: 0 };
    if (run.status === "ok") { bucket.ok += 1; item.ok += 1; ok += 1; }
    else { bucket.failed += 1; item.failed += 1; failed += 1; }
    perSkill.set(run.skill, item);
  }
  const total = ok + failed;
  const rate = total ? Math.round(ok / total * 100) : 0;
  const peak = Math.max(1, ...Array.from(buckets.values()).map(item => item.ok + item.failed));
  const bars = Array.from(buckets.entries()).map(([key, item]) => {
    const all = item.ok + item.failed;
    const height = all ? Math.max(6, Math.round(all / peak * 62)) : 2;
    const okHeight = all ? Math.round(height * item.ok / all) : 0;
    const title = key + "：成功 " + item.ok + " · 失败 " + item.failed;
    return `<div class="space-bar" title="${escape(title)}"><div class="space-bar-fail" style="height:${height - okHeight}px"></div><div class="space-bar-ok" style="height:${okHeight}px"></div><span>${escape(key.slice(5).replace("-", "/"))}</span></div>`;
  }).join("");
  const rows = Array.from(perSkill.entries())
    .sort((a, b) => (b[1].ok + b[1].failed) - (a[1].ok + a[1].failed))
    .map(([id, item]) => {
      const all = item.ok + item.failed;
      return `<tr><td>${escape(names.get(id) ?? id)}</td><td>${all}</td><td>${item.ok}</td><td>${item.failed}</td><td>${Math.round(item.ok / all * 100)}%</td></tr>`;
    }).join("");
  const tab = (value: number, label: string) => `<a href="?days=${value}"${value === days ? ' class="on"' : ""}>${label}</a>`;
  return `<section class="space-panel"><h2>使用趋势</h2>
  <div class="space-trend-tabs">${tab(1, "今天")}${tab(7, "近 7 天")}${tab(30, "近 30 天")}</div>
  <p class="space-muted">这段时间跑了 ${total} 次，成功 ${ok} 次，成功率 ${rate}%。${older ? "更早的 " + older + " 次没算进来。" : ""}每次运行都会记一条，从这张表启用那天起累积。</p>
  <div class="space-bars">${bars}</div>
  ${rows ? `<table class="space-trend-table"><thead><tr><th>技能</th><th>次数</th><th>成功</th><th>失败</th><th>成功率</th></tr></thead><tbody>${rows}</tbody></table>` : `<p class="space-muted">这段时间没有跑过技能。</p>`}
  </section>`;
}
function renderUsage(skills: any[], stats: Record<string, { runs?: number; sources?: { chat?: number; page?: number; user?: number; self?: number } }>, calls: { name: string }[]): string {
  const runs = Object.values(stats).reduce((sum, item) => sum + (item.runs ?? 0), 0);
  const chat = Object.values(stats).reduce((sum, item) => sum + (item.sources?.chat ?? 0), 0);
  const page = Object.values(stats).reduce((sum, item) => sum + (item.sources?.page ?? 0), 0);
  const byUser = Object.values(stats).reduce((sum, item) => sum + (item.sources?.user ?? 0), 0);
  const bySelf = Object.values(stats).reduce((sum, item) => sum + (item.sources?.self ?? 0), 0);
  const cover = new Map<string, string>();
  for (const skill of skills) for (const step of skill.steps ?? []) if (step?.tool && !cover.has(step.tool)) cover.set(step.tool, String(skill.name ?? skill.id));
  const counts = new Map<string, number>();
  let covered = 0;
  for (const call of calls) {
    counts.set(call.name, (counts.get(call.name) ?? 0) + 1);
    if (cover.has(call.name)) covered += 1;
  }
  const top = [...counts.entries()].filter(([name]) => cover.has(name)).sort((a, b) => b[1] - a[1]).slice(0, 3);
  const pct = calls.length ? Math.round(covered / calls.length * 100) : 0;
  const lines = [
    "技能累计跑过 " + runs + " 次 · 用户点名 " + byUser + " 次 · 主动选择 " + bySelf + " 次 · 页面 " + page + " 次" + (chat ? " · 旧记录 " + chat + " 次（未分类）" : "") + "。",
    calls.length
      ? "最近 " + calls.length + " 次工具调用里，" + covered + " 次（" + pct + "%）用的是已有技能里出现过的工具。"
      : "还没有工具调用记录。",
    ...top.map(([name, n]) => "最常手调：" + name + " " + n + " 次，已有技能「" + cover.get(name) + "」可以替代。"),
  ];
  return `<section class="space-panel"><h2>利用率</h2>${lines.map(line => `<p class="space-muted">${escape(line)}</p>`).join("")}</section>`;
}
function renderSkills(
  skills: (ReturnType<typeof summarize> & {
    runs?: number; lastStatus?: RunStatus; okCount?: number; failedCount?: number;
    lastAt?: string; reasons?: Record<string, number>;
  })[],
  hints: string[] = [],
) {
  const hintPanel = hints.length
    ? `<section class="space-panel space-hints"><h2>该看一眼的</h2>${hints
        .map((hint) => `<p>${escape(hint)}</p>`)
        .join("")}</section>`
    : "";
  return hintPanel + (["single", "composite"] as const).map(kind => {
    const items = skills.filter(skill => skill.kind === kind);
    const cards = items.map(skill => {
      const dangerClass = skill.danger === "safe" ? "ok" : skill.danger === "ask" ? "warn" : "err";
      const statusClass = skill.status === "仅声明" ? "" : skill.status === "已跑通" ? "ok" : skill.status === "上次失败" ? "warn" : "err";
      const fields = skill.params.map(param => {
        const numeric = param.type === "integer" || param.type === "number";
        return `<label>${escape(param.label ?? param.name)}${param.required ? "（必填）" : ""}<input name="p:${escape(param.name)}" type="${numeric ? "number" : "text"}"${param.required ? " required" : ""} placeholder="${numeric ? "例如 2" : "输入" + escape(param.label ?? "内容")}"></label>`;
      }).join("");
      const runForm = `<form method="post" action="/plugins/thinking-space/run" class="space-run">
      <input type="hidden" name="id" value="${escape(skill.id)}">
      ${fields}
      ${skill.danger === "safe" ? "" : `<label class="space-run-flag"><input type="checkbox" name="confirmSideEffects"> 允许副作用步骤</label>`}
      <button class="space-save" type="submit">跑一次</button>
    </form>`;
      const statsLine = typeof skill.runs === "number" && skill.runs > 0
        ? (() => {
            const rate = Math.round((skill.okCount ?? 0) / skill.runs * 100);
            const reasons = Object.entries(skill.reasons ?? {})
              .filter(([, n]) => Number(n) > 0)
              .sort((a, b) => Number(b[1]) - Number(a[1]))
              .slice(0, 2)
              .map(([key, n]) => (REASON_LABEL[key] ?? key) + " " + n);
            const when = skill.lastAt ? new Date(skill.lastAt).toLocaleString("zh-CN", { hour12: false }) : "";
            return `<p class="space-muted">成功 ${skill.okCount ?? 0} / ${skill.runs}（${rate}%）${when ? " · 上次 " + escape(when) : ""}${reasons.length ? " · 失败原因：" + escape(reasons.join("、")) : ""}</p>`;
          })()
        : `<p class="space-muted">还没跑过，没有统计数据。</p>`;
      return `<article class="space-card">
      <h3>${escape(skill.name)}</h3>
      ${skill.description ? `<p>${escape(skill.description)}</p>` : ""}
      <p><span class="space-badge">${skill.stepCount} 步</span><span class="space-badge ${dangerClass}">${escape(skill.danger)}</span><span class="space-badge ${statusClass}">${escape(skill.status)}</span>${
        typeof skill.runs === "number"
          ? `<span class="space-badge ${skill.lastStatus === "ok" ? "ok" : "warn"}">跑过 ${skill.runs} 次${skill.lastStatus === "ok" ? "" : " · 上次 " + escape(String(skill.lastStatus))}</span>`
          : `<span class="space-badge">还没跑过</span>`
      }${skill.sources && (skill.sources.user || skill.sources.self || skill.sources.page || skill.sources.chat) ? `<span class="space-badge">${[skill.sources.user ? "用户 " + skill.sources.user : "", skill.sources.self ? "自主 " + skill.sources.self : "", skill.sources.page ? "页面 " + skill.sources.page : "", skill.sources.chat ? "旧记录 " + skill.sources.chat : ""].filter(Boolean).join(" · ")}</span>` : ""}${skill.revision ? `<span class="space-badge">rev ${skill.revision}</span>` : ""}<span class="space-muted">${escape(skill.id)}</span></p>
      ${statsLine}
      <div class="space-card-ops"><a class="btn space-secondary" href="/plugins/thinking-space/edit?id=${escape(skill.id)}">编辑步骤</a>
      <form method="post" action="/plugins/thinking-space/delete" onsubmit="return confirm('删掉「${escape(skill.name)}」？这条技能的统计和待确认建议也会一起清掉，删了找不回来。')">
      <input type="hidden" name="id" value="${escape(skill.id)}">
      <button class="btn space-secondary" type="submit" style="color:#b3261e;border-color:#b3261e55">删除技能</button>
      </form></div>
      <details><summary>看步骤与参数</summary>
      <p class="space-muted">输入参数：${escape(skill.params.map(param => (param.label ?? param.name) + " · " + param.type + (param.required ? " · 必填" : "") + (param.aliases?.length ? " · 别名 " + param.aliases.join("/") : "")).join("，") || "无")}</p>
      <ol class="space-steps">${skill.steps.map(step => `<li><code>${escape(step.id)}</code> · ${escape(step.plugin)} / ${escape(step.tool)}${step.available ? "" : " · <strong>工具不可用</strong>"}<pre>${escape(JSON.stringify(step.params, null, 2))}</pre></li>`).join("")}</ol>
      </details>${runForm}</article>`;
    }).join("");
    const hint = kind === "single"
      ? "单步技能：调一次工具。适合查询、取数、发消息这类一下就能完的事。"
      : "复合技能：多步串成一条链，一次调用就能跑完，中间不用多轮推理。";
    return `<section class="space-panel"><h2>${kind === "single" ? "功能库" : "复合功能库"}</h2>
    <p class="space-muted" style="margin-bottom:14px">${hint}</p>
    ${cards || `<p class="space-empty">还没有${kind === "single" ? "功能" : "复合功能"}技能。</p>`}</section>`;
  }).join("");
}
function referenceErrors(steps: any[], declared: Set<string>): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  steps.forEach((step, index) => {
    const text = JSON.stringify(step.params ?? {});
    for (const match of text.matchAll(/\$\{([^{}]+)\}/g)) {
      const head = String(match[1]).trim().split(/[.[\]]+/)[0];
      if (!head || declared.has(head) || seen.has(head)) continue;
      errors.push("第 " + (index + 1) + " 步（" + step.id + "）引用了 ${" + head + "}，但它在后面，运行时取不到值。");
    }
    seen.add(step.id);
  });
  return errors;
}

function renderEdit(skill: any, tools: string[], notice: string, ok: boolean) {
  const rows = skill.steps.map((step: any, index: number) => `<li class="space-edit-row">
  <p><code>${escape(step.id)}</code> · ${escape(step.plugin)} / ${escape(step.tool)} <span class="space-muted">第 ${index + 1} 步</span></p>
  <textarea name="params:${escape(step.id)}" rows="4" spellcheck="false">${escape(JSON.stringify(step.params, null, 2))}</textarea>
  <p class="space-edit-ops">
  <button class="btn space-secondary" name="op" value="up:${escape(step.id)}"${index === 0 ? " disabled" : ""}>上移</button>
  <button class="btn space-secondary" name="op" value="down:${escape(step.id)}"${index === skill.steps.length - 1 ? " disabled" : ""}>下移</button>
  <button class="btn space-secondary" name="op" value="del:${escape(step.id)}">删除</button>
  </p></li>`).join("");
  const options = tools.map(name => `<option value="${escape(name)}"></option>`).join("");
  const banner = notice ? `<p class="space-notice ${ok ? "ok" : "err"}">${escape(notice)}</p>` : "";
  return `<div class="space-toolbar"><a class="btn space-secondary" href="/plugins/thinking-space/space">← 返回技能列表</a></div>
  ${banner}
  <section class="space-panel"><h2>编辑：${escape(skill.name)}</h2>
  <p class="space-muted">技能 ID ${escape(skill.id)} · ${escape(skill.kind)} · 保存时会重新核对引用和工具可用性。参数里用 \${n1.字段} 引用前面步骤的输出。</p>
  <form method="post" action="/plugins/thinking-space/edit">
  <input type="hidden" name="id" value="${escape(skill.id)}">
  <label>名称<input name="name" value="${escape(skill.name)}" maxlength="80"></label>
  <label>说明<input name="description" value="${escape(skill.description)}" maxlength="500"></label>
  <ol class="space-steps space-edit-list">${rows}</ol>
  <fieldset class="space-edit-add"><legend>新增一步</legend>
  <label>工具<input name="add_tool" list="space-tools" placeholder="surf_search" autocomplete="off"><datalist id="space-tools">${options}</datalist></label>
  <label>参数（JSON）<textarea name="add_params" rows="3" spellcheck="false">{}</textarea></label>
  </fieldset>
  <p class="space-edit-ops"><button class="btn space-secondary" name="op" value="add">加进去</button>
  <button class="space-save" name="op" value="save">保存技能</button></p>
  </form>
  <script>(function(){function fit(t){t.style.height="auto";t.style.height=(t.scrollHeight+2)+"px";}document.querySelectorAll("textarea").forEach(function(t){fit(t);t.addEventListener("input",function(){fit(t);});});})();</script>
  </section>`;
}

const runBadge: Record<string, string> = { ok: "ok", empty: "warn", failed: "err", uncertain: "warn", blocked: "warn", cancelled: "warn", skipped: "warn" };
function renderReceipt(result?: RunResult) {
  if (!result) return `<section class="space-panel"><h2>没找到这次运行</h2><p class="space-muted">回执只在内存里留一小时，重启后查不到。</p></section>`;
  const steps = result.steps.map(step => {
    const output = step.output == null ? "" : typeof step.output === "string" ? step.output : JSON.stringify(step.output, null, 2);
    return `<li><code>${escape(step.id)}</code> · ${escape(step.tool)} <span class="space-badge ${runBadge[step.status] ?? ""}">${escape(step.status)}</span> <span class="space-muted">${step.elapsedMs} ms</span>${step.error ? `<pre>${escape(step.error)}</pre>` : output ? `<pre>${escape(output.slice(0, 1200))}${output.length > 1200 ? "…" : ""}</pre>` : ""}</li>`;
  }).join("");
  return `<section class="space-panel"><h2>运行回执</h2>
  <p><span class="space-badge ${runBadge[result.status] ?? ""}">${escape(result.status)}</span><span class="space-muted">${escape(result.runId)}</span></p>
  ${result.error ? `<p>${escape(result.error)}</p>` : ""}
  ${result.trimmed ? `<p class="space-muted">${[
    result.trimmed.dropped.length ? `这条技能跑完自己缩短了：${result.trimmed.from} 步 → ${result.trimmed.to} 步（rev ${result.trimmed.revision}）。删掉的是 ${result.trimmed.dropped.map(item => escape(item.id + " " + item.tool)).join("、")}，因为它的结果没有被后面的步骤用到。` : "",
    result.trimmed.cut?.length ? `候选砍枝（rev ${result.trimmed.revision}）：${result.trimmed.cut.map(item => escape(item.key) + " 只留第一条，砍掉 " + item.droppedCount + " 个从没命中的候选").join("；")}。` : "",
  ].filter(Boolean).join(" ")}</p>` : ""}
  ${result.trimSuggestion ? `<p><span class="space-badge warn">待确认</span><span class="space-muted">这次可以砍掉 ${result.trimSuggestion.dropped.map(item => escape(item.id + " " + item.tool)).join("、")}（结果没有被后面的步骤用到），技能 ${result.trimSuggestion.from} 步 → ${result.trimSuggestion.to} 步。还没动它；要砍就说一声「确认精简 ${escape(result.skill)}」。</span></p>` : ""}
  ${result.relevance ? `<p><span class="space-badge" ${result.relevance.status === "matched" ? "ok" : result.relevance.status === "weak" ? "warn" : result.relevance.status === "unrelated" ? "err" : ""}">相关性 ${escape(result.relevance.status)}</span><span class="space-muted">${escape(result.relevance.basis)}</span></p>` : ""}
  <ol class="space-steps">${steps}</ol></section>`;
}
/**
 * 统一读取请求体：表单和 JSON 都认。
 * 宿主表单提交发 application/x-www-form-urlencoded，程序调用多半发 application/json；
 * 只认表单的话，JSON 调用会静默拿不到字段。
 */
type Payload = {
  get(key: string): string | null;
  entries(): IterableIterator<[string, string]>;
  [Symbol.iterator](): IterableIterator<[string, string]>;
};
async function readPayload(req: any, limit = 8192): Promise<Payload> {
  const raw = await readBody(req, limit);
  const type = String(req.headers?.["content-type"] ?? "").toLowerCase();
  let parsed: Record<string, unknown> | null = null;
  if (type.includes("application/json")) {
    try {
      const value = JSON.parse(raw || "{}");
      if (value && typeof value === "object" && !Array.isArray(value)) parsed = value as Record<string, unknown>;
    } catch { parsed = null; }
  } else if (!type && raw.trimStart().startsWith("{")) {
    try {
      const value = JSON.parse(raw);
      if (value && typeof value === "object" && !Array.isArray(value)) parsed = value as Record<string, unknown>;
    } catch { parsed = null; }
  }
  if (!parsed) {
    const form = new URLSearchParams(raw);
    return {
      get: (key: string) => form.get(key),
      entries: () => form.entries(),
      [Symbol.iterator]: () => form.entries(),
    };
  }
  const body = parsed;
  const asText = (value: unknown) =>
    value === undefined || value === null ? "" : typeof value === "string" ? value : JSON.stringify(value);
  const entries = () =>
    Object.entries(body).map(([key, value]) => [key, asText(value)] as [string, string])[Symbol.iterator]();
  return {
    get(key: string) {
      const value = body[key];
      if (value === undefined || value === null) return null;
      return typeof value === "string" ? value : JSON.stringify(value);
    },
    entries,
    [Symbol.iterator]: entries,
  };
}

function readBody(req: any, limit = 8192): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) { reject(new Error("请求体过大。")); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
function renderSettings(settings: Settings, stats: { total: number; single: number; composite: number }) {
  return `<section class="space-panel">
  <h2>这是什么</h2>
  <p>思维空间把工具链存成<strong>技能</strong>：单步的进功能库，多步串起来的进复合功能库。技能存在服务端，不用打开这个页面，对话里就能直接读写。</p>
  <p>在画布页里画流程、看每个节点的接口和权限，画好回来存成技能，一句话就能调用，不必每次重新串一遍工具。</p>
  <p class="space-muted">技能存下来，对话里直接就能用；你也能在这页点「跑一次」。每一步的结果、耗时和失败原因都会留在回执里，按 runId 可回查一小时。</p>
  <p class="space-muted">画布是子插件「思维画布」，跟着这个包一起装；启动停止、端口和脚本路径都在它的插件页里。</p>
  <div class="space-rules">
    <h3>技能守则</h3>
    <ol>
      <li><strong>先翻工具目录再动手</strong>：宿主已有的工具优先用，不重复造。</li>
      <li><strong>不同插件的工具可以拼成一条链</strong>：搜索 → 读正文 → 模型提炼 → 出图，跨几个插件都允许。</li>
      <li><strong>没有对应工具就手搓一个</strong>：给插件加注册，参数写清楚，有副作用就标 danger，别为了省事标 safe。</li>
      <li><strong>手搓的工具也要能被观测</strong>：公开的返回值形状越清楚，后面自动连线越准。</li>
      <li><strong>先跑一次再存下来</strong>：没跑通的链留在库里只会让下次调用踩空。</li>
    </ol>
  </div>
</section>
<section class="space-panel">
  <h2>当前状态</h2>
  <p><span class="space-badge">${stats.total} 条技能</span><span class="space-badge">单步 ${stats.single}</span><span class="space-badge">复合 ${stats.composite}</span></p>
  <p class="space-muted">自动整理思维：${settings.autoOrganize ? "开着" : "关着"}。技能列表里每条会显示跑过几次、上次成没成；连着几次没跑成会单独提醒你看一眼。</p>
  <p style="margin-top:12px"><a class="btn space-secondary strong" href="${pagePath}space">查看技能列表 →</a><a class="btn space-secondary teal" href="${pagePath}local" style="margin-left:8px">查看本机能力 →</a></p>
</section>
<section class="space-panel">
  <h2>设置</h2>
  <form method="post" action="${pagePath}">
    <label class="space-check"><input type="checkbox" name="allowUse"${settings.allowUse ? " checked" : ""}><span>允许使用整理好的技能</span></label>
    <p class="space-muted">默认开。允许在对话里参考和使用已经保存的技能；关掉后保留技能，但不应使用。此开关会随技能列表返回，供调用方遵守。</p>
    <label class="space-check" style="margin-top:24px"><input type="checkbox" name="autoOrganize"${settings.autoOrganize ? " checked" : ""}><span>自动整理思维</span></label>
    <p class="space-muted">开着时，在对话里会把反复用到的一串动作整理成技能存进来，不必每次开口。它不会在没人说话时自己醒来——那需要自主唤醒，还没有。关掉之后只在明确要求时才保存。默认开。</p>

    <label class="space-check" style="margin-top:18px"><input type="checkbox" name="learnOnRequest"${settings.learnOnRequest ? " checked" : ""}><span>听一句话就学</span></label>
    <p class="space-muted">默认开。开着时你只要说一句「XXX，这个技能学会了吗？」，我就会去看刚才反复做的动作，整理成技能存进来，再回你存了什么。它自己不会先跑，还是要你开口。关掉之后，只在设置页点「立即整理」，或者我明确被要求时才整理。</p>

    <div class="space-field">听哪一句话</div>
    <input type="text" name="triggerPhrase" maxlength="80" value="${escape(settings.triggerPhrase)}">
    <p class="space-muted" style="margin-top:6px">出厂是「XXX，你学会了吗？」。XXX 会换成当前人格名。你可以改成自己顺口的说法，只要意思还是「去把刚才反复做的动作学下来」。</p>

    <div class="space-field">连续出现几次才算一条链</div>
    <input type="number" name="organizeThreshold" min="2" max="10" value="${settings.organizeThreshold}">
    <p class="space-muted" style="margin-top:6px">默认 3。同一串工具在相邻调用里重复到这个次数，才出现在建议里。设成 4 更保守。</p>

    <div class="space-field">两次调用隔多久就算断开（分钟）</div>
    <input type="number" name="organizeWindowMinutes" min="5" max="1440" value="${settings.organizeWindowMinutes}">
    <p class="space-muted" style="margin-top:6px">默认 120。间隔超过这个时间就不拼成同一条链。</p>

    <label class="space-check" style="margin-top:18px"><input type="checkbox" name="autoSaveOrganized"${settings.autoSaveOrganized ? " checked" : ""}><span>整理出来的技能自动保存</span></label>
    <p class="space-muted">默认开。关掉后只给建议、不写进技能库。</p>

    <label class="space-check" style="margin-top:18px"><input type="checkbox" name="allowRiskyChains"${settings.allowRiskyChains ? " checked" : ""}><span>允许整理含确认步骤的链</span></label>
    <p class="space-muted">默认关。开着时，包含写入、执行、发送或发声这类需要确认的工具链也会被整理成技能存下来——但运行到那一步仍然会停下来征求同意，不会自己动手。关着时这类链只在报告里列出来，不进技能库。</p>

    <label class="space-check" style="margin-top:18px"><input type="checkbox" name="observeHands"${settings.observeHands ? " checked" : ""}><span>观测文件类工具的返回值形状</span></label>
    <p class="space-muted">默认关。开着时 hands_list / hands_read / hands_write / hands_run 的调用也会被记录——只记键名和类型（如 <code>{ok:b,result:s}</code>），不记路径、不记正文。用来给「自动分配端口」攒数据。</p>

    <label class="space-check" style="margin-top:18px"><input type="checkbox" name="allowSave"${settings.allowSave ? " checked" : ""}><span>允许保存技能</span></label>
    <p class="space-muted">关掉后 space_skill_save 一律返回 blocked，已有技能不受影响。</p>

    <div class="space-field">单条技能最多步数</div>
    <input type="number" name="maxSteps" min="1" max="20" value="${settings.maxSteps}">
    <p class="space-muted" style="margin-top:6px">1–20。只在新保存时生效，已存的技能不因调小而被删。</p>

    <div class="space-field">画布页面地址</div>
    <input type="text" name="spaceUrl" value="${escape(settings.spaceUrl)}">
    <p class="space-muted" style="margin-top:6px">只认 http 或 https 开头，最多 300 字。改完保存，再点上面的按钮就会去新地址。</p>

    <button class="btn primary space-save" type="submit">保存设置</button>
  </form>
</section>
<section class="space-panel">
  <h2>导出与导入</h2>
  <p class="space-muted">导出是一份 JSON，换机器或备份时用。导入按技能 ID 合并：同 ID 覆盖，新 ID 新增，不会删掉原有的技能。</p>
  <p><a class="btn space-secondary" href="/plugins/thinking-space/export" download>导出全部技能</a></p>
  <form method="post" action="/plugins/thinking-space/import">
    <label class="space-field" for="import-file">选一个 JSON 文件</label>
<input type="file" id="import-file" accept=".json,application/json">
<p class="space-muted" style="margin-top:6px">选好之后内容会填到下面的框里，看一眼再点「导入」。</p>
<label style="display:block;margin-top:14px">或者直接粘贴 JSON<textarea id="import-payload" name="payload" rows="6" spellcheck="false" placeholder='{"schemaVersion":1,"skills":[...]}'></textarea></label>
    <p class="space-row"><button class="btn primary space-save" type="submit">导入</button></p>
  </form>
  <script>
  (function () {
    var file = document.getElementById("import-file");
    var box = document.getElementById("import-payload");
    if (!file || !box) return;
    file.addEventListener("change", function () {
      var f = file.files && file.files[0];
      if (!f) return;
      var reader = new FileReader();
      reader.onload = function () { box.value = String(reader.result || ""); };
      reader.readAsText(f, "utf-8");
    });
  })();
  </script>
</section>`;
}
function summarize(skill: Skill, catalog: Map<string, ToolContract>, stat?: { runs: number; lastStatus: RunStatus; sources?: { chat?: number; page?: number; user?: number; self?: number } }) {
  const steps = skill.steps.map(step => {
    const contract = catalog.get(step.tool);
    return { ...step, available: !!contract && (!contract.plugin || contract.plugin === step.plugin) };
  });
  let status = "仅声明";
  try { validateSkill(skill.id, skill, catalog); }
  catch { status = "待核实"; }
  if (status === "仅声明" && stat && stat.runs > 0) status = stat.lastStatus === "ok" ? "已跑通" : "上次失败";
  return { ...skill, steps, stepCount: steps.length, danger: dangerFor(steps, catalog, skill.danger),
    revision: Number.isFinite(skill.revision) ? Number(skill.revision) : 0, status,
    ...(stat?.sources ? { sources: stat.sources } : {}) };
}

export function apply(ctx: Context) {
  /** 手搓子插件的卸载收尾。子插件删不掉自己：Windows 下正在运行的目录删不动，
   *  硬删会留下半份残骸。所以卸载分两步——子插件只写 data/uninstall.flag，
   *  宿主下次启动、在子插件被扫到之前，由父插件在这里清掉。
   *  同步做：父插件的 children() 在 apply() 返回后立刻开始扫 sub/。 */
  function sweepUninstalled() {
    let dirs;
    try { dirs = readdirSync(join(here, "sub"), { withFileTypes: true }); }
    catch { return; }
    for (const child of dirs) {
      if (!child.isDirectory()) continue;
      const dir = join(here, "sub", child.name);
      // 只认 sub/<一层>/data/uninstall.flag，别的位置一律不碰。
      if (!existsSync(join(dir, "data", "uninstall.flag"))) continue;
      try {
        rmSync(dir, { recursive: true, force: true });
        ctx.logger.info(`思维空间：按墓碑清掉了子插件 ${child.name}`);
      } catch (error) {
        ctx.logger.warn(`思维空间：清 ${child.name} 没成功`, error);
      }
    }
  }
  sweepUninstalled();
  const traces = new Map<string, RunResult>();
  const traceTtl = 60 * 60 * 1000;
  const taskRuns = new Map<string, { runId: string; at: number }>();
  const TASK_REUSE_MS = 60 * 60 * 1000;
  function remember(id: string, value: RunResult) {
    traces.set(id, value);
    const cutoff = Date.now() - traceTtl;
    for (const [key, item] of traces) {
      if (Number(key.split("_")[1]) < cutoff) traces.delete(key);
    }
  }
  function blocked(runId: string, skillId: string, error: string, steps: StepResult[] = []): RunResult {
    const result: RunResult = { status: "blocked", runId, skill: skillId, steps, error };
    remember(runId, result);
    return result;
  }
  const skillsBrief = (() => {
    try {
      const store = ctx.config<Store>(storeFile);
      const list = Array.isArray(store?.skills) ? store.skills : [];
      const items = list.slice(0, 8).map(skill => String(skill.name || skill.id) + "（" + (skill.steps?.length ?? 0) + "步）");
      return items.length ? "现成技能：" + items.join("、") + "。连着几步的事先用它们，比逐个调工具少一轮对话。" : "";
    } catch { return ""; }
  })();
  const LLM_TOOL = "llm";
const llmContract = {
  name: LLM_TOOL, plugin: "thinking-space", description: "把上一步的结果交给模型提炼成一段文字。",
  danger: "safe",
  inputSchema: {
    type: "object",
    properties: { prompt: { type: "string" }, system: { type: "string" }, max_tokens: { type: "integer" }, model: { type: "string" } },
    required: ["prompt"], additionalProperties: false,
  },
} as any;

async function callLlm(plan: JsonObject) {
  const prompt = typeof plan.prompt === "string" ? plan.prompt.trim() : "";
  if (!prompt) throw new Error("模型步骤缺少 prompt。");
  const wanted = typeof plan.model === "string" ? plan.model : "";
  const choices = (() => {
    try { return (ctx.models?.list?.("chat") ?? []).filter((item: any) => item.callable !== false); }
    catch { return [] as any[]; }
  })();
  const pick = (wanted && choices.find((item: any) => item.id === wanted || item.model === wanted || item.name === wanted))
    ?? choices[0];
  if (wanted && !pick) throw new Error("没找到模型 " + wanted + "。");
  if (!pick) throw new Error("没有可用的对话模型，先在模型配置里加一个。");
  const messages: any[] = [];
  if (typeof plan.system === "string" && plan.system.trim()) messages.push({ role: "system", content: String(plan.system) });
  messages.push({ role: "user", content: prompt });
  const maxTokens = Number.isInteger(plan.max_tokens) ? Number(plan.max_tokens) : 800;
  const reply = await ctx.llm.chat({ model: pick.id, messages, max_tokens: maxTokens } as any);
  const text = String(reply?.text ?? "").trim();
  if (!text) throw new Error("模型返回空内容（finish_reason=" + (reply?.finish_reason ?? "未知") + "）。");
  return { ok: true, data: { text, model: pick.id } };
}

const hasToolCatalog = () => typeof (ctx.tools as any)?.catalog === "function";
const hasToolList = () => typeof (ctx.tools as any)?.list === "function";
/** 读本机工具：新宿主用 catalog()，旧宿主退回 list()。拿不到的字段留空，不假造。 */
const toolsSafe = async (): Promise<any[]> => {
  const tools: any = ctx.tools;
  if (typeof tools?.catalog === "function") {
    try {
      return await tools.catalog();
    } catch {
      // catalog 存在但读失败，往下试 list
    }
  }
  if (typeof tools?.list === "function") {
    const raw = await tools.list();
    return (Array.isArray(raw) ? raw : [])
      .map((item: any) => ({
        name: String(item?.function?.name ?? item?.name ?? ""),
        description: String(item?.function?.description ?? ""),
        plugin: "",
        danger: "",
        displayName: "",
        inputSchema: record(item?.function?.parameters) ? item.function.parameters : null,
        outputSchema: null,
      }))
      .filter((item: any) => item.name);
  }
  return [];
};

/** 两档取严。任一侧认不出（不是 safe/ask/full）时按「未知」处理，至少 ask——
 *  原来 bogus 与 safe 合并会得到 safe，等于让一个坏值把另一侧的正常等级抹掉。 */
const stricterDanger = (a: unknown, b: unknown): string | undefined => {
  const ia = dangers.indexOf(a as Danger);
  const ib = dangers.indexOf(b as Danger);
  const unknown = (a !== undefined && ia < 0) || (b !== undefined && ib < 0);
  const known = [ia, ib].filter(i => i >= 0);
  if (unknown) return dangers[Math.max(known.length ? Math.max(...known) : 0, 1)];
  return known.length ? dangers[Math.max(...known)] : undefined;
};

const catalogByName = async () => {
  const map = new Map<string, ToolContract>();
  for (const tool of await toolsSafe()) {
    // 目录里出现同名条目时取更严的那档。之前是 Map 后值覆盖，
    // 一条误标 safe 的同名条目能把前面那条 ask 顶掉，预检跟着放行。
    const prev = map.get(tool.name);
    map.set(tool.name, prev ? { ...tool, danger: stricterDanger(prev.danger, tool.danger) } : tool);
  }
  map.set(LLM_TOOL, llmContract);
  return map;
};
  async function readStore(): Promise<Store> {
    const data = await ctx.config.read<Store>(storeFile);
    if (record(data) && !Object.keys(data).length) return { schemaVersion: 1, skills: [] };
    if (data?.schemaVersion !== 1 || !Array.isArray(data.skills)) throw new Error("技能库文件格式无效。");
    return data;
  }
  async function readSettings(): Promise<Settings> {
    const data = await ctx.config.read<Partial<Settings>>(settingsFile);
    const raw = Math.floor(Number(data?.maxSteps));
    const rawUrl = typeof data?.spaceUrl === "string" ? data.spaceUrl.trim() : "";
    const spaceUrl = /^https?:\/\/[^\s]+$/.test(rawUrl) ? rawUrl.slice(0, 300) : defaultSpaceUrl;
    const rawTimeout = Math.floor(Number(data?.stepTimeoutSeconds));
    const rawThreshold = Math.floor(Number(data?.organizeThreshold));
    const rawWindow = Math.floor(Number(data?.organizeWindowMinutes));
    return { allowUse: data?.allowUse !== false, allowSave: data?.allowSave !== false, maxSteps: raw >= 1 && raw <= 20 ? raw : 20,
      autoOrganize: data?.autoOrganize !== false, spaceUrl,
      stepTimeoutSeconds: rawTimeout >= 1 && rawTimeout <= 600 ? rawTimeout : 60,
      organizeThreshold: rawThreshold >= 2 && rawThreshold <= 10 ? rawThreshold : 3,
      organizeWindowMinutes: rawWindow >= 5 && rawWindow <= 1440 ? rawWindow : 120,
      autoSaveOrganized: data?.autoSaveOrganized !== false,
      observeHands: data?.observeHands === true,
      allowRiskyChains: data?.allowRiskyChains === true,
      learnOnRequest: data?.learnOnRequest !== false,
      triggerPhrase: typeof data?.triggerPhrase === "string" && data.triggerPhrase.trim().length
        ? data.triggerPhrase.trim().slice(0, 80) : defaultTriggerPhrase,
};
  }
  const callsFile = "calls.json";
  type CallRecord = { ts: string; name: string; ok: boolean; session?: string; source?: string; transient?: true; shape?: string };
  const callsLimit = 800;
  // 只记返回值的"形状"：键名 + 类型，不记任何内容。
  // 数组只描述首元素类型，深度最多 3 层，整串截 300 字。
  function shapeOf(value: unknown, depth = 0): string {
    if (value === null) return "null";
    if (value === undefined) return "-";
    const t = typeof value;
    if (t === "string") return "s";
    if (t === "number") return "n";
    if (t === "boolean") return "b";
    if (t === "bigint") return "big";
    if (depth >= 5) return "…";
    if (Array.isArray(value)) {
      if (!value.length) return "[]";
      const head = shapeOf(value[0], depth + 1);
      const same = value.every(item => shapeOf(item, depth + 1) === head);
      return "[" + head + (same ? "" : "|…") + "]";
    }
    if (t === "object") {
      const keys = Object.keys(value as Record<string, unknown>);
      if (!keys.length) return "{}";
      const shown = keys.slice(0, 10).map(k => k + ":" + shapeOf((value as Record<string, unknown>)[k], depth + 1));
      return "{" + shown.join(",") + (keys.length > 10 ? ",+" + (keys.length - 10) : "") + "}";
    }
    return t;
  }
  // 把记录下来的形状反解成端口路径。只读观测，不猜类型之外的东西。
  function parseShapePorts(text: string, limit = 60): { path: string; type: string }[] {
    const ports: { path: string; type: string }[] = [];
    let i = 0;
    const scalar: Record<string, string> = { s: "string", n: "number", b: "boolean", big: "bigint", null: "null", "-": "undefined", "…": "unknown" };
    function push(path: string, type: string) {
      if (!path || ports.length >= limit) return;
      // 数组自身的类型已经说明了 \"[]\" 这层，元素是对象时不再重复一条 results[]
      if (type === "object" && path.endsWith("[]")) return;
      ports.push({ path, type });
    }
    function parseValue(path: string): string {
      if (text[i] === "{") return parseObject(path);
      if (text[i] === "[") return parseArray(path);
      const m = /^(null|big|b|n|s|-|…)/.exec(text.slice(i));
      if (!m) { i = text.length; return "unknown"; }
      i += m[1].length;
      const type = scalar[m[1]] ?? "unknown";
      push(path, type);
      return type;
    }
    function parseObject(path: string): string {
      i++;
      push(path, "object");
      while (i < text.length && text[i] !== "}") {
        const m = /^([A-Za-z_$][\w$-]*):/.exec(text.slice(i));
        if (!m) { i++; continue; }
        i += m[0].length;
        parseValue(path ? path + "." + m[1] : m[1]);
        if (text[i] === ",") i++;
      }
      if (text[i] === "}") i++;
      return "object";
    }
    function parseArray(path: string): string {
      i++;
      push(path, "array");
      if (text[i] !== "]") {
        parseValue(path + "[]");
        while (text[i] === "|") { i++; parseValue(path + "[]"); }
      }
      if (text[i] === "]") i++;
      return "array";
    }
    try { parseValue(""); } catch { /* 截断的尾巴不追 */ }
    return ports;
  }
  type ObservedKind = "fields" | "text" | "empty";
  type ObservedTool = {
    tool: string; calls: number; shapes: number;
    ports: { path: string; type: string }[];
    trusted: boolean;
    /** fields 有可连的字段口；text 只有一整段文本；empty 观测到空返回。 */
    kind: ObservedKind;
    note?: string;
  };
  async function observePorts(tool?: string): Promise<ObservedTool[]> {
    const calls = await readCalls();
    const map = new Map<string, { calls: number; shapes: Map<string, number> }>();
    for (const item of calls) {
      if (!item.shape) continue;
      const row = map.get(item.name) ?? { calls: 0, shapes: new Map<string, number>() };
      row.calls += 1;
      row.shapes.set(item.shape, (row.shapes.get(item.shape) ?? 0) + 1);
      map.set(item.name, row);
    }
    const list: ObservedTool[] = [];
    for (const [name, row] of map) {
      if (tool && name !== tool) continue;
      const ranked = [...row.shapes.entries()].sort((a, b) => b[1] - a[1]);
      const shape = ranked[0][0];
      const ports = parseShapePorts(shape);
      const kind: ObservedKind =
        shape === "[]" || shape === "{}" || shape === "null" || shape === "-" ? "empty"
        : shape === "s" ? "text"
        : ports.length ? "fields" : "text";
      const note =
        kind === "text" ? "整段文本口，没有可拆的字段。要接下一步只能整段传，或者先被人读一遍。"
        : kind === "empty" ? "观测到的返回是空的，推不出端口。"
        : undefined;
      list.push({ tool: name, calls: row.calls, shapes: row.shapes.size,
        ports, trusted: ranked[0][1] >= 3, kind, ...(note ? { note } : {}) });
    }
    return list.sort((a, b) => b.calls - a.calls);
  }
  function shapeText(value: unknown): string | undefined {
    try {
      const text = shapeOf(value);
      return text.length > 300 ? text.slice(0, 300) : text;
    } catch { return undefined; }
  }
  let callLog: CallRecord[] | null = null;
  async function readCalls(): Promise<CallRecord[]> {
    if (callLog) return callLog;
    try {
      const data = await ctx.config.read<CallRecord[]>(callsFile);
      const cfg = await readSettings();
      callLog = Array.isArray(data)
        ? data.filter(item => record(item) && typeof item.name === "string" && (cfg.observeHands || !item.name.startsWith("hands_")))
        : [];
    } catch { callLog = []; }
    return callLog;
  }
  let callQueue: Promise<unknown> = Promise.resolve();
  function recordCall(item: CallRecord) {
    callQueue = callQueue.then(async () => {
      try {
        const log = await readCalls();
        log.push(item);
        if (log.length > callsLimit) log.splice(0, log.length - callsLimit);
        callLog = log;
        await ctx.config.save(callsFile, log);
      } catch { /* 记录失败不影响主流程 */ }
    });
    return callQueue;
  }
  ctx.on("tool/called", async (payload) => {
    if (!payload || typeof payload.name !== "string") return;
    if (["space_run", "space_trace", "space_skills", "space_organize", "space_draft", "space_ports"].includes(payload.name)) return;
    // space_ 自己的调用不进观测；hands_ 默认跳过，可在设置里打开观测（只记形状，不记内容）。
    if (payload.name.startsWith("space_")) return;
    if (payload.name.startsWith("hands_") && !(await readSettings()).observeHands) return;
    // transient：工具结果不进历史。这里只记工具名和成败，不记参数、不记结果。
    await recordCall({
      ts: new Date().toISOString(), name: payload.name, ok: payload.ok !== false,
      session: typeof payload.session === "string" ? payload.session : undefined,
      source: typeof payload.source === "string" ? payload.source : undefined,
      transient: payload.transient === true ? true : undefined,
      shape: shapeText(payload.result),
    });
  });
  type Chain = { tools: string[]; count: number; lastAt: string; sessions: number };
  function chainsFrom(calls: CallRecord[], threshold: number, windowMinutes: number, readonly?: Set<string>): Chain[] {
    const bySession = new Map<string, CallRecord[]>();
    for (const call of calls) {
      const key = call.session ?? "?";
      const list = bySession.get(key) ?? [];
      list.push(call);
      bySession.set(key, list);
    }
    const counts = new Map<string, { tools: string[]; count: number; lastAt: string; sessions: Set<string> }>();
    const windowMs = windowMinutes * 60 * 1000;
    for (const [session, list] of bySession) {
      list.sort((a, b) => a.ts.localeCompare(b.ts));
      const runs: CallRecord[][] = [];
      let current: CallRecord[] = [];
      let prev = 0;
      for (const call of list) {
        const at = Date.parse(call.ts);
        if (!Number.isFinite(at)) continue;
        if (current.length && at - prev > windowMs) { runs.push(current); current = []; }
        current.push(call); prev = at;
      }
      if (current.length) runs.push(current);
      for (const run of runs) {
        const names = run.map(c => c.name);
        for (let len = 2; len <= Math.min(5, names.length); len++) {
          for (let start = 0; start + len <= names.length; start++) {
            const tools = names.slice(start, start + len);
            if (tools.every(item => item === tools[0])) continue;
            const key = tools.join("\u0000");
            const item = counts.get(key) ?? { tools, count: 0, lastAt: "", sessions: new Set<string>() };
            item.count += 1;
            item.lastAt = run[start + len - 1].ts;
            item.sessions.add(session);
            counts.set(key, item);
          }
        }
      }
    }
    const picked = [...counts.values()]
      .filter(item => item.count >= threshold && item.tools.length >= 2)
      .map(item => ({ tools: item.tools, count: item.count, lastAt: item.lastAt, sessions: item.sessions.size }));
    // 冗余折叠：同一次重复被展开成 a,b,a / a,b,a,b 之类，只留最短的那条。
    const kept: typeof picked = [];
    for (const item of [...picked].sort((a, b) => a.tools.length - b.tools.length || b.count - a.count)) {
      const periodicOver = (short: string[], long: string[]) => {
        if (short.length >= long.length) return false;
        for (let offset = 0; offset < short.length; offset++) {
          let same = true;
          for (let i = 0; i < long.length && same; i++) if (long[i] !== short[(offset + i) % short.length]) same = false;
          if (same) return true;
        }
        return false;
      };
      const covered = kept.some(k => periodicOver(k.tools, item.tools));
      // 反向折叠：链里不含顺序敏感的执行工具时，a→b 与 b→a 视为同一条，只留一条。
      // hands_ 这类动手工具顺序有意义（先写文件再跑命令 ≠ 反过来），所以不折。
      // 其余工具既然各被独立调用够次数，前后顺序就不影响结果。
      const orderSensitive = item.tools.some(tool => tool.startsWith("hands_"));
      const mirrored = !orderSensitive && item.tools.length > 1 &&
        kept.some(k => k.tools.length === item.tools.length &&
          k.tools.every((tool, index) => tool === item.tools[item.tools.length - 1 - index]));
      if (!covered && !mirrored) kept.push(item);
    }
    return kept.sort((a, b) => b.count - a.count || b.tools.length - a.tools.length);
  }
  /** 工具自己没写默认值的必填参数，可以在这里补一份。文件 param-defaults.json，形如 {"image_view":{"path":"/path/to/your/image.png"}}。只影响自动整理学出来的技能，不改别的插件的 schema。 */
  async function readParamDefaults(): Promise<Record<string, Record<string, unknown>>> {
    try {
      const raw = await ctx.config.read<Record<string, unknown>>(paramDefaultsFile);
      if (!record(raw)) return {};
      const out: Record<string, Record<string, unknown>> = {};
      for (const [tool, table] of Object.entries(raw)) {
        if (record(table)) out[tool] = table as Record<string, unknown>;
      }
      return out;
    } catch { return {}; }
  }
  function draftSpec(names: string[], catalog: Map<string, ToolContract>, name: string, description: string,
    defaults: Record<string, Record<string, unknown>> = {}) {
    const declaredParams: { name: string; type: string; required: boolean }[] = [];
    const typeOf = (schema: unknown): string => {
      const raw = record(schema) ? (schema as any).type : "string";
      return ["integer", "number", "boolean", "array", "object"].includes(raw) ? raw : "string";
    };
    const steps = names.map((tool, index) => {
      const contract = catalog.get(tool)!;
      const schema: any = contract.inputSchema ?? {};
      const required: string[] = Array.isArray(schema.required) ? schema.required : [];
      const properties: Record<string, unknown> = record(schema.properties) ? schema.properties as Record<string, unknown> : {};
      const params: Record<string, unknown> = {};
      for (const field of required) {
        const preset = (properties[field] as any)?.default ?? defaults[tool]?.[field];
        if (preset !== undefined) { params[field] = preset; continue; }
        const type = typeOf(properties[field]);
        const clash = declaredParams.find(item => item.name === field && item.type !== type);
        const key = clash ? "n" + (index + 1) + "_" + field : field;
        if (!declaredParams.some(item => item.name === key)) declaredParams.push({ name: key, type, required: true });
        params[field] = "${" + key + "}";
      }
      return { id: "n" + (index + 1), tool, plugin: contract.plugin, params,
        next: index + 1 < names.length ? "n" + (index + 2) : null };
    });
    return { schemaVersion: 1, name, kind: names.length === 1 ? "single" : "composite",
      description, params: declaredParams, steps } as Record<string, unknown>;
  }
  function autoFillable(chain: string[], catalog: Map<string, any>, defaults: Record<string, Record<string, unknown>> = {}): string | null {
    for (const tool of chain) {
      const schema: any = catalog.get(tool)?.inputSchema ?? {};
      const required: string[] = Array.isArray(schema.required) ? schema.required : [];
      const props: any = record(schema.properties) ? schema.properties : {};
      for (const field of required) {
        if ((props[field] as any)?.default === undefined && defaults[tool]?.[field] === undefined) return "必填参数 " + field + "（" + tool + "）没有默认值，自动整理不知道填什么。";
      }
    }
    return null;
  }
  /** 插件工具大多没写 displayName，这里给常见工具一个中文名兜底，自动命名才不至于露出一串下划线。 */
  const TOOL_LABELS: Record<string, string> = {
  "llm": "模型提炼",
    "ledger_today": "今天用量",
    "usage_today": "最近用量",
    "budget_set": "设预算",
    "surf_search": "网上搜索",
    "surf_read": "读网页",
    "surf_status": "冲浪状态",
    "workbench_search_read": "搜完就读",
    "comfy_status": "绘图环境",
    "comfy_generate": "出图",
    "image_view": "看图",
    "see_now": "看屏幕",
    "bili_search": "找B站视频",
    "bili_video": "看视频信息",
    "bili_subtitle": "看字幕",
    "bilibili_status": "B站状态",
    "bilibili_search": "B站搜索",
    "bilibili_open": "打开B站视频",
    "bilibili_comments": "看评论",
    "hands_list": "列目录",
    "hands_read": "读文件",
    "hands_write": "写文件",
    "hands_run": "跑命令",
    "gsv_start": "启动嗓音",
    "gsv_stop": "停嗓音",
    "gsv_status": "嗓音状态",
    "ear_start": "开耳朵",
    "ear_stop": "关耳朵",
    "ear_status": "耳朵状态",
    "mouth_say": "念出来",
    "meme_categories": "表情分类",
    "meme_pick": "挑表情",
    "chime_test": "响一声",
    "watcher_check": "查监控",
    "watcher_send": "发监控",
    "scribe_transcribe": "转文字",
    "scribe_correct": "校对",
    "scribe_run": "转写一条龙",
    "deepclef_status": "机器人在哪",
    "deepclef_observe": "看四周",
    "deepclef_goto": "走过去",
    "deepclef_follow": "跟着我",
    "deepclef_stop": "停下",
    "deepclef_task": "派个活",
    "deepclef_progress": "看进度",
    "deepclef_inventory": "清点背包",
    "space_skills": "列技能",
    "space_run": "跑技能",
    "space_draft": "起技能草稿",
    "space_organize": "整理技能",
    "space_trace": "看回执",
  };
  function toolLabel(tool: string, catalog: Map<string, any>): string {
    const fromCatalog = String(catalog.get(tool)?.displayName ?? "").trim();
    if (fromCatalog && fromCatalog !== tool) return fromCatalog;
    return TOOL_LABELS[tool] ?? tool;
  }
  function autoName(chain: string[], catalog: Map<string, any>): string {
    const labels = chain.map(tool => {
      const label = toolLabel(tool, catalog);
      return label && label !== tool ? label.slice(0, 12) : tool;
    });
    return labels.slice(0, 2).join("·") + (labels.length > 2 ? " 等" + labels.length + "步" : "");
  }
  function autoId(tools: string[]) {
    let hash = 0;
    for (const tool of tools) for (const ch of tool) hash = (hash * 31 + ch.charCodeAt(0)) % 0x7fffffff;
    return "auto-" + hash.toString(36);
  }
  const statsFile = "stats.json";
  type Reason = "input" | "timeout" | "external" | "empty" | "skipped" | "cancelled" | "blocked" | "other";
  type Stat = { runs: number; ok: number; failed: number; streak: number; lastAt: string; lastStatus: RunStatus;
    sources?: { chat?: number; page?: number; user?: number; self?: number };
    reasons?: Record<Reason, number>; candidates?: Record<string, { runs: number; first: number }> };
  function classifyFailure(status: RunStatus, error: string): Reason {
    if (status === "blocked") return "blocked";
    if (status === "skipped") return "skipped";
    if (/取消|已停止|cancel|abort/i.test(error)) return "cancelled";
    if (/缺少必填参数|占位|参数|不匹配|无效|找不到这条技能|须为|越界/.test(error)) return "input";
    if (/超时|timeout|结果未知/i.test(error)) return "timeout";
    if (/没有搜索结果|无搜索结果|候选值全都取不到|没有有效链接|没有可试的输入|这一步没有可试/.test(error)) return "empty";
    if (/读取失败|抓不到|打不开|unsupported_content|access_blocked|network|ECONN|ENOTFOUND|HTTP \d|业务错误|拒绝/.test(error)) return "external";
    return "other";
  }
  const runsFile = "runs.json";
  async function readRuns(): Promise<RunLog[]> {
    try {
      const data = await ctx.config.read<RunLog[]>(runsFile);
      return Array.isArray(data) ? data.filter(item => item && typeof item.at === "string") : [];
    } catch { return []; }
  }
  async function appendRun(skill: string, status: RunStatus, source: "user" | "self" | "page") {
    const list = await readRuns();
    list.push({ at: new Date().toISOString(), skill, status, source });
    const floor = Date.now() - 90 * 86400000;
    const kept = list.filter(item => { const stamp = Date.parse(item.at); return Number.isFinite(stamp) ? stamp >= floor : false; });
    await ctx.config.save(runsFile, kept.slice(-2000));
  }
  /** 第一次用的时候把每条技能最后一次运行补进去，那一行是真实发生过的。 */
  async function readRunsSeeded(): Promise<RunLog[]> {
    const list = await readRuns();
    if (list.length) return list;
    const stats = await readStats();
    const seeded = Object.entries(stats)
      .filter(([, stat]) => stat && stat.lastAt)
      .map(([skill, stat]) => ({ at: stat.lastAt as string, skill, status: (stat.lastStatus ?? "ok") as RunStatus, source: "chat" as const }));
    if (seeded.length) { try { await ctx.config.save(runsFile, seeded); } catch { /* 建档失败就下次再试 */ } }
    return seeded;
  }
  async function readStats(): Promise<Record<string, Stat>> {
    try {
      const data = await ctx.config.read<Record<string, Stat>>(statsFile);
      return data && record(data) ? data : {};
    } catch { return {}; }
  }
  /** 技能被删掉后统计会变成孤儿，读技能库时顺手清一次。 */
  async function pruneStats(liveIds: Set<string>) {
    try {
      const stats = await readStats();
      let dropped = 0;
      for (const id of Object.keys(stats)) if (!liveIds.has(id)) { delete stats[id]; dropped += 1; }
      if (dropped) await ctx.config.save(statsFile, stats);
      return dropped;
    } catch { return 0; }
  }
  const failuresFile = "failures.json";
  type Failure = { at: string; skill: string; status: RunStatus; reason: Reason; error: string };
  async function recordFailure(skillId: string, status: RunStatus, error: string) {
    try {
      const data = await ctx.config.read<Failure[]>(failuresFile);
      const list = Array.isArray(data) ? data : [];
      list.push({ at: new Date().toISOString(), skill: skillId, status, reason: classifyFailure(status, error), error: String(error || "没有给出原因").slice(0, 300) });
      if (list.length > 200) list.splice(0, list.length - 200);
      await ctx.config.save(failuresFile, list);
    } catch { /* 失败记录写不进去，不影响这次执行 */ }
  }
  async function bumpStat(skillId: string, status: RunStatus, error = "", source: "user" | "self" | "page" = "self") {
    try {
      const stats = await readStats();
      const stat: Stat = stats[skillId] ?? { runs: 0, ok: 0, failed: 0, streak: 0, lastAt: "", lastStatus: status,
        reasons: { input: 0, timeout: 0, external: 0, empty: 0, skipped: 0, cancelled: 0, blocked: 0, other: 0 } };
      if (!stat.reasons) stat.reasons = { input: 0, timeout: 0, external: 0, empty: 0, skipped: 0, cancelled: 0, blocked: 0, other: 0 };
      else for (const key of ["input", "timeout", "external", "empty", "skipped", "cancelled", "blocked", "other"] as Reason[])
        if (!Number.isFinite(stat.reasons[key])) stat.reasons[key] = 0;
      // 早期版本没有 reasons 分类，历史失败没有任何原因记录。
      // 差额补到 other，避免出现「失败 5 次，原因全是 0」这种自相矛盾的数字。
      const reasonSum = stat.reasons.input + stat.reasons.timeout + stat.reasons.external
        + stat.reasons.empty + stat.reasons.skipped + stat.reasons.cancelled + stat.reasons.blocked + stat.reasons.other;
      if (stat.failed > reasonSum) stat.reasons.other += stat.failed - reasonSum;
      stat.runs += 1;
      if (status === "ok") { stat.ok += 1; stat.streak = 0; }
      else {
        stat.failed += 1; stat.streak += 1;
        stat.reasons[classifyFailure(status, error)] += 1;
        await recordFailure(skillId, status, error);
      }
      if (!stat.sources) stat.sources = {};
      stat.sources[source] = (stat.sources[source] ?? 0) + 1;
      stat.lastAt = new Date().toISOString();
      stat.lastStatus = status;
      stats[skillId] = stat;
      await ctx.config.save(statsFile, stats);
      try { await appendRun(skillId, status, source); } catch { /* 趋势日志写不进去不影响这次执行 */ }
    } catch { /* 统计写不进去不影响这次执行 */ }
  }
  // 跑熟了自己变短：跑通一次后回头看这条链，有没有哪一步纯属白跑。
  // 判定保守：只删「自己跑成了、输出没有被后面任何一步引用、不是最后一步、工具不需要确认」的中间步。
  type TrimPlan = { note: TrimNote; next: Skill };
  const trimSuggestions = new Map<string, TrimPlan>();
  // 只算不写：跑通一次后回头看有没有哪一步纯属白跑。建议先攒着，等确认再动技能。
  async function planTrim(skillId: string, steps: StepResult[], startRevision: number): Promise<TrimPlan | null> {
    try {
      const store = await readStore();
      const skill = store.skills.find(item => item.id === skillId);
      if (!skill || skill.steps.length < 3) return null;
      const catalog = await catalogByName();
      const dropped: { id: string; tool: string; why: string }[] = [];
      const keep = skill.steps.filter((step, index) => {
        if (index === skill.steps.length - 1) return true;
        const ran = steps.find(item => item.id === step.id);
        if (!ran || ran.status !== "ok") return true;
        const rest = skill.steps.slice(index + 1);
        const used = rest.some(item => JSON.stringify(item.params ?? {}).includes("${" + step.id));
        if (used) return true;
        if ((catalog.get(step.tool)?.danger ?? "ask") !== "safe") return true;
        // 复合技能至少两步，删到只剩两步就停手
        if (skill.steps.length - dropped.length <= 2) return true;
        dropped.push({ id: step.id, tool: step.tool, why: "它的结果没有被后面的步骤用到" });
        return false;
      });
      if (!dropped.length) return null;
      const rebuilt = keep.map((step, index) => ({ ...step, next: keep[index + 1]?.id ?? null }));
      const next: Skill = { ...skill, steps: rebuilt, revision: startRevision + 1, danger: dangerFor(rebuilt, catalog, skill.danger) };
      validateSkill(next.id, next, catalog);
      return { note: { from: skill.steps.length, to: rebuilt.length, dropped, revision: Number(next.revision) }, next };
    } catch (error) {
      console.warn("精简没做成：" + (error instanceof Error ? error.message : String(error)));
      return null;
    }
  }
  // 确认之后才真改。写之前再看一眼 revision，中间被改过就作废。
  async function applyTrim(skillId: string): Promise<TrimNote | string> {
    const plan = trimSuggestions.get(skillId);
    if (!plan) return "没有待确认的精简建议。先跑一次技能，跑通了才会攒出建议。";
    const store = await readStore();
    const current = store.skills.find(item => item.id === skillId);
    if (!current) return "这条技能已经不在了。";
    if (Number(current.revision) !== Number(plan.note.revision) - 1) {
      trimSuggestions.delete(skillId);
      return "这条技能在你确认之前被改过（现在 rev " + current.revision + "），这条建议作废，没有动它。";
    }
    const updated = { ...store, skills: store.skills.map(item => item.id === skillId ? plan.next : item) };
    await ctx.config.save(storeFile, updated);
    trimSuggestions.delete(skillId);
    return plan.note;
  }
  // $try 候选砍枝的统计：记每个「步骤.参数」跑了多少次、其中多少次第一条就命中。
  async function bumpCandidates(skillId: string, steps: StepResult[]) {
    try {
      const hits = steps.flatMap(step => (step.tries ?? []).map(item => ({ ...item, step: step.id })));
      if (!hits.length) return;
      const stats = await readStats();
      const stat: Stat = stats[skillId] ?? { runs: 0, ok: 0, failed: 0, streak: 0, lastAt: "", lastStatus: "ok" };
      const box = stat.candidates ?? {};
      for (const hit of hits) {
        const key = hit.step + "." + hit.key;
        const entry = box[key] ?? { runs: 0, first: 0 };
        entry.runs += 1;
        if (hit.hit === 0) entry.first += 1;
        box[key] = entry;
      }
      stat.candidates = box;
      stats[skillId] = stat;
      await ctx.config.save(statsFile, stats);
    } catch { /* 统计失败不影响执行 */ }
  }
  // 砍枝：某个 $try 连续多次都是第一条命中，后面的候选就是纯浪费，缩短成一个值。
  async function cutCandidates(skillId: string, steps: StepResult[], startRevision: number): Promise<CutNote[]> {
    const cuts: CutNote[] = [];
    try {
      const stats = await readStats();
      const cands = stats[skillId]?.candidates ?? {};
      const worth = Object.entries(cands).filter(([, entry]) => entry.runs >= 3 && entry.first === entry.runs);
      if (!worth.length) return cuts;
      const store = await readStore();
      const skill = store.skills.find(item => item.id === skillId);
      if (!skill) return cuts;
      const catalog = await catalogByName();
      let changed = false;
      const rebuilt = skill.steps.map(step => {
        const params: JsonObject = JSON.parse(JSON.stringify(step.params ?? {}));
        for (const [key] of worth) {
          const prefix = step.id + ".";
          if (!key.startsWith(prefix)) continue;
          const name = key.slice(prefix.length);
          const value = (params as any)[name];
          if (!record(value) || !Array.isArray((value as any).$try)) continue;
          const list = (value as any).$try as unknown[];
          if (list.length < 2) continue;
          (params as any)[name] = list[0];
          cuts.push({ key, kept: list[0], droppedCount: list.length - 1 });
          changed = true;
        }
        return { ...step, params };
      });
      if (!changed) return cuts;
      const next: Skill = { ...skill, steps: rebuilt, revision: startRevision + 1, danger: dangerFor(rebuilt, catalog, skill.danger) };
      validateSkill(next.id, next, catalog);
      await ctx.config.save(storeFile, { ...store, skills: store.skills.map(item => item.id === skill.id ? next : item) });
      console.info("砍枝 " + skill.id + "：" + cuts.map(cut => cut.key + " 保留首条、砍掉 " + cut.droppedCount + " 个候选").join("；") + "（rev " + skill.revision + "→" + next.revision + "）");
      // 砍完清掉这几条计数，避免下次重复触发
      const left = { ...cands };
      for (const cut of cuts) delete left[cut.key];
      stats[skillId] = { ...(stats[skillId] as Stat), candidates: left };
      await ctx.config.save(statsFile, stats);
    } catch (error) {
      console.warn("砍候选没做成：" + (error instanceof Error ? error.message : String(error)));
      return [];
    }
    return cuts;
  }
  function reasonsText(reasons?: Record<Reason, number>): string {
    if (!reasons) return "";
    const parts: string[] = [];
    if (reasons.input > 0) parts.push(reasons.input + " 次参数或输入不对");
    if (reasons.timeout > 0) parts.push(reasons.timeout + " 次超时，结果未知");
    if (reasons.external > 0) parts.push(reasons.external + " 次外部服务拒绝或网络问题");
    if (reasons.empty > 0) parts.push(reasons.empty + " 次上游没数据");
    if (reasons.skipped > 0) parts.push(reasons.skipped + " 次跳过了没跑成的步骤");
    if (reasons.cancelled > 0) parts.push(reasons.cancelled + " 次被取消");
    if (reasons.blocked > 0) parts.push(reasons.blocked + " 次前置条件不满足");
    if (reasons.other > 0) parts.push(reasons.other + " 次其他原因");
    return parts.join("，");
  }
  function goalTerms(text: string): string[] {
  const raw = String(text ?? "").toLowerCase();
  const out = new Set<string>();
  for (const piece of raw.match(/[a-z0-9_]+/g) ?? []) if (piece.length > 1) out.add(piece);
  for (const piece of raw.match(/[\u4e00-\u9fa5]{2,}/g) ?? []) {
    out.add(piece);
    for (let i = 0; i + 2 <= piece.length; i += 1) out.add(piece.slice(i, i + 2));
  }
  return [...out];
}
function rankByGoal(items: any[], goal: string) {
  const terms = goalTerms(goal);
  const scored = items.map(item => {
    const hay = [item.name, item.description, item.useWhen, item.notFor, item.outputs].filter(Boolean).join(" ").toLowerCase();
    const hits = terms.filter(term => hay.includes(term));
    return { item, hits, score: hits.length };
  }).filter(row => row.score > 0);
  scored.sort((a, b) => b.score - a.score);
  return scored.map(({ item, hits, score }) => ({
    id: item.id, name: item.name, revision: item.revision, danger: item.danger,
    reason: "命中：" + [...new Set(hits)].slice(0, 4).join("、"),
    requiredParams: (item.params ?? []).filter((param: any) => param.required).map((param: any) => param.name),
    ...(item.useWhen ? { useWhen: item.useWhen } : {}),
    score,
  }));
}
function hintsFor(items: { id: string; name: string }[], stats: Record<string, Stat>): string[] {
    const hints: string[] = [];
    for (const item of items) {
      const stat = stats[item.id];
      if (!stat) continue;
      const detail = reasonsText(stat.reasons);
      if (stat.streak >= 2) hints.push("「" + item.name + "」连续 " + stat.streak + " 次没跑成" + (detail ? "：" + detail : "，原因没记下") + "。");
      else if (stat.runs >= 2 && stat.ok === 0) hints.push("「" + item.name + "」跑过 " + stat.runs + " 次，一次都没成" + (detail ? "：" + detail : "，原因没记下") + "。");
    }
    if (items.length && items.every(item => !stats[item.id])) hints.push("这些都还没跑过。");
    return hints;
  }
  async function list() {
    const [store, catalog] = await Promise.all([readStore(), catalogByName()]);
    await pruneStats(new Set(store.skills.map(s => s.id)));
    const stats = await readStats();
    return store.skills.map(skill => summarize(skill, catalog, stats[skill.id]));
  }
  let saveQueue: Promise<unknown> = Promise.resolve();
  function save(id: unknown, spec: unknown, signal?: AbortSignal) {
    const pending = saveQueue.then(async () => {
      try {
        signal?.throwIfAborted();
        const settings = await readSettings();
        if (!settings.allowSave) return { status: "blocked", error: "保存已关闭，可在思维空间设置里打开。" };
        if (Buffer.byteLength(JSON.stringify(spec) ?? "") > 32 * 1024) throw new Error("单条技能不能超过 32 KiB。");
        const draft = validateSkill(id, spec, await catalogByName(), settings.maxSteps);
        const store = await readStore();
        const index = store.skills.findIndex(item => item.id === draft.id);
        if (index < 0 && store.skills.length >= 200) throw new Error("技能库已达到 200 条上限。");
        const kept = index < 0 ? 0 : Number(store.skills[index]?.revision ?? 0);
        const skill: Skill = { ...draft, revision: (Number.isFinite(kept) ? kept : 0) + 1 };
        const skills = store.skills.slice();
        if (index < 0) skills.push(skill);
        else skills[index] = skill;
        signal?.throwIfAborted();
        await ctx.config.save(storeFile, { schemaVersion: 1, skills });
        const base = String(settings.spaceUrl || "").trim().replace(/\/+$/, "");
        const canvasUrl = base ? base + "/?inject=" + Buffer.from(JSON.stringify(skill), "utf8").toString("base64url") : null;
        return { status: "ok", id: skill.id, created: index < 0, revision: skill.revision, canvasUrl };
      } catch (error) {
        return { status: "blocked", error: error instanceof Error ? error.message : "未能保存技能。" };
      }
    });
    saveQueue = pending;
    return pending;
  }
  ctx.tools.register<{ tool?: string }>({
    name: "space_ports", displayName: "看工具端口", danger: "safe",
    description: "读工具调用记录里存下来的返回值形状，反推出每个工具的输出端口路径和类型。是观测不是声明：trusted 为 true 表示同一形状出现过三次以上。拼技能或连线时用它查上一步哪个字段能接下去。",
    schema: { type: "object", additionalProperties: false,
      properties: { tool: { type: "string", description: "只看这一个工具，省略看全部" } } },
    async run(args) {
      const only = typeof args?.tool === "string" && args.tool.trim() ? args.tool.trim() : undefined;
      const list = await observePorts(only);
      if (!list.length) return { tools: [], note: only ? "这个工具没有观测记录。" : "还没有观测记录。跑过几次工具之后这里才有东西。" };
      const counted = { fields: 0, text: 0, empty: 0 };
      for (const item of list) counted[item.kind] += 1;
      const summary = `${list.length} 个工具有形状：${counted.fields} 个有字段口，${counted.text} 个是整段文本口，${counted.empty} 个空返回。`;
      return { tools: list, summary };
    },
  });
  ctx.tools.register({
    name: "space_skills", displayName: "列出思维空间技能", danger: "safe",
    description: "列出服务端技能的名称、说明、步数、权限和验证状态，并返回自动整理和允许使用技能开关状态。allowUse 为 false 时不得使用已保存技能。给了 query 就按目标检索，最多返回三个候选。",
    schema: { type: "object", properties: {
      query: { type: "string", description: "用一句话描述要办的事，按目标匹配技能；省略则列出全部" },
    }, additionalProperties: false },
    async run(args) {
      const goal = typeof args?.query === "string" && args.query.trim() ? args.query.trim() : "";
      const [skills, settings, stats, calls] = await Promise.all([list(), readSettings(), readStats(), readCalls()]);
      const items = skills.map(({ id, name, description, kind, stepCount, danger, status, revision, useWhen, notFor, outputs }) => {
        const stat = stats[id];
        return { id, name, description, kind, stepCount, danger, status, revision, useWhen, notFor, outputs,
          ...(stat ? { runs: stat.runs, lastStatus: stat.lastStatus, lastAt: stat.lastAt, failed: stat.failed, reasons: stat.reasons ?? null } : {}) };
      });
      if (goal) {
        const ranked = rankByGoal(items, goal).slice(0, 3);
        if (!ranked.length) return { status: "ok", query: goal, candidates: [],
          note: "没有匹配的技能。可以直接调工具，或者用 space_draft 起个草稿。" };
        const risky = ranked.filter(item => item.danger !== "safe");
        const riskNote = risky.length
          ? "其中有需要确认的步骤：" + risky.map(item => item.name + "（" + item.danger + "）").join("、") + "。跑的时候要传 confirmSideEffects:true。"
          : "只给匹配理由和必填参数；要看步骤再按 id 展开。";
        return { status: "ok", query: goal, candidates: ranked, note: riskNote };
      }
      const out: Record<string, unknown> = { status: "ok", allowUse: settings.allowUse,
        autoOrganize: settings.autoOrganize, allowRiskyChains: settings.allowRiskyChains, learnOnRequest: settings.learnOnRequest,
        triggerPhrase: settings.triggerPhrase, skills: items };
      if (settings.autoOrganize) {
        const hints = hintsFor(items, stats);
        if (hints.length) out.hints = hints;
        const known = new Set(skills.map(skill => skill.steps.map(step => step.tool).join("\u0000")));
        const catalog = await catalogByName();
        const readonly = new Set([...catalog.values()].filter(tool => tool.danger === "safe").map(tool => tool.name));
        const suggestions = chainsFrom(calls, settings.organizeThreshold, settings.organizeWindowMinutes, readonly)
          .filter(item => !known.has(item.tools.join("\u0000")))
          .filter(item => item.tools.every(tool => readonly.has(tool)))
          .slice(0, 5)
          .map(item => ({ tools: item.tools, count: item.count, lastAt: item.lastAt }));
        if (suggestions.length) out.suggestions = suggestions;
      }
      return out;
    },
  });
  ctx.tools.register<{ tools: string[]; name?: string; description?: string }>({
    name: "space_draft", displayName: "按工具序列起技能草稿", danger: "safe",
    description: "给一串工具名，按顺序生成技能草稿：自动填归属插件、next 链，并用真校验器预检。只返回草稿不保存，保存用 space_skill_save；建技能的守则见 space_skill_save 的说明。",
    schema: { type: "object", additionalProperties: false, required: ["tools"], properties: {
      tools: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 20 },
      name: { type: "string" }, description: { type: "string" },
    } },
    async run(args) {
      const names = Array.isArray(args?.tools) ? args!.tools.filter(item => typeof item === "string") : [];
      if (!names.length) return { status: "blocked", error: "至少要给一个工具名。" };
      const catalog = await catalogByName();
      const unknown = names.filter(item => !catalog.has(item));
      if (unknown.length) return { status: "blocked", error: "工具不存在：" + unknown.join("、") };
      const declaredParams: { name: string; type: string; required: boolean }[] = [];
      const typeOf = (schema: unknown): string => {
        const raw = record(schema) ? (schema as any).type : "string";
        return ["integer", "number", "boolean", "array", "object"].includes(raw) ? raw : "string";
      };
      const steps = names.map((tool, index) => {
        const contract = catalog.get(tool)!;
        const schema: any = contract.inputSchema ?? {};
        const required: string[] = Array.isArray(schema.required) ? schema.required : [];
        const properties: Record<string, unknown> = record(schema.properties) ? schema.properties as Record<string, unknown> : {};
        const params: Record<string, unknown> = {};
        for (const field of required) {
          const type = typeOf(properties[field]);
          const clash = declaredParams.find(item => item.name === field && item.type !== type);
          const name = clash ? "n" + (index + 1) + "_" + field : field;
          if (!declaredParams.some(item => item.name === name)) declaredParams.push({ name, type, required: true });
          params[field] = "${" + name + "}";
        }
        return { id: "n" + (index + 1), tool, plugin: contract.plugin, params,
          next: index + 1 < names.length ? "n" + (index + 2) : null };
      });
      const spec = { schemaVersion: 1, name: args?.name ?? "未命名技能",
        kind: names.length === 1 ? "single" : "composite",
        description: args?.description ?? "", params: declaredParams, steps };
      try { validateSkill("draft-preview", spec, catalog); }
      catch (error) { return { status: "blocked", error: "草稿过不了校验：" + (error instanceof Error ? error.message : String(error)) }; }
      return { status: "ok", draft: spec,
        note: "必填参数已按顺序声明为技能参数；保存前可以把它们改成前一步的字段引用。" };
    },
  });
  async function runOrganize(force: boolean) {
    const settings = await readSettings();
    if (!settings.autoOrganize && !force) return { status: "blocked", error: "自动整理已关闭，可在思维空间设置里打开。" };
    const [calls, store, catalog, paramDefaults] = await Promise.all([readCalls(), readStore(), catalogByName(), readParamDefaults()]);
    const known = new Set(store.skills.map(skill => skill.steps.map(step => step.tool).join("\u0000")));
    const readonly = new Set([...catalog.values()].filter(tool => tool.danger === "safe").map(tool => tool.name));
    const chains = chainsFrom(calls, settings.organizeThreshold, settings.organizeWindowMinutes, readonly)
      .filter(item => !known.has(item.tools.join("\u0000")));
    if (!chains.length) return { status: "ok", saved: 0, threshold: settings.organizeThreshold, scanned: calls.length, chains: [], note: "没找到重复够 " + settings.organizeThreshold + " 次的工具链。" };
    const report: { id: string; name: string; tools: string[]; status: string; error?: string }[] = [];
    let saved = 0;
    const usable: Chain[] = [];
    // 被跳过的链按工具集合聚合：同一组工具的多种排列只算一条，报告才不会被 hands_ 那类刷屏。
    const skipped = new Map<string, { tools: string[]; variants: number; reason: string }>();
    const skip = (chain: Chain, reason: string) => {
      const key = [...new Set(chain.tools)].sort().join("\u0000");
      const item = skipped.get(key) ?? { tools: chain.tools, variants: 0, reason };
      item.variants += 1;
      skipped.set(key, item);
    };
    for (const chain of chains) {
      const unknown = chain.tools.filter(tool => !catalog.has(tool));
      if (unknown.length) { skip(chain, "工具已不存在：" + unknown.join("、")); continue; }
      const dangerous = chain.tools.some(tool => (catalog.get(tool) as any)?.danger && (catalog.get(tool) as any).danger !== "safe");
      if (dangerous && !settings.allowRiskyChains) { skip(chain, "链里有需要确认的工具，不自动保存。"); continue; }
      { const why = autoFillable(chain.tools, catalog, paramDefaults); if (why) { skip(chain, why); continue; } }
      if (usable.length < 3) usable.push(chain);
    }
    for (const chain of usable) {
      const id = autoId(chain.tools);
      const name = autoName(chain.tools, catalog);
      const risky = chain.tools.some(tool => (catalog.get(tool) as any)?.danger && (catalog.get(tool) as any).danger !== "safe");
      const spec = draftSpec(chain.tools, catalog, name, "自动整理，出现 " + chain.count + " 次。" + (risky ? "含需要确认的步骤，运行到那一步会先停下来征求同意。" : ""), paramDefaults);
      const result: any = settings.autoSaveOrganized ? await save(id, spec) : { status: "ok", id, created: false };
      if (result.status === "ok") { saved += 1; report.push({ id, name, tools: chain.tools, status: "saved" }); }
      else report.push({ id, name, tools: chain.tools, status: "blocked", error: result.error });
    }
    const skippedList = [...skipped.values()].sort((a, b) => b.variants - a.variants);
    for (const item of skippedList.slice(0, 3)) {
      report.push({ id: "-", name: item.tools.join(" → ") + (item.variants > 1 ? "（同类 " + item.variants + " 种排列）" : ""),
        tools: item.tools, status: "skipped", error: item.reason });
    }
    if (skippedList.length > 3) {
      const rest = skippedList.slice(3).reduce((sum, item) => sum + item.variants, 0);
      report.push({ id: "-", name: "另有 " + (skippedList.length - 3) + " 组同类链（合计 " + rest + " 种排列）",
        tools: [], status: "skipped", error: "都含需要确认的工具或已失效的工具。" });
    }
    return { status: "ok", saved, skipped: skipped.size, threshold: settings.organizeThreshold, scanned: calls.length, chains: report };
  }

  ctx.tools.register<{ force?: boolean }>({
    name: "space_organize", displayName: "整理思维空间技能", danger: "safe",
    description: "读最近的工具调用记录，找出反复出现的工具链，按设置生成技能草稿并保存。只整理可安全执行的链，不碰需要确认的工具。自动整理关闭时需 force 才执行。",
    schema: { type: "object", additionalProperties: false, properties: { force: { type: "boolean" } } },
    async run(args) {
      return runOrganize(args?.force === true);
    },
  });
  ctx.tools.register<{ id: string; spec: unknown }>({
    name: "space_skill_save", displayName: "保存思维空间技能", danger: "ask",
    description: "新建或覆盖一条技能定义。spec 包含 schemaVersion、name、kind、params 和按顺序排列的 steps。此操作只保存定义。建技能前先看 space_skills 和工具目录，能拼现成的就不造；不同插件的工具可以串在同一条链里；缺工具就注册一个，参数写清、有副作用标 danger；链没跑通别急着存。",
    schema: { type: "object", additionalProperties: false, required: ["id", "spec"],
      properties: { id: { type: "string" }, spec: {
        type: "object", required: ["schemaVersion", "name", "kind", "params", "steps"],
        properties: {
          schemaVersion: { type: "integer", enum: [1] }, id: { type: "string" }, name: { type: "string" },
          kind: { type: "string", enum: ["single", "composite"] }, description: { type: "string" },
          params: { type: "array", items: { type: "object", required: ["name", "type", "required"], properties: {
            name: { type: "string" }, type: { type: "string", enum: types }, required: { type: "boolean" },
          } } },
          steps: { type: "array", items: { type: "object", required: ["id", "tool", "params", "next"], properties: {
            id: { type: "string" }, tool: { type: "string" }, plugin: { type: "string" }, params: { type: "object" },
            next: { type: ["string", "null"], description: "下一个步骤的 ID，末步填 null。" },
          } } },
        },
      } } },
    run(args, session) { return save(args?.id, args?.spec, session.signal); },
  });
  // ---- 第二阶段：真执行 ----
  let runSeq = 0;
  ctx.tools.register<{ id: string; params?: JsonObject; confirmSideEffects?: boolean; via?: "user" | "self" }>({
    name: "space_run", displayName: "运行思维空间技能", danger: "safe",
    description: "按技能定义依次执行各步骤，参数中的 ${名称} 与 ${步骤id.字段路径} 会在运行时填成真实值。只读链直接跑；链里含写文件、执行命令、发图、发声等副作用步骤时，须显式传 confirmSideEffects:true。失败分六态：ok 正常；empty 上游无数据、后续步骤未启动；failed 可重试；uncertain 结果未知不得自动重试；blocked 缺前置条件；skipped 这一步没结果但后面不依赖它，已继续。运行期间技能被改过时会带 staleDefinition。",
    schema: { type: "object", additionalProperties: false, required: ["id"],
      properties: {
        id: { type: "string" },
        params: { type: "object" },
        taskId: { type: "string", description: "任务 ID，可省略。同一个 ID 重复提交只回查已有结果，不会重新执行；超时后先查再决定要不要重跑。" },
        confirmSideEffects: { type: "boolean", description: "链中含副作用步骤时必须显式为 true。" },
        via: { type: "string", enum: ["user", "self"], description: "谁发起的，只用于统计：用户明确点名这条技能填 user；自己判断该用填 self（默认）。" },
      } },
    async run(args, session) {
      const taskId = String((args as any)?.taskId ?? "").trim().slice(0, 80);
      if (taskId) {
        const prior = taskRuns.get(taskId);
        const cached = prior && Date.now() - prior.at < TASK_REUSE_MS ? traces.get(prior.runId) : undefined;
        if (cached) return { ...(cached as any), reusedTask: taskId,
          note: "任务 " + taskId + " 已经跑过，返回当时的结果，没有重新执行。" } as any;
      }
      const runId = "run_" + Date.now().toString(36) + "_" + (++runSeq);
      const settings = await readSettings();
      if (!settings.allowUse) return blocked(runId, args?.id ?? "", "设置里关掉了「允许使用整理好的技能」。");
      let skill: Skill;
      try {
        const store = await readStore();
        const found = store.skills.find(item => item.id === args?.id);
        if (!found) return blocked(runId, args?.id ?? "", "找不到这条技能。" + (skillsBrief ? " " + skillsBrief : " 技能库里还没有保存任何技能。"));
        skill = found;
      } catch (error) {
        return blocked(runId, args?.id ?? "", error instanceof Error ? error.message : "技能库读不到。");
      }
      // 坏记录（steps 空、不是数组）不能当「零步骤、跑完 ok」：那看着像成功，其实什么也没做。
      if (!Array.isArray(skill.steps) || !skill.steps.length) {
        return blocked(runId, skill.id, "这条技能没有步骤，不能运行。旧记录可能已经坏了，删掉重存一次。");
      }
      const rawGiven = args?.params && record(args.params) ? args.params : {};
      const startRevision = Number(skill.revision ?? 0);
      const givenIds = pickParam(skill, rawGiven);
      const missing = missingParams(skill, rawGiven);
      if (missing.length) return blocked(runId, skill.id, "缺少必填参数：" + missing.join("、"));

      // 预检：所有步骤的工具必须存在、归属一致
      const catalog = await catalogByName();
      const unavailable: string[] = [];
      for (const step of skill.steps) {
        const tool = catalog.get(step.tool);
        if (!tool || (tool.plugin && tool.plugin !== step.plugin)) unavailable.push(step.id + " " + step.tool);
      }
      // 危险等级统一走 dangerFor：跟界面、加壳、复算同一个口径。
      // 不再「工具没有 danger 就回落存盘的 skill.danger」——那条路会把未知降成 safe。
      const resolvedDanger = dangerFor(skill.steps, catalog, skill.danger);
      const sideEffects = resolvedDanger !== "safe" || skill.steps.some(step => sideEffectTools.has(step.tool));
      if (unavailable.length) return blocked(runId, skill.id, "工具不可用：" + unavailable.join("、"),
        skill.steps.map(step => ({ id: step.id, tool: step.tool, plugin: step.plugin, status: "blocked" as RunStatus, elapsedMs: 0, input: null, output: null })));
      if (sideEffects && args?.confirmSideEffects !== true)
        return blocked(runId, skill.id, "这条技能含副作用步骤（写入、执行、发送或发声），需要 confirmSideEffects:true 才会跑。",
          skill.steps.map(step => ({ id: step.id, tool: step.tool, plugin: step.plugin, status: "blocked" as RunStatus, elapsedMs: 0, input: null, output: null })));

      const callerPermission = String((session as any)?.permission ?? "ask");
      const stepTimeout = (await readSettings()).stepTimeoutSeconds;
      const steps: StepResult[] = [];
      const previous = new Map<string, unknown>();
      let lastStatus: RunStatus = "ok";
      for (const step of skill.steps) {
        if (session.signal?.aborted) { lastStatus = "uncertain"; break; }
        const filledStep = fill(step.params, givenIds as JsonObject, previous) as JsonObject;
        const rankInfo = resolveRank(filledStep);
        if (rankInfo.error) {
          steps.push({ id: step.id, tool: step.tool, plugin: step.plugin, status: "failed", elapsedMs: 0, input: null, output: null,
            error: rankInfo.error });
          lastStatus = "failed";
          break;
        }
        const plans = expandTry(filledStep, rankInfo.rank);
        if (!plans.length) {
          steps.push({ id: step.id, tool: step.tool, plugin: step.plugin, status: "empty", elapsedMs: 0, input: null, output: null,
            error: rankInfo.rank !== undefined
              ? "指定的第 " + rankInfo.rank + " 条候选没有有效链接，没有发起读取。"
              : "候选值全都取不到，这一步没有可试的输入。" });
          lastStatus = "empty";
          break;
        }
        const tryKeys = Object.keys(step.params).filter(key => record((step.params as any)[key]) && Array.isArray((step.params as any)[key].$try));
        let input: JsonObject = plans[0];
        let hitIndex = -1;
        const attempts: { value: unknown; status: string; elapsedMs: number; error?: string }[] = [];
        const started = Date.now();
        try {
          let raw: any = null;
          let elapsedMs = 0;
          for (let i = 0; i < plans.length; i++) {
            const plan = plans[i];
            const t0 = Date.now();
            input = plan;
            try {
              if (step.tool === LLM_TOOL) {
                raw = await withTimeout(callLlm(plan), stepTimeout, LLM_TOOL);
                elapsedMs = Date.now() - t0;
                hitIndex = 0;
                break;
              }
              raw = await withTimeout(ctx.tools.call(step.tool, plan, {
                id: runId, permission: callerPermission, origin: { plugin: "thinking-space", action: step.id },
              } as any), stepTimeout, step.tool);
              elapsedMs = Date.now() - t0;
            } catch (error) {
              const m = error instanceof Error ? error.message : String(error);
              attempts.push({ value: plan[Object.keys(plan).find(k => JSON.stringify(plan[k]) !== JSON.stringify(plans[0]?.[k])) ?? ""] ?? null, status: "failed", elapsedMs: Date.now() - t0, error: m });
              if (i === plans.length - 1) throw error;
              continue;
            }
            const peek = raw && record(raw) && Object.hasOwn(raw, "result") ? (raw as any).result : raw;
            const bad = (peek && record(peek) && (peek as any).status === "error" ? (peek as any).error : null) ?? smellBusinessFailure(peek);
            const shown = tryKeys.length ? plan[tryKeys[0]] : null;
            if (bad) {
              const m = typeof bad === "string" ? bad : [bad?.code, bad?.message].filter(Boolean).join("：") || "业务错误";
              attempts.push({ value: shown, status: "failed", elapsedMs, error: m });
              if (i === plans.length - 1) break;
              continue;
            }
            hitIndex = i;
            if (i > 0) attempts.push({ value: shown, status: "ok", elapsedMs });
            break;
          }
          const output = raw && record(raw) && Object.hasOwn(raw, "result") ? raw.result : raw;
          // 工具把业务失败包成 {status:"error"} 返回，宿主 ok 仍为 true；这里按业务状态判失败。
          const business = output && record(output) && (output as any).status === "error" ? (output as any).error : null;
          const smelled = business ?? smellBusinessFailure(output);
          if (smelled) {
            const message = typeof smelled === "string" ? smelled
              : [smelled?.code, smelled?.message].filter(Boolean).join("：") || "工具返回了业务错误。";
            if (!dependents(skill, step.id).length) {
              steps.push({ id: step.id, tool: step.tool, plugin: step.plugin, status: "skipped", elapsedMs, input, output: null,
                error: message, ...(attempts.length ? { attempts } : {}) });
              lastStatus = "skipped";
              continue;
            }
            steps.push({ id: step.id, tool: step.tool, plugin: step.plugin, status: "failed", elapsedMs, input, output: null, error: message, ...(attempts.length ? { attempts } : {}) });
            lastStatus = "failed";
            break;
          }
          steps.push({ id: step.id, tool: step.tool, plugin: step.plugin, status: "ok", elapsedMs, input, output, ...(attempts.length ? { attempts } : {}),
            ...(tryKeys.length && (hitIndex >= 0 || rankInfo.rank !== undefined) ? { tries: [{ key: tryKeys[0],
            hit: rankInfo.rank !== undefined ? rankInfo.rank - 1 : hitIndex,
            total: rankInfo.total ?? plans.length,
            ...(rankInfo.rank !== undefined ? { requested: rankInfo.rank } : {}) }] } : {}) });
          previous.set(step.id, output);
          // 上游没产出：结果为空，或下一步参数里仍留着解析不了的占位符 → empty，后续步骤不启动
          {
            const nextStep = skill.steps.find(item => item.id === step.next);
            if (nextStep && (isEmptyFeed(output) || unresolved(withoutMeta(fill(nextStep.params, givenIds as JsonObject, previous))))) {
              if (!dependents(skill, step.id).length) {
                const last = steps[steps.length - 1];
                if (last && last.id === step.id) {
                  last.status = "skipped";
                  last.error = "这一步没有产出。";
                  last.output = null;
                }
                lastStatus = "skipped";
                continue;
              }
              lastStatus = "empty";
              break;
            }
          }
        } catch (error) {
          const elapsedMs = Date.now() - started;
          const message = error instanceof Error ? error.message : String(error);
          const status: RunStatus = /超时|timeout|结果未知/i.test(message) ? "uncertain" : "failed";
          steps.push({ id: step.id, tool: step.tool, plugin: step.plugin, status, elapsedMs, input, output: null, error: message, ...(attempts.length ? { attempts } : {}) });
          lastStatus = status;
          break;
        }
      }
      // 读到东西不等于读对了：拿用户那句查询跟最后一步的正文比一下字面重合。
      const queryText = Object.values(givenIds).find(value => typeof value === "string" && (value as string).trim().length >= 2) as string | undefined;
      const lastOk = [...steps].reverse().find(item => item.status === "ok" && item.output !== null && item.output !== undefined);
      const relevance = lastStatus === "ok" && lastOk ? checkRelevance(queryText, lastOk.output) : null;
      // 全部步骤都被跳过，等于一步都没干成：不能报 skipped 让人以为没事，抬成 failed
      const allSkipped = steps.length > 0 && steps.every(item => item.status === "skipped");
      if (allSkipped) lastStatus = "failed";
      await bumpStat(skill.id, lastStatus, steps[steps.length - 1]?.error ?? "", (session as any)?.origin?.action === "web_run" ? "page" : (args?.via === "user" ? "user" : "self"));
      const result: RunResult & { staleDefinition?: boolean; definitionRevision?: number } = { status: lastStatus, runId, skill: skill.id, steps, ...(relevance ? { relevance } : {}) };
      if (allSkipped) result.error = "所有步骤都没跑成，这条技能什么都没做。第一步：" + (steps[0]?.error ?? "没有给出原因");
      else if (lastStatus === "empty") result.error = "上游没有产出数据，后续步骤没有启动。";
      else if (lastStatus === "skipped") result.error = "有步骤没跑成，但后面的步骤不依赖它，已继续跑到最后：" + steps.filter(item => item.status === "skipped").map(item => item.id + "（" + (item.error ?? "没有产出") + "）").join("、");
      else if (lastStatus !== "ok") result.error = steps[steps.length - 1]?.error ?? "执行中断。";
      try {
        const latest = (await readStore()).skills.find(item => item.id === skill.id);
        const nowRevision = Number(latest?.revision ?? 0);
        if (Number.isFinite(nowRevision) && nowRevision !== startRevision) {
          result.staleDefinition = true;
          result.definitionRevision = nowRevision;
          result.error = [result.error, "这条技能在运行期间被改过（现在 rev " + nowRevision + "，这次跑的是 rev " + startRevision + " 的定义）。"].filter(Boolean).join(" ");
        }
      } catch { /* 读不回来不影响结果 */ }
      remember(runId, result);
      // 只记跑完的：参数没填全就拦下的不记，否则填错一次就再也跑不动了。
      if (taskId) taskRuns.set(taskId, { runId, at: Date.now() });
      if (lastStatus === "ok") {
        await bumpCandidates(skill.id, steps);
        const plan = await planTrim(skill.id, steps, startRevision);
        const cuts = await cutCandidates(skill.id, steps, plan?.note.revision ?? startRevision);
        if (plan) {
          if (cuts.length) plan.note.cut = cuts;
          trimSuggestions.set(skill.id, plan);
          result.trimSuggestion = plan.note;
          remember(runId, result);
        }
        else if (cuts.length) {
          const latest = (await readStore()).skills.find(item => item.id === skill.id);
          const from = latest?.steps.length ?? 0;
          result.trimmed = { from, to: from, dropped: [], revision: Number(latest?.revision ?? startRevision + 1), cut: cuts };
          remember(runId, result);
        }
      }
      return result;
    },
  });
  ctx.tools.register<{ skill: string; apply: boolean }>({
    name: "space_trim", displayName: "确认精简技能", danger: "ask",
    description: "技能跑通后如果发现某一步白跑，会攒一条精简建议，不会自己改。用这个确认：apply 为 true 才真删那几步；false 表示这次先不动，建议丢弃。",
    schema: { type: "object", additionalProperties: false, required: ["skill", "apply"], properties: { skill: { type: "string", description: "技能 id" }, apply: { type: "boolean", description: "true 应用建议，false 丢弃" } } },
    async run(args) {
      const id = String(args?.skill ?? "").trim();
      if (!id) return { status: "blocked", error: "缺少技能 id。" };
      if (args?.apply === false) { trimSuggestions.delete(id); return { status: "ok", applied: false, message: "建议已丢弃，技能没有改动。" }; }
      const out = await applyTrim(id);
      if (typeof out === "string") return { status: "blocked", error: out };
      return { status: "ok", applied: true, trimmed: out, message: "已按建议精简：" + out.from + " 步 → " + out.to + " 步（rev " + out.revision + "）。" };
    },
  });
  ctx.tools.register<{ runId?: string }>({
    name: "space_trace", displayName: "查询技能运行回执", danger: "safe",
    description: "按 runId 取回一次运行的每一步：状态、耗时、实际传入参数和输出摘要。不带 runId 时列出最近几次。回执只在内存里留一小时，重启后查不到。",
    schema: { type: "object", additionalProperties: false, properties: { runId: { type: "string" } } },
    async run(args) {
      if (args?.runId) {
        const hit = traces.get(args.runId);
        if (!hit) return { status: "ok", found: false, runId: args.runId };
        return { status: "ok", found: true, trace: hit };
      }
      return { status: "ok", recent: [...traces.entries()].slice(-10).reverse().map(([id, item]) =>
        ({ runId: id, skill: item.skill, status: item.status, steps: item.steps.length })) };
    },
  });
  const settingsStats = async () => {
    const [settings, skills] = await Promise.all([readSettings(), list()]);
    return renderSettings(settings, {
      total: skills.length,
      single: skills.filter(skill => skill.kind === "single").length,
      composite: skills.filter(skill => skill.kind === "composite").length,
    });
  };
  ctx.web.page(pagePath, async (req, res) => {
    try {
      const query = new URL(req.url ?? "/", "http://localhost").searchParams;
      const imported = query.get("imported") ?? "";
      const importErr = query.get("import_err") ?? "";
      const banner = imported
        ? `<p class="space-notice ok">${escape(imported)}</p>`
        : importErr
          ? `<p class="space-notice err">${escape(importErr)}</p>`
          : "";
      const body = banner + await settingsStats();
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(html("思维空间", body));
    } catch {
      res.writeHead(503, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(html("思维空间", "<p>暂时读不到技能库，请检查插件数据。</p>"));
    }
  }, { title: "思维空间", navigation: true, settings: true });
  ctx.web.page(pagePath + "space", async (req, res) => {
    try {
      const query = new URL(req.url ?? "/", "http://localhost").searchParams;
      const ran = query.get("ran") ?? "";
      const failed = query.get("ran_err") ?? "";
      const organized = query.get("organized");
      const deleted = query.get("deleted") ?? "";
      const receipt = ran
        ? renderReceipt(traces.get(ran))
        : failed
          ? `<section class="space-panel"><h2>没能跑</h2><p>${escape(failed)}</p></section>`
          : "";
      const [skills, stats, settings] = await Promise.all([list(), readStats(), readSettings()]);
      const withStats = skills.map((skill) => {
        const stat = stats[skill.id];
        return { ...skill, ...(stat ? { runs: stat.runs, lastStatus: stat.lastStatus, sources: stat.sources, okCount: stat.ok ?? 0, failedCount: stat.failed ?? 0, lastAt: stat.lastAt ?? "", reasons: stat.reasons ?? {} } : {}) };
      });
      const trendDays = (() => { const raw = Number(query.get("days") ?? 7); return raw === 1 || raw === 7 || raw === 30 ? raw : 7; })();
      const trendPanel = renderTrend(await readRunsSeeded(), trendDays, skills);
      const hints = settings.autoOrganize ? hintsFor(withStats, stats) : [];
            const organizePanel = organized === null ? "" : `<section class="space-panel"><h2>整理结束</h2><p>${escape(organizeNote(Number(organized), Number(query.get("scanned") ?? 0), Number(query.get("threshold") ?? 0), Number(query.get("skipped") ?? 0)))}</p></section>`;
      const organizeButton = `<form method="post" action="/plugins/thinking-space/organize" style="display:inline-flex;margin:0 0 0 10px"><button class="btn space-secondary" type="submit">立即整理</button></form>`;
      const deletedPanel = deleted
        ? `<section class="space-panel"><h2>删掉了</h2><p>「${escape(deleted)}」已经从技能库里移除，统计和待确认建议一并清掉。</p></section>`
        : "";
      const shellButton = `<a class="btn space-secondary" href="/plugins/thinking-space/shells/">生成壳 →</a>`;
      const body = `<div class="space-toolbar"><a class="btn space-secondary" href="${pagePath}">← 返回设置</a>${organizeButton}${shellButton}</div>` + receipt + organizePanel + deletedPanel + trendPanel + renderUsage(withStats, stats, await readCalls()) + renderSkills(withStats, hints);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(html("思维空间", body));
    } catch {
      res.writeHead(503, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(html("思维空间", "<p>技能库暂时不可用，请检查插件数据和工具目录。</p>"));
    }
  }, { title: "思维空间", navigation: false });
  ctx.web.page("/plugins/thinking-space/edit", async (req, res) => {
    try {
      const query = new URL(req.url ?? "/", "http://localhost").searchParams;
      const id = (query.get("id") ?? "").trim();
      const skills = await list();
      const skill = skills.find(item => item.id === id);
      if (!skill) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        res.end(html("编辑技能", `<div class="space-toolbar"><a class="btn space-secondary" href="/plugins/thinking-space/space">← 返回技能列表</a></div><section class="space-panel"><h2>找不到这条技能</h2><p class="space-muted">技能 ID：${escape(id || "（空）")}</p></section>`));
        return;
      }
      const tools = (await toolsSafe()).map(tool => tool.name).sort();
      const saved = query.get("saved") === "1";
      const notice = saved ? `已保存。${skill.steps.length} 个步骤都在，下次运行会用新参数。` : (query.get("err") ?? "");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(html("编辑技能", renderEdit(skill, tools, notice, saved)));
    } catch {
      res.writeHead(503, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(html("编辑技能", "<p>暂时读不到技能库，请检查插件数据。</p>"));
    }
  }, { title: "思维空间", navigation: false });
  ctx.web.api("/plugins/thinking-space/edit", async (req: any, res: any) => {
    let id = "";
    const go = (query: string) => {
      res.writeHead(303, { Location: "/plugins/thinking-space/edit?id=" + encodeURIComponent(id) + query });
      res.end();
    };
    try {
      const form = await readPayload(req, 65536);
      id = (form.get("id") ?? "").trim();
      const store = await readStore();
      const skill = store.skills.find(item => item.id === id) as any;
      if (!skill) throw new Error("找不到这条技能。");
      const steps: any[] = skill.steps.map((step: any) => ({
        id: step.id, tool: step.tool, plugin: step.plugin, params: JSON.parse(JSON.stringify(step.params ?? {})), next: step.next,
      }));
      const op = (form.get("op") ?? "save").trim();
      const indexOf = (raw: string) => steps.findIndex(step => step.id === raw);
      if (op.startsWith("del:")) {
        const index = indexOf(op.slice(4));
        if (index < 0) throw new Error("找不到要删除的步骤。");
        if (steps.length - 1 < (skill.kind === "single" ? 1 : 2)) throw new Error(skill.kind === "single" ? "单步技能不能删到没有步骤。" : "复合技能至少要有 2 步，删掉这一个就只剩 1 步了。");
        steps.splice(index, 1);
      } else if (op.startsWith("up:") || op.startsWith("down:")) {
        const index = indexOf(op.slice(op.indexOf(":") + 1));
        if (index < 0) throw new Error("找不到要移动的步骤。");
        const target = op.startsWith("up:") ? index - 1 : index + 1;
        if (target < 0 || target >= steps.length) throw new Error("这一步已经到头了。");
        const moved = steps[index];
        steps[index] = steps[target];
        steps[target] = moved;
      } else if (op === "add") {
        const tool = (form.get("add_tool") ?? "").trim();
        if (!tool) throw new Error("新增步骤要先选一个工具。");
        const raw = (form.get("add_params") ?? "").trim() || "{}";
        let params: unknown;
        try { params = JSON.parse(raw); } catch { throw new Error("新增步骤的参数不是合法 JSON。"); }
        if (!record(params)) throw new Error("新增步骤的参数须为 JSON 对象。");
        const used = new Set(steps.map(step => step.id));
        let fresh = "";
        for (let i = 1; i <= 99; i++) if (!used.has("n" + i)) { fresh = "n" + i; break; }
        if (!fresh) throw new Error("步骤 ID 已用完。");
        steps.push({ id: fresh, tool, plugin: undefined, params, next: null });
      }
      for (const [key, value] of form) {
        if (!key.startsWith("params:")) continue;
        const step = steps.find(item => item.id === key.slice(7));
        if (!step) continue;
        const raw = value.trim();
        if (!raw) continue;
        let params: unknown;
        try { params = JSON.parse(raw); } catch { throw new Error(step.id + " 的参数不是合法 JSON。"); }
        if (!record(params)) throw new Error(step.id + " 的参数须为 JSON 对象。");
        step.params = params;
      }
      steps.forEach((step, index) => { step.next = index === steps.length - 1 ? null : steps[index + 1].id; });
      const declared = new Set<string>((skill.params ?? []).map((param: any) => param.name));
      const broken = referenceErrors(steps, declared);
      if (broken.length) throw new Error(broken.join(" "));
      const spec = {
        schemaVersion: 1,
        id: skill.id,
        name: ((form.get("name") ?? "") || skill.name).trim().slice(0, 80) || skill.name,
        description: ((form.get("description") ?? "") || "").trim().slice(0, 500),
        kind: skill.kind,
        params: skill.params,
        steps,
      };
      const result: any = await save(id, spec);
      if (result?.status !== "ok") throw new Error(result?.error ?? "保存失败。");
      go("&saved=1");
    } catch (error) {
      go("&err=" + encodeURIComponent((error instanceof Error ? error.message : "保存失败。").slice(0, 300)));
    }
  });
  ctx.web.api("/plugins/thinking-space/organize", async (_req: any, res: any) => {
    const back = pagePath + "space";
    try {
      const result: any = await runOrganize(true);
      if (result?.status !== "ok") {
        res.writeHead(303, { Location: back + "?ran_err=" + encodeURIComponent(result?.error ?? "整理没有跑成。") });
        res.end();
        return;
      }
      const q = new URLSearchParams({ organized: String(result.saved ?? 0), scanned: String(result.scanned ?? 0), threshold: String(result.threshold ?? 0), skipped: String((result as any).skipped ?? 0) });
      res.writeHead(303, { Location: back + "?" + q.toString() });
      res.end();
    } catch (error) {
      res.writeHead(303, { Location: back + "?ran_err=" + encodeURIComponent(error instanceof Error ? error.message : "整理失败。") });
      res.end();
    }
  });
  ctx.web.api("/plugins/thinking-space/run", async (req: any, res: any) => {
    const back = pagePath + "space";
    try {
      const form = await readPayload(req);
      const id = (form.get("id") ?? "").trim();
      const given: Record<string, unknown> = {};
      for (const [key, value] of form) if (key.startsWith("p:")) given[key.slice(2)] = value;
      const raw: any = await ctx.tools.call("space_run", {
        id, params: given, confirmSideEffects: form.get("confirmSideEffects") === "on",
      }, { permission: "ask", origin: { plugin: "thinking-space", action: "web_run" } } as any);
      const result = raw && record(raw) && Object.hasOwn(raw, "result") ? raw.result : raw;
      const runId = result && record(result) && typeof (result as any).runId === "string" ? (result as any).runId : "";
      res.writeHead(303, { Location: back + (runId ? "?ran=" + encodeURIComponent(runId) : "?ran_err=" + encodeURIComponent("没有拿到回执。")) });
      res.end();
    } catch (error) {
      const message = error instanceof Error ? error.message : "运行失败。";
      res.writeHead(303, { Location: back + "?ran_err=" + encodeURIComponent(message) });
      res.end();
    }
  });
  ctx.web.api("/plugins/thinking-space/delete", async (req: any, res: any) => {
    const back = pagePath + "space";
    try {
      const form = await readPayload(req, 65536);
      const id = (form.get("id") ?? "").trim();
      if (!id) throw new Error("没有给出要删的技能。");
      const store = await readStore();
      const found = store.skills.find(item => item.id === id);
      if (!found) throw new Error("找不到这条技能，可能已经被删了。");
      await ctx.config.save(storeFile, { ...store, skills: store.skills.filter(item => item.id !== id) });
      trimSuggestions.delete(id);
      try {
        const stats = await readStats();
        if (Object.hasOwn(stats, id)) { delete stats[id]; await ctx.config.save(statsFile, stats); }
      } catch { /* 统计清不掉不影响删除 */ }
      res.writeHead(303, { Location: back + "?deleted=" + encodeURIComponent(found.name || id) });
      res.end();
    } catch (error) {
      res.writeHead(303, { Location: back + "?ran_err=" + encodeURIComponent(error instanceof Error ? error.message : "删除失败。") });
      res.end();
    }
  });
  ctx.web.api(pagePath, async (req: any, res: any) => {
    try {
      const form = await readPayload(req);
      const raw = Math.floor(Number(form.get("maxSteps")));
      const rawUrl = (form.get("spaceUrl") ?? "").trim();
      await ctx.config.save(settingsFile, {
        allowSave: form.get("allowSave") === "on",
        allowUse: form.get("allowUse") === "on",
        autoOrganize: form.get("autoOrganize") === "on",
        spaceUrl: /^https?:\/\/[^\s]+$/.test(rawUrl) ? rawUrl.slice(0, 300) : defaultSpaceUrl,
        maxSteps: raw >= 1 && raw <= 20 ? raw : 20,
        organizeThreshold: (() => { const n = Math.floor(Number(form.get("organizeThreshold"))); return n >= 2 && n <= 10 ? n : 3; })(),
        organizeWindowMinutes: (() => { const n = Math.floor(Number(form.get("organizeWindowMinutes"))); return n >= 5 && n <= 1440 ? n : 120; })(),
        autoSaveOrganized: form.get("autoSaveOrganized") === "on",
        observeHands: form.get("observeHands") === "on",
        allowRiskyChains: form.get("allowRiskyChains") === "on",
        learnOnRequest: form.get("learnOnRequest") === "on",
        triggerPhrase: (() => { const v = String(form.get("triggerPhrase") ?? "").trim(); return v ? v.slice(0, 80) : defaultTriggerPhrase; })(),
      });
      res.writeHead(303, { Location: pagePath });
      res.end();
    } catch (error) {
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(html("思维空间设置", `<p>没有保存：${escape(error instanceof Error ? error.message : "")}</p><p><a href="${pagePath}">返回</a></p>`));
    }
  });
  ctx.web.page("/plugins/thinking-space/export", async (_req: any, res: any) => {
    try {
      const store = await readStore();
      const payload = JSON.stringify({ schemaVersion: 1, exportedAt: new Date().toISOString(), skills: store.skills }, null, 2);
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": 'attachment; filename="thinking-space-skills.json"',
        "Cache-Control": "no-store",
      });
      res.end(payload);
    } catch (error) {
      res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(error instanceof Error ? error.message : "导出失败。");
    }
  });
  ctx.web.api("/plugins/thinking-space/import", async (req: any, res: any) => {
    try {
      const form = await readPayload(req, 512 * 1024);
      const raw = (form.get("payload") ?? "").trim();
      if (!raw) throw new Error("没有内容可导入。");
      let parsed: any;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error("不是合法的 JSON，检查一下有没有截断或多余字符。");
      }
      const incoming = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.skills) ? parsed.skills : null;
      if (!incoming) throw new Error("格式不对：需要 {\"skills\": [...]} 或一个数组。");
      let created = 0;
      let overwritten = 0;
      const failed: string[] = [];
      for (const item of incoming) {
        const id = item && typeof item.id === "string" ? item.id.trim() : "";
        if (!id) { failed.push("（缺少 id）"); continue; }
        const result: any = await save(id, item);
        if (result && result.status === "ok") { if (result.created) created += 1; else overwritten += 1; }
        else failed.push(id + "：" + (result?.error ?? "未保存"));
      }
      const note = "导入完成：新增 " + created + " 条，覆盖 " + overwritten + " 条" +
        (failed.length ? "，" + failed.length + " 条没成（" + failed.slice(0, 3).join("；") + "）" : "") + "。";
      res.writeHead(303, { Location: pagePath + "?imported=" + encodeURIComponent(note) });
      res.end();
    } catch (error) {
      const message = error instanceof Error ? error.message : "导入失败。";
      res.writeHead(303, { Location: pagePath + "?import_err=" + encodeURIComponent(message) });
      res.end();
    }
  });
  ctx.web.page("/plugins/thinking-space/skill", async (req: any, res: any) => {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify(body));
    };
    try {
      const url = new URL(String(req.url ?? "/"), "http://localhost");
      const id = String(url.searchParams.get("id") ?? "").trim();
      if (!id) { json(400, { ok: false, error: "缺少 id 参数。" }); return; }
      const store = await readStore();
      const skill = store.skills.find((item) => item && item.id === id);
      if (!skill) { json(404, { ok: false, error: "没有这条技能：" + id }); return; }
      json(200, { ok: true, skill });
    } catch (error) {
      json(500, { ok: false, error: error instanceof Error ? error.message : "读取失败。" });
    }
  }, { title: "技能定义", navigation: false });
  ctx.web.page("/plugins/thinking-space/tools", async (_req: any, res: any) => {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify(body));
    };
    try {
      const list = await toolsSafe();
      const tools = (Array.isArray(list) ? list : []).map((tool: any) => ({
        name: String(tool?.name ?? ""),
        displayName: String(tool?.displayName ?? tool?.name ?? ""),
        category: String(tool?.category ?? ""),
        plugin: String(tool?.plugin ?? ""),
        danger: String(tool?.danger ?? "ask"),
        inputSchema: tool?.inputSchema ?? null,
        visibleInputs: Array.isArray(tool?.visibleInputs) ? tool.visibleInputs : [],
        outputSchema: tool?.outputSchema ?? null,
        visibleOutputs: Array.isArray(tool?.visibleOutputs) ? tool.visibleOutputs : [],
      })).filter((tool: any) => tool.name);
      json(200, { ok: true, count: tools.length, tools });
    } catch (error) {
      json(500, { ok: false, error: error instanceof Error ? error.message : "读取工具目录失败。" });
    }
  }, { title: "工具目录", navigation: false });
  ctx.web.page("/plugins/thinking-space/skills", async (_req: any, res: any) => {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify(body));
    };
    try {
      const items = await list();
      const skills = items.map((skill: any) => ({
        id: String(skill?.id ?? ""),
        name: String(skill?.name ?? skill?.id ?? ""),
        description: String(skill?.description ?? ""),
        kind: String(skill?.kind ?? "single"),
        stepCount: Number(skill?.steps?.length ?? 0),
        steps: (Array.isArray(skill?.steps) ? skill.steps : []).map((step: any) => ({
          id: String(step?.id ?? ""),
          tool: String(step?.tool ?? ""),
          plugin: String(step?.plugin ?? ""),
          available: step?.available !== false,
        })),
        danger: String(skill?.danger ?? "safe"),
        status: String(skill?.status ?? "仅声明"),
        revision: Number(skill?.revision ?? 0),
        useWhen: String(skill?.useWhen ?? ""),
        notFor: String(skill?.notFor ?? ""),
      })).filter((skill: any) => skill.id);
      const settings = await readSettings();
      json(200, {
        ok: true,
        total: skills.length,
        single: skills.filter((skill: any) => skill.kind !== "composite").length,
        composite: skills.filter((skill: any) => skill.kind === "composite").length,
        allowUse: !!settings.allowUse,
        syncedAt: new Date().toISOString(),
        skills,
      });
    } catch (error) {
      json(500, { ok: false, error: error instanceof Error ? error.message : "读取技能库失败。" });
    }
  }, { title: "技能组", navigation: false });
  ctx.web.page("/plugins/thinking-space/flows", async (req: any, res: any) => {
    try {
      const stored = await ctx.config.read<{ savedAt?: string; snapshot?: unknown }>(flowsFile);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ ok: true, savedAt: stored?.savedAt ?? null, snapshot: stored?.snapshot ?? null }));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "读取失败。" }));
    }
  }, { title: "画布快照", navigation: false });
  ctx.web.api("/plugins/thinking-space/flows", async (req: any, res: any) => {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify(body));
    };
    try {
      const method = String(req.method ?? "GET").toUpperCase();
      if (method === "GET") {
        const stored = await ctx.config.read<{ savedAt?: string; snapshot?: unknown }>(flowsFile);
        return json(200, { ok: true, savedAt: stored?.savedAt ?? null, snapshot: stored?.snapshot ?? null });
      }
      if (method !== "POST") return json(405, { ok: false, error: "只支持 GET 和 POST。" });
      const raw = await readBody(req, 4 * 1024 * 1024);
      const parsed = JSON.parse(raw || "{}");
      const snapshot = parsed?.snapshot;
      if (!snapshot || typeof snapshot !== "object") throw new Error("缺少 snapshot 字段。");
      const savedAt = typeof (snapshot as any).savedAt === "string" ? (snapshot as any).savedAt : new Date().toISOString();
      await ctx.config.save(flowsFile, { savedAt, snapshot });
      return json(200, { ok: true, savedAt, bytes: Buffer.byteLength(raw, "utf8") });
    } catch (error) {
      return json(400, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  ctx.web.api("/plugins/thinking-space/publish", async (req: any, res: any) => {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify(body));
    };
    try {
      if (String(req.method ?? "GET").toUpperCase() !== "POST") return json(405, { ok: false, error: "只支持 POST。" });
      const raw = await readBody(req, 256 * 1024);
      const parsed = JSON.parse(raw || "{}");
      const spec = parsed?.skill;
      if (!record(spec) || typeof (spec as any).id !== "string") throw new Error("缺少 skill 或 skill.id。");
      const result = await save((spec as any).id, spec);
      if (result.status !== "ok") return json(422, { ok: false, error: result.error ?? "技能没有保存。" });
      return json(200, { ok: true, id: result.id, created: result.created === true, revision: result.revision });
    } catch (error) {
      return json(400, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  ctx.web.page(pagePath + "local", async (_req: any, res: any) => {
    try {
      const tools = await toolsSafe();
      const byPlugin = new Map<string, number>();
      for (const tool of tools) {
        const key = String(tool.plugin || "").trim() || "未标注";
        byPlugin.set(key, (byPlugin.get(key) ?? 0) + 1);
      }
      const catalogOn = hasToolCatalog();
      const listOn = hasToolList();
      const store = await readStore().catch(() => ({ schemaVersion: 1, skills: [] } as Store));
      const skillCount = Array.isArray(store.skills) ? store.skills.length : 0;
      const dash = `<span class="space-muted">未声明</span>`;
      const cell = `style="padding:4px 8px"`;
      const toolRows = tools.length
        ? tools
            .slice()
            .sort((a: any, b: any) => String(a.name).localeCompare(String(b.name)))
            .map((tool: any) => {
              const outputs = Array.isArray(tool.outputs) ? tool.outputs.length : 0;
              return `<tr><td ${cell}><code>${escape(String(tool.name))}</code></td>` +
                `<td ${cell}>${tool.displayName ? escape(String(tool.displayName)) : dash}</td>` +
                `<td ${cell}>${tool.plugin ? escape(String(tool.plugin)) : dash}</td>` +
                `<td ${cell}>${tool.danger ? escape(String(tool.danger)) : dash}</td>` +
                `<td ${cell}>${outputs ? outputs + " 个" : dash}</td></tr>`;
            })
            .join("")
        : `<tr><td colspan="5" class="space-muted">一个工具都没读到，这台宿主的工具接口不可用。</td></tr>`;
      const pluginRows = [...byPlugin.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([name, count]) => `<tr><td ${cell}>${escape(name)}</td><td ${cell}>${count}</td></tr>`)
        .join("");
      const hint = catalogOn
        ? "宿主提供 catalog()，插件归属、危险等级、输出声明都能读到。工具来自当前装载的插件，装什么就有什么，不会写死在技能库里。"
        : "这台宿主没有 catalog()，用的是 list() 降级读取：工具名和描述能用，插件归属、危险等级、输出声明拿不到，画布端口会标「未声明」。升级宿主后重新打开这一页即可。";
      const report = await ctx.config.read<any>(localReportFile).catch(() => null) as any;
      const reportBlock = report && typeof report === "object"
        ? `<section class="space-panel"><h2>上次整理</h2>` +
          `<p><span class="space-badge">${escape(String(report.at ?? ""))}</span>` +
          `<span class="space-badge">${Number(report.toolCount) || 0} 个工具</span>` +
          `<span class="space-badge">${Number(report.orphanCount) || 0} 个未被使用</span></p>` +
          ((Array.isArray(report.suggestions) && report.suggestions.length)
            ? `<ul style="margin:8px 0 0;padding-left:20px;font-size:13px">` + report.suggestions.map((x: any) => `<li>${escape(String(x))}</li>`).join("") + `</ul>`
            : `<p class="space-muted">没有发现值得提的地方。</p>`) +
          `</section>`
        : "";
      const table = `width:100%;border-collapse:collapse;font-size:13px;text-align:left`;
      const body = `<div class="space-toolbar"><a class="btn space-secondary" href="${pagePath}">← 返回设置</a>` +
        `<form method="post" action="${pagePath}tidy" style="margin-left:8px;display:inline"><button class="btn space-primary" type="submit">整理本机能力</button></form></div>` +
        `<section class="space-panel"><h2>本机能力</h2>` +
        `<p><span class="space-badge${catalogOn ? "" : " warn"}">catalog ${catalogOn ? "可用" : "不可用"}</span>` +
        `<span class="space-badge${listOn ? "" : " warn"}">list ${listOn ? "可用" : "不可用"}</span>` +
        `<span class="space-badge">${tools.length} 个工具</span>` +
        `<span class="space-badge">${skillCount} 条技能</span></p>` +
        `<p class="space-muted">${escape(hint)}</p></section>` + reportBlock +
        `<section class="space-panel"><h2>按插件分组</h2>` +
        (pluginRows
          ? `<table style="${table}"><thead><tr><th ${cell}>插件</th><th ${cell}>工具数</th></tr></thead><tbody>${pluginRows}</tbody></table>`
          : `<p class="space-muted">没有可分组的工具。</p>`) +
        `</section>` +
        `<section class="space-panel"><h2>工具清单</h2>` +
        `<table style="${table}"><thead><tr><th ${cell}>工具名</th><th ${cell}>中文名</th><th ${cell}>插件</th><th ${cell}>危险级</th><th ${cell}>输出声明</th></tr></thead><tbody>${toolRows}</tbody></table>` +
        `</section>`;
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(html("本机能力", body));
    } catch (err: any) {
      res.writeHead(500, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(html("本机能力", `<p>读本机能力时出错：${escape(String(err?.message || err))}</p>`));
    }
  }, { title: "本机能力", navigation: false });
  ctx.web.api("/plugins/thinking-space/tidy", async (_req: any, res: any) => {
    try {
      const tools = await toolsSafe();
      const store = await readStore().catch(() => ({ schemaVersion: 1, skills: [] } as Store));
      const usedNames = new Set<string>();
      for (const skill of store.skills ?? []) {
        for (const step of skill.steps ?? []) usedNames.add(String((step as any).tool ?? ""));
      }
      const plugins = new Map<string, { tools: number; used: number }>();
      const orphans: string[] = [];
      const undeclared: string[] = [];
      for (const tool of tools) {
        const name = String(tool?.name ?? "");
        if (!name) continue;
        const key = String(tool?.plugin || "").trim() || "未标注";
        const bucket = plugins.get(key) ?? { tools: 0, used: 0 };
        bucket.tools += 1;
        if (usedNames.has(name)) bucket.used += 1; else orphans.push(name);
        if (!Array.isArray(tool?.outputs) || !tool.outputs.length) undeclared.push(name);
        plugins.set(key, bucket);
      }
      const suggestions: string[] = [];
      let pluginTips = 0;
      for (const [name, bucket] of [...plugins.entries()].sort((a, b) => b[1].tools - a[1].tools)) {
        if (name === "thinking-space") continue;
        const spare = bucket.tools - bucket.used;
        if (spare >= 2 && pluginTips < 4) {
          suggestions.push("「" + name + "」还有 " + spare + " 个工具没被任何技能用过，可以先挑两三个串成一条。");
          pluginTips += 1;
        }
      }
      if (undeclared.length >= 3) suggestions.push(undeclared.length + " 个工具没有声明输出结构，画布连线时端口会标「未声明」，只能靠跑一次观测形状。");
      if (!store.skills.length) suggestions.push("技能库还是空的。先用 space_draft 起草一条，跑通再存。");
      const report = {
        at: new Date().toISOString(),
        toolCount: tools.length,
        skillCount: store.skills.length,
        orphanCount: orphans.length,
        plugins: [...plugins.entries()].map(([name, bucket]) => ({ name, ...bucket })),
        orphans: orphans.slice(0, 50),
        undeclared: undeclared.slice(0, 50),
        suggestions: suggestions.slice(0, 8),
      };
      await ctx.config.save(localReportFile, report as any);
      res.writeHead(303, { Location: pagePath + "local?tidied=" + encodeURIComponent(report.at) });
      res.end();
    } catch (error) {
      res.writeHead(303, { Location: pagePath + "local?tidy_err=" + encodeURIComponent(error instanceof Error ? error.message : "整理失败。") });
      res.end();
    }
  });

  /** 技能定义服务。壳（sub/shells）靠它拿参数声明来生成工具 schema。
   *  走公开服务是作者的要求：不读别的插件的文件、不猜路径、不碰磁盘。
   *  只给声明，不给执行能力——执行还是 space_run 的事。 */
  ctx.provide("thinking-space.skills", {
    describe: async () => {
      const [store, catalog] = await Promise.all([readStore(), catalogByName()]);
      return store.skills.map(skill => ({
        id: skill.id,
        name: skill.name,
        description: skill.description,
        kind: skill.kind,
        danger: dangerFor(skill.steps, catalog, skill.danger),
        revision: Number.isFinite(skill.revision) ? Number(skill.revision) : 0,
        stepCount: skill.steps.length,
        params: skill.params.map(param => ({
          name: param.name,
          type: param.type,
          required: param.required === true,
          label: param.label ?? null,
          aliases: Array.isArray(param.aliases) ? param.aliases : [],
        })),
      }));
    },
  });
}
