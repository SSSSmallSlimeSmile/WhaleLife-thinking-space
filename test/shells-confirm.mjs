// 只读壳直接运行。含副作用的壳仅接受显式的 full 会话权限。
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
  requiredPermission: skill.danger,
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

function makeCtx({ store = STORE, skills = [SKILL, SAFE_SKILL] } = {}) {
  const tools = [];
  const calls = [];
  const routes = new Map();
  const saved = [];
  const ctx = {
    config: { read: async () => store, save: async (_file, value) => saved.push(JSON.parse(JSON.stringify(value))) },
    get: (name) =>
      name === "thinking-space.skills" ? { describe: async () => skills } : undefined,
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

// 1. 非 full 会话与缺失会话都不执行含副作用的技能。
for (const permission of ["off", "ask", undefined]) {
  const { calls, out } = await runTool("skill_side_demo", { permission });
  check(`含副作用且会话权限为 ${permission} 时零调用`, calls.length === 0);
  check("提示需要显式 full 权限", out?.status === "needs_confirmation" && /full/.test(out.note));
}

// 2. full 会话授权后放行，并透传权限。
{
  const { calls, out } = await runTool("skill_side_demo", { permission: "full" });
  const runs = calls.filter((c) => c.name === "space_run");
  check("full 权限只发一次 space_run", runs.length === 1);
  check("含副作用时 confirmSideEffects 为 true", runs[0]?.args?.confirmSideEffects === true);
  check("调用者权限原样透传", runs[0]?.opts?.permission === "full");
  check("执行完成", out?.status === "ok");
}

// 3. 只读壳无需会话授权，即使是 full 也不开放副作用。
for (const permission of [undefined, "full"]) {
  const { calls, out } = await runTool("skill_safe_demo", { permission });
  const run = calls.find((c) => c.name === "space_run");
  check(`只读壳在 ${permission} 权限下直接运行，副作用不放行`, out?.status === "ok" && run?.args?.confirmSideEffects === false);
}

// 4. 用实际发布路由写入，再启动一个新实例读取。
{
  const built = makeCtx({ store: { schemaVersion: 1, items: [] } });
  await mod.apply(built.ctx);
  const add = built.routes.get("/plugins/thinking-space/shells/add");
  await add([Buffer.from("skillId=side-demo")], { writeHead() {}, end() {} });
  const store = built.saved[0];
  check("发布写入原始权限声明", store?.items[0]?.requiredPermission === SKILL.danger);
  const restarted = await runTool("skill_side_demo", { permission: "full", store });
  check("重启读回声明后凭 full 授权执行", restarted.out.status === "ok" && restarted.calls.length === 1);
}

// 5. 旧记录以及当前声明变化均拒绝运行。
{
  const store = { schemaVersion: 1, items: [{ ...item(SKILL), requiredPermission: undefined }] };
  const legacy = await runTool("skill_side_demo", { permission: "full", store });
  check("旧记录可注册，执行时说明缺声明且零调用", legacy.out.status === "blocked" && /没有.*权限声明/.test(legacy.out.note) && legacy.calls.length === 0);
  const skills = [{ ...SKILL }];
  const built = makeCtx({ skills });
  await mod.apply(built.ctx);
  skills[0].danger = "full";
  const drifted = await built.tools.find((tool) => tool.name === "skill_side_demo").run({}, { permission: "full" });
  check("注册后权限漂移时阻止执行", drifted.status === "blocked" && /权限声明已变更/.test(drifted.note) && built.calls.length === 0);
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
