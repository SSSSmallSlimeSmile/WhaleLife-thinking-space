// 壳的确认语义：危险等级只决定「要不要问」，放行条件是用户对本次执行明确确认。
//
// 三条规矩：
// 1. 壳不替用户点头：以前传的是 `session.permission === "full"`，等于把「用户长期授权」
//    当成「这次同意」，含副作用步骤的技能就被壳自动批准了。
// 2. 现在去问宿主审批（ctx.approval.request）；拿到 approved 才传 confirmSideEffects: true。
// 3. 拿不到确认就不跑，回 needs_confirmation，指路到能确认的入口。
//
// 跑法：node test/shells-confirm.mjs
import { pathToFileURL } from "node:url";

const mod = await import(
  pathToFileURL(new URL("../sub/shells/index.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")).href
);

const SKILL = { id: "side-demo", name: "会写文件的技能", kind: "single", danger: "ask", revision: 2, stepCount: 1, params: [] };
const SAFE_SKILL = { id: "safe-demo", name: "只读技能", kind: "single", danger: "safe", revision: 1, stepCount: 1, params: [] };
const item = (skill) => ({
  skillId: skill.id,
  toolName: "skill_" + skill.id.replace(/-/g, "_"),
  label: skill.name,
  danger: skill.danger,
  skillRevision: skill.revision,
  enabled: true,
  addedAt: "2026-01-01T00:00:00.000Z",
});
const STORE = { schemaVersion: 1, items: [item(SKILL), item(SAFE_SKILL)] };

const results = [];
const check = (label, ok, extra = "") => {
  results.push({ label, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
};

function makeCtx({ approved = false, approvals = 0 } = {}) {
  const tools = [];
  const calls = [];
  const asked = { count: approvals };
  const ctx = {
    config: { read: async () => STORE, save: async () => {} },
    get: (name) =>
      name === "thinking-space.skills" ? { describe: async () => [SKILL, SAFE_SKILL] } : undefined,
    approval: {
      request: async () => {
        asked.count += 1;
        return { approved, reason: approved ? undefined : "宿主没有审批流" };
      },
    },
    tools: {
      register: (tool) => {
        tools.push(tool);
        return () => {
          const i = tools.indexOf(tool);
          if (i >= 0) tools.splice(i, 1);
        };
      },
      call: async (name, args, opts) => {
        calls.push({ name, args, opts });
        if (name === "space_skills") return { ok: true, result: { skills: [{ id: SKILL.id, revision: 2 }, { id: SAFE_SKILL.id, revision: 1 }] } };
        return { ok: true, result: { status: "ok", runId: "r1", steps: [{}] } };
      },
    },
    web: { page: () => {}, api: () => {} },
    logger: { info() {}, warn() {}, error() {} },
  };
  return { ctx, tools, calls, asked };
}

async function runTool(name, { permission, approved } = {}) {
  const built = makeCtx({ approved });
  await mod.apply(built.ctx);
  const tool = built.tools.find((t) => t.name === name);
  const out = await tool.run({}, permission === undefined ? undefined : { permission });
  return { ...built, tool, out };
}

// 1. 含副作用 + 拿不到确认：不调 space_run
{
  const { calls, out } = await runTool("skill_side_demo", { permission: "full", approved: false });
  const runs = calls.filter((c) => c.name === "space_run");
  check("含副作用且未确认时不执行", runs.length === 0, String(runs.length));
  check("返回 needs_confirmation", out?.status === "needs_confirmation", String(out?.status));
  check("指路到能确认的入口", /请.*再跑一次|能确认/.test(String(out?.note ?? "")), "");
}

// 2. 含副作用 + 明确确认：放行，且只发一次
{
  const { calls, out, asked } = await runTool("skill_side_demo", { permission: "full", approved: true });
  const runs = calls.filter((c) => c.name === "space_run");
  check("确认后放行，只发一次 space_run", runs.length === 1, String(runs.length));
  check("确认后 confirmSideEffects 是 true", runs[0]?.args?.confirmSideEffects === true, String(runs[0]?.args?.confirmSideEffects));
  check("确认前确实问过审批", asked.count >= 1, String(asked.count));
  check("执行完成", out?.status === "ok", String(out?.status));
}

// 3. 只读技能：不问审批，也不需要确认
{
  const { calls, asked } = await runTool("skill_safe_demo", { permission: "ask", approved: false });
  const runs = calls.filter((c) => c.name === "space_run");
  check("只读技能照常放行", runs.length === 1, String(runs.length));
  check("只读技能不问审批", asked.count === 0, String(asked.count));
  check("只读技能 confirmSideEffects 是 false", runs[0]?.args?.confirmSideEffects === false, String(runs[0]?.args?.confirmSideEffects));
}

// 4. 调用者权限照旧透传
{
  const { calls } = await runTool("skill_side_demo", { permission: "full", approved: true });
  const run = calls.find((c) => c.name === "space_run");
  check("调用者权限原样透传", run?.opts?.permission === "full", String(run?.opts?.permission));
}

// 5. 没有会话信息：同样不放行含副作用的技能
{
  const { calls, out } = await runTool("skill_side_demo", { approved: false });
  const runs = calls.filter((c) => c.name === "space_run");
  check("没有会话信息时不执行含副作用技能", runs.length === 0, String(runs.length));
  check("没有会话信息时也回 needs_confirmation", out?.status === "needs_confirmation", String(out?.status));
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
