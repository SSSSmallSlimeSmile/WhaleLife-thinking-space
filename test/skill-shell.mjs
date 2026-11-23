// 技能壳的逻辑冒烟：不碰真宿主，用假 ctx 验「转发、失败、超时、墓碑、开关、版本核对」。
// 跑法：node test/skill-shell.mjs
// 壳的来源：现用 publish.ts 的 renderShell 生成到临时目录，不再依赖仓库里手搓的演示壳。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { renderShell } from "../publish.ts";

const testDir = dirname(fileURLToPath(import.meta.url));
const workDir = mkdtempSync(join(tmpdir(), "ts-skill-shell-"));
const shellDir = join(workDir, "skill-demo-canvas-twice");
const flag = join(shellDir, "data", "uninstall.flag");
const SKILL_ID = "demo-canvas-twice";
const SKILL_REVISION = 3;

const skill = {
  id: SKILL_ID,
  name: "画布状态两次读",
  kind: "composite",
  danger: "safe",
  revision: SKILL_REVISION,
  steps: [
    { id: "n1", tool: "canvas_status", plugin: "thinking-space/canvas" },
    { id: "n2", tool: "canvas_status", plugin: "thinking-space/canvas" },
  ],
};
const rendered = renderShell(skill, "skill-demo-canvas-twice", "0.1.0");
mkdirSync(shellDir, { recursive: true });
writeFileSync(join(shellDir, "index.ts"), rendered.source, "utf8");
writeFileSync(join(shellDir, "plugin.yaml"), rendered.manifest, "utf8");

const mod = await import(pathToFileURL(join(shellDir, "index.ts")).href);

/** 假 ctx。call 默认对 space_skills 回「技能在、rev 和发布时一样」，对 space_run 回 ok。 */
function makeCtx(config = {}, call) {
  const tools = [];
  const pages = [];
  const apis = [];
  const saved = [];
  const calls = [];
  const defaultCall = async (name, args) => {
    if (name === "space_skills") {
      return { ok: true, result: { status: "ok", skills: [{ id: SKILL_ID, name: "画布状态两次读", revision: SKILL_REVISION }] } };
    }
    return { ok: true, result: { status: "ok" } };
  };
  const ctx = {
    config: {
      read: async () => { if (config instanceof Error) throw config; return config; },
      save: async (file, value) => { saved.push({ file, value }); },
    },
    tools: {
      register: (tool) => { tools.push(tool); return () => {}; },
      call: (name, args, session) => { calls.push({ name, args }); return (call ?? defaultCall)(name, args, session); },
    },
    web: {
      page: (path, handler, entry) => { pages.push({ path, handler, entry }); },
      api: (path, handler) => { apis.push({ path, handler }); },
    },
    logger: { log() {}, debug() {}, info() {}, warn() {}, error() {} },
  };
  return { ctx, tools, pages, apis, saved, calls };
}

const results = [];
function check(label, ok, extra = "") {
  results.push({ label, ok, extra });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  —  " + extra : ""}`);
}

// 1 正常：技能回 ok，壳把状态和步数带出来
{
  const { ctx, tools, pages, apis, calls } = makeCtx({}, async (name) => {
    if (name === "space_skills") return { ok: true, result: { status: "ok", skills: [{ id: SKILL_ID, revision: SKILL_REVISION }] } };
    if (name !== "space_run") throw new Error("调错了工具：" + name);
    return { ok: true, result: { status: "ok", runId: "run_1", steps: [{}, {}] } };
  });
  await mod.apply(ctx);
  const run = tools.find(t => t.name === "skill_demo_canvas_twice");
  const out = await run.run({}, {});
  check("正常转发：状态和步数带出来", out.status === "ok" && out.steps === 2 && out.runId === "run_1", JSON.stringify(out));
  check("注册了三个工具（跑、探针、卸载），页面和表单也都挂上", tools.length === 3 && pages.length === 1 && apis.length === 1, `tools=${tools.length} pages=${pages.length} apis=${apis.length}`);
  check("危险等级写死 ask：跑是 ask、探针 safe、卸载 full", run.danger === "ask" &&
    tools.find(t => t.name.endsWith("_probe")).danger === "safe" &&
    tools.find(t => t.name.endsWith("_uninstall")).danger === "full");
  check("跑之前先看一眼技能（space_skills 记了 id）", calls[0]?.name === "space_skills" && calls[1]?.name === "space_run", calls.map(c => c.name).join(" → "));
  check("版本一致：回执里不出现「技能改过」", !/技能改过/.test(out.note), out.note);
  const probe = tools.find(t => t.name.endsWith("_probe"));
  const seen = await probe.run({}, {});
  check("探针回报发布时的 rev", seen.skillRevision === SKILL_REVISION, JSON.stringify(seen));
}

