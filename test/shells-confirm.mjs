// 壳的放行规则：只读壳直接跑；含副作用的壳按每个壳自己的配置走——
// 默认 ask（要问，宿主没审批流就停住），手动改成 full 才免问。
import { pathToFileURL } from "node:url";

const mod = await import(
  pathToFileURL(new URL("../sub/shells/index.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")).href
);

const SKILL = { id: "side-demo", name: "会写文件的技能", kind: "single", danger: "ask", revision: 2, stepCount: 1, params: [] };
const SAFE_SKILL = { id: "safe-demo", name: "只读技能", kind: "single", danger: "safe", revision: 1, stepCount: 1, params: [] };
const item = (skill, extra = {}) => ({
  skillId: skill.id,
  toolName: "skill_" + skill.id.replace(/-/g, "_"),
  label: skill.name,
  danger: skill.danger,
  requiredPermission: skill.danger,
  skillRevision: skill.revision,
  enabled: true,
  addedAt: "2026-01-01T00:00:00.000Z",
  ...extra,
});
const STORE = { schemaVersion: 1, items: [item(SKILL), item(SAFE_SKILL)] };

const results = [];
const check = (label, ok, extra = "") => {
  results.push({ label, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
};

function makeCtx({ store = STORE, skills = [SKILL, SAFE_SKILL] } = {}) {
  const tools = [];
  const calls = [];
  const routes = new Map();
  const saved = [];
  const ctx = {
    config: {
      read: async () => JSON.parse(JSON.stringify(store)),
      save: async (_file, value) => saved.push(JSON.parse(JSON.stringify(value))),
    },
    get: (name) => (name === "thinking-space.skills" ? { describe: async () => skills } : undefined),
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
        if (name === "space_skills") {
          return { ok: true, result: { skills: [{ id: SKILL.id, revision: 2 }, { id: SAFE_SKILL.id, revision: 1 }] } };
        }
        return { ok: true, result: { status: "ok", runId: "r1", steps: [{}] } };
      },
    },
    web: { page: () => {}, api: (path, handler) => routes.set(path, handler) },
    logger: { info() {}, warn() {}, error() {} },
  };
  return { ctx, tools, calls, routes, saved };
}

async function runTool(name, { permission, ...options } = {}) {
  const built = makeCtx(options);
  await mod.apply(built.ctx);
  const tool = built.tools.find((t) => t.name === name);
  const out = await tool.run({}, permission === undefined ? undefined : { permission });
  return { ...built, tool, out };
}

// 1. 默认 ask：含副作用的壳，会话给什么权限都先停下，零调用。
for (const permission of [undefined, "off", "ask", "full"]) {
  const { calls, out } = await runTool("skill_side_demo", { permission });
  check(`默认 ask · 会话 ${permission} 时零调用`, calls.length === 0);
  check("默认 ask · 回执说明要改成 full", out?.status === "needs_confirmation" && /full/.test(out.note));
}

// 2. 手动改成 full：免问，直接跑，并且这次调用按 full 权限走。
{
  const store = { schemaVersion: 1, items: [item(SKILL, { approval: "full" })] };
  const { calls, out } = await runTool("skill_side_demo", { permission: "ask", store });
  const runs = calls.filter((c) => c.name === "space_run");
  check("full 只发一次 space_run", runs.length === 1);
  check("full 时 confirmSideEffects 为 true", runs[0]?.args?.confirmSideEffects === true);
  check("full 时按壳的配置提权", runs[0]?.opts?.permission === "full");
  check("执行完成", out?.status === "ok");
}

// 3. 只读壳无需任何授权，也不放开副作用。
for (const permission of [undefined, "full"]) {
  const { calls, out } = await runTool("skill_safe_demo", { permission });
  const run = calls.find((c) => c.name === "space_run");
  check(`只读壳在 ${permission} 下直接跑，副作用不放行`, out?.status === "ok" && run?.args?.confirmSideEffects === false);
}

// 4. 走真实的加壳路由：默认写 ask，重启读回仍是 ask；手动改成 full 之后才跑。
{
  const built = makeCtx({ store: { schemaVersion: 1, items: [] } });
  await mod.apply(built.ctx);
  const add = built.routes.get("/plugins/thinking-space/shells/add");
  await add([Buffer.from("skillId=side-demo")], { writeHead() {}, end() {} });
  const store = built.saved[0];
  check("加壳写入原始权限声明", store?.items[0]?.requiredPermission === SKILL.danger);
  check("加壳默认是 ask", store?.items[0]?.approval === "ask");

  const restarted = await runTool("skill_side_demo", { permission: "full", store });
  check("重启读回后默认仍要问", restarted.out.status === "needs_confirmation" && restarted.calls.length === 0);

  const ctx2 = makeCtx({ store: JSON.parse(JSON.stringify(store)) });
  await mod.apply(ctx2.ctx);
  const approval = ctx2.routes.get("/plugins/thinking-space/shells/approval");
  await approval([Buffer.from("skillId=side-demo&approval=full")], { writeHead() {}, end() {} });
  check("approval 路由写入 full", ctx2.saved.at(-1)?.items?.[0]?.approval === "full");

  const after = await runTool("skill_side_demo", { permission: "ask", store: ctx2.saved.at(-1) });
  check("改成 full 后才跑", after.out.status === "ok" && after.calls.length === 1);
}

// 5. 旧记录缺权限声明：技能还在就按当前声明补；技能没了就拦。
{
  const legacy = item(SKILL);
  delete legacy.requiredPermission;
  const kept = await runTool("skill_side_demo", { permission: "full", store: { schemaVersion: 1, items: [legacy] } });
  check("旧记录按当前技能声明补齐", kept.out.status === "needs_confirmation");

  const gone = await runTool("skill_side_demo", {
    permission: "full",
    skills: [SAFE_SKILL],
    store: { schemaVersion: 1, items: [{ ...legacy, approval: "full" }] },
  });
  check("技能不在时拦下，零调用", gone.out.status === "blocked" && gone.calls.length === 0);
}

// 6. 注册之后技能的危险声明漂移 → 拦。
{
  const skills = [{ ...SKILL }];
  const built = makeCtx({ skills, store: { schemaVersion: 1, items: [item(SKILL, { approval: "full" })] } });
  await mod.apply(built.ctx);
  skills[0].danger = "full";
  const drifted = await built.tools.find((tool) => tool.name === "skill_side_demo").run({}, { permission: "full" });
  check("权限声明漂移时拦下", drifted.status === "blocked" && /权限声明已变更/.test(drifted.note) && built.calls.length === 0);
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
