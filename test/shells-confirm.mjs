// 壳的确认语义：副作用步骤只在「用户明确授权」之后才放行。
//
// 两条规矩：
// 1. 壳自己不能替用户确认——以前传的是 `danger !== "safe"`，含副作用步骤的技能
//    等于被壳自动批准了。
// 2. 只有调用者的权限是 full（用户在配置里显式授权）时，才把 confirmSideEffects 传成 true。
//
// 跑法：node test/shells-confirm.mjs
import { pathToFileURL } from "node:url";

const mod = await import(pathToFileURL(new URL("../sub/shells/index.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")).href);

const SKILL = { id: "side-demo", name: "会写文件的技能", kind: "single", danger: "ask", revision: 2, stepCount: 1, params: [] };
const STORE = {
  schemaVersion: 1,
  items: [{ skillId: "side-demo", toolName: "skill_side_demo", label: "会写文件的技能", danger: "ask", skillRevision: 2, enabled: true, addedAt: "2026-01-01T00:00:00.000Z" }],
};

const results = [];
const check = (label, ok, extra = "") => {
  results.push({ label, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
};

function makeCtx() {
  const tools = [];
  const calls = [];
  const ctx = {
    config: { read: async () => STORE, save: async () => {} },
    get: (name) => (name === "thinking-space.skills" ? { describe: async () => [SKILL] } : undefined),
    tools: {
      register: (tool) => { tools.push(tool); return () => { const i = tools.indexOf(tool); if (i >= 0) tools.splice(i, 1); }; },
      call: async (name, args) => {
        calls.push({ name, args });
        if (name === "space_skills") return { ok: true, result: { skills: [{ id: "side-demo", revision: 2 }] } };
        return { ok: true, result: { status: "ok", runId: "r1", steps: [{}] } };
      },
    },
    web: { page: () => {}, api: () => {} },
    logger: { info() {}, warn() {}, error() {} },
  };
  return { ctx, tools, calls };
}

async function runUnder(permission) {
  const { ctx, tools, calls } = makeCtx();
  await mod.apply(ctx);
  const tool = tools.find((t) => t.name === "skill_side_demo");
  await tool.run({}, { permission });
  return { calls, tool };
}

// 1. 权限 ask（用户没授权副作用）：不许确认
{
  const { calls, tool } = await runUnder("ask");
  const run = calls.find((c) => c.name === "space_run");
  check("壳的危险等级来自技能", tool?.danger === "ask", String(tool?.danger));
  check("ask 权限下 confirmSideEffects 是 false", run?.args?.confirmSideEffects === false, String(run?.args?.confirmSideEffects));
  check("ask 权限照旧透传", run?.args && calls.every((c) => c.name !== "space_run" || true));
}

// 2. 权限 full（用户显式授权）：放行，且只发一次
{
  const { calls } = await runUnder("full");
  const runs = calls.filter((c) => c.name === "space_run");
  check("full 权限下 confirmSideEffects 是 true", runs[0]?.args?.confirmSideEffects === true, String(runs[0]?.args?.confirmSideEffects));
  check("只发一次 space_run", runs.length === 1, String(runs.length));
}

// 3. 没有 session 时绝不确认
{
  const { ctx, tools, calls } = makeCtx();
  await mod.apply(ctx);
  const tool = tools.find((t) => t.name === "skill_side_demo");
  await tool.run({}, undefined);
  const run = calls.find((c) => c.name === "space_run");
  check("没有会话信息时不确认", run?.args?.confirmSideEffects === false, String(run?.args?.confirmSideEffects));
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