// 2 技能自己失败：壳如实转述，不吞
{
  const { ctx, tools } = makeCtx({}, async (name) => {
    if (name === "space_skills") return { ok: true, result: { skills: [{ id: SKILL_ID, revision: SKILL_REVISION }] } };
    return { ok: false, result: "权限不够" };
  });
  await mod.apply(ctx);
  const out = await tools[0].run({}, {});
  check("技能失败：原因原样带出", out.status === "failed" && out.note === "权限不够", JSON.stringify(out));
}

// 3 技能被删了：不跑，直接说要卸载
{
  const { ctx, tools, calls } = makeCtx({}, async (name) => {
    if (name === "space_skills") return { ok: true, result: { skills: [] } };
    return { ok: true, result: { status: "ok" } };
  });
  await mod.apply(ctx);
  const out = await tools[0].run({}, {});
  check("技能不在：拒绝执行，提示卸载",
    out.status === "failed" && /已经不在了/.test(out.note) && /卸载/.test(out.note), out.note);
  check("技能不在：没有调用 space_run", !calls.some(c => c.name === "space_run"), calls.map(c => c.name).join(" → "));
}

// 4 技能改过版本：照跑，但回执里说明
{
  const { ctx, tools } = makeCtx({}, async (name) => {
    if (name === "space_skills") return { ok: true, result: { skills: [{ id: SKILL_ID, revision: SKILL_REVISION + 2 }] } };
    return { ok: true, result: { status: "ok", steps: [{}] } };
  });
  await mod.apply(ctx);
  const out = await tools[0].run({}, {});
  check("版本变了：照跑，回执带出 rev 变化",
    out.status === "ok" && out.revision === SKILL_REVISION + 2 && /发布时 rev 3/.test(out.note) && /现在 rev 5/.test(out.note), out.note);
}

// 5 查不到技能列表：不拦，交给 space_run 自己报
{
  const { ctx, tools } = makeCtx({}, async (name) => {
    if (name === "space_skills") throw new Error("工具表里没有");
    return { ok: true, result: { status: "ok" } };
  });
  await mod.apply(ctx);
  const out = await tools[0].run({}, {});
  check("查不到技能列表：不拦，照常跑", out.status === "ok", JSON.stringify(out));
}

// 6 超时：只报先停在这里，不假装技能结束了
{
  const { ctx, tools } = makeCtx({ timeoutMs: 5000 }, (name) => {
    if (name === "space_skills") return Promise.resolve({ ok: true, result: { skills: [{ id: SKILL_ID, revision: SKILL_REVISION }] } });
    return new Promise(() => {});
  });
  await mod.apply(ctx);
  const t0 = Date.now();
  const out = await tools[0].run({}, {});
  const took = Date.now() - t0;
  check("超时：报先停在这里，不伪造结果", out.status === "failed" && /超过 5000 毫秒/.test(out.note), `${took}ms · ${out.note}`);
}

// 7 卸载：只写墓碑，不删目录
{
  if (existsSync(flag)) rmSync(flag);
  const { ctx, tools } = makeCtx({});
  await mod.apply(ctx);
  const uninstall = tools.find(t => t.name.endsWith("_uninstall"));
  const out = await uninstall.run({ reason: "冒烟测试" }, {});
  const written = existsSync(flag) ? JSON.parse(readFileSync(flag, "utf8")) : null;
  check("卸载：写墓碑、目录还在、状态 pending", out.status === "pending" && written?.reason === "冒烟测试" && existsSync(shellDir), JSON.stringify(written));
  if (existsSync(flag)) rmSync(flag);
  check("卸载：测试后墓碑已清掉", !existsSync(flag));
}

// 8 关掉开关：工具不注册，但页面还在
{
  const { ctx, tools, pages } = makeCtx({ enabled: false });
  await mod.apply(ctx);
  check("关掉开关：不注册工具，页面还在", tools.length === 0 && pages.length === 1, `tools=${tools.length} pages=${pages.length}`);
}

// 9 配置读不到：退回默认，不炸
{
  const { ctx, tools } = makeCtx(new Error("没有配置文件"));
  await mod.apply(ctx);
  check("配置读不到：用默认值继续", tools.length === 3, `tools=${tools.length}`);
}

rmSync(workDir, { recursive: true, force: true });

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
