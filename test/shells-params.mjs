// 技能壳（固定子插件版）的参数冒烟：验「参数声明 → 工具 schema → 真正传进 space_run」。
// 跑法：node test/shells-params.mjs
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const mod = await import(pathToFileURL(new URL("../sub/shells/index.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")).href);

const SKILL_ID = "param-demo";
const SKILL = {
  id: SKILL_ID,
  name: "带参数",
  kind: "single",
  danger: "safe",
  revision: 4,
  stepCount: 1,
  params: [
    { name: "prompt", type: "string", required: true, label: "画什么" },
    { name: "steps", type: "integer", required: false, label: "步数" },
    { name: "nick", type: "string", required: false, label: "别名", aliases: ["nickname"] },
  ],
};

const results = [];
function check(label, ok, extra = "") {
  results.push({ label, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  —  " + extra : ""}`);
}

/** 假 ctx。skills 为 null 表示服务不在，退回 space_skills 工具。 */
function makeCtx({ store = { schemaVersion: 1, items: [{ skillId: SKILL_ID, toolName: "skill_param_demo", label: "带参数", danger: "safe", skillRevision: 4, enabled: true, addedAt: "2026-01-01T00:00:00.000Z" }] }, skills = [SKILL], runResult = { ok: true, result: { status: "ok", runId: "r1", steps: [{}] } } } = {}) {
  const tools = [];
  const calls = [];
  const ctx = {
    config: { read: async () => store, save: async () => {} },
    get: (name) => (skills && name === "thinking-space.skills" ? { describe: async () => skills } : undefined),
    tools: {
      register: (tool) => { tools.push(tool); return () => { const i = tools.indexOf(tool); if (i >= 0) tools.splice(i, 1); }; },
      call: async (name, args) => {
        calls.push({ name, args });
        if (name === "space_skills") return { ok: true, result: { skills: [{ id: SKILL_ID, revision: 4 }] } };
        return runResult;
      },
    },
    web: { page: () => {}, api: () => {} },
    logger: { info() {}, warn() {}, error() {} },
  };
  return { ctx, tools, calls };
}

// 1 参数 → schema
{
  const { ctx, tools } = makeCtx();
  await mod.apply(ctx);
  const tool = tools.find(t => t.name === "skill_param_demo");
  const props = tool?.schema?.properties ?? {};
  check("注册了壳工具", !!tool);
  check("prompt 是 string 且有说明", props.prompt?.type === "string" && props.prompt?.description === "画什么", JSON.stringify(props.prompt));
  check("steps 是 integer", props.steps?.type === "integer");
  check("必填只有 prompt", JSON.stringify(tool?.schema?.required ?? []) === JSON.stringify(["prompt"]), JSON.stringify(tool?.schema?.required));
  check("不接受多余字段", tool?.schema?.additionalProperties === false);
}

// 2 参数透传 + 过滤多余字段
{
  const { ctx, tools, calls } = makeCtx();
  await mod.apply(ctx);
  const tool = tools.find(t => t.name === "skill_param_demo");
  await tool.run({ prompt: "海边的猫", steps: 20, 无关字段: 1 }, {});
  const run = calls.find(c => c.name === "space_run");
  check("参数原样传给 space_run", run?.args?.params?.prompt === "海边的猫" && run?.args?.params?.steps === 20, JSON.stringify(run?.args?.params));
  check("多余字段被过滤", !Object.hasOwn(run?.args?.params ?? {}, "无关字段"), JSON.stringify(run?.args?.params));
}

// 3 别名映射回正名
{
  const { ctx, tools, calls } = makeCtx();
  await mod.apply(ctx);
  const tool = tools.find(t => t.name === "skill_param_demo");
  await tool.run({ prompt: "x", nickname: "阿勘" }, {});
  const run = calls.find(c => c.name === "space_run");
  check("别名 nickname → nick", run?.args?.params?.nick === "阿勘" && !Object.hasOwn(run?.args?.params ?? {}, "nickname"), JSON.stringify(run?.args?.params));
}

// 4 服务不在：退回 space_skills，工具照注册，schema 空
{
  const { ctx, tools } = makeCtx({ skills: null });
  await mod.apply(ctx);
  const tool = tools.find(t => t.name === "skill_param_demo");
  check("服务不在也能注册壳", !!tool);
  check("服务不在：schema 没有参数（不瞎猜）", Object.keys(tool?.schema?.properties ?? {}).length === 0, JSON.stringify(tool?.schema));
}

// 5 技能声明参数变了：重启后 schema 跟着变
{
  const changed = [{ ...SKILL, revision: 5, params: [{ name: "text", type: "string", required: true, label: "文字" }] }];
  const { ctx, tools } = makeCtx({ skills: changed });
  await mod.apply(ctx);
  const tool = tools.find(t => t.name === "skill_param_demo");
  check("技能改了参数，重启后 schema 跟着变", Object.keys(tool?.schema?.properties ?? {}).join(",") === "text", JSON.stringify(tool?.schema?.properties));
}

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
