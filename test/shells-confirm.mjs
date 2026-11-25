// 壳的放行规则：只读壳直接跑；含副作用的壳一律逐次确认，没有「长期免问」这一档。
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

// 1. 含副作用的壳：会话给什么权限都先停下，零调用，提示去技能页勾选本次执行。
for (const permission of [undefined, "off", "ask", "full"]) {
  const { calls, out } = await runTool("skill_side_demo", { permission });
  check(`含副作用 · 会话 ${permission} 时零调用`, calls.length === 0);
  check("含副作用 · 回执是 needs_confirmation 且指向本次勾选", out?.status === "needs_confirmation" && /勾选本次执行/.test(out.note));
}

// 2. 旧记录里写了 approval=full 也没用：一律逐次确认，启动时重写存档把字段清掉。
{
  const store = { schemaVersion: 1, items: [item(SKILL, { approval: "full" })] };
  const { calls, out, saved } = await runTool("skill_side_demo", { permission: "full", store });
  check("旧 full 记录也停下，零调用", out?.status === "needs_confirmation" && calls.length === 0);
  check("启动重写存档后 approval 字段消失", saved.length > 0 && saved.at(-1).items[0].approval === undefined);
  check("重写后其余字段不丢", saved.at(-1)?.items[0]?.requiredPermission === SKILL.danger);
}

// 3. 只读壳无需任何授权，也不放开副作用。
for (const permission of [undefined, "full"]) {
  const { calls, out } = await runTool("skill_safe_demo", { permission });
  const run = calls.find((c) => c.name === "space_run");
  check(`只读壳在 ${permission} 下直接跑，副作用不放行`, out?.status === "ok" && run?.args?.confirmSideEffects === false);
}

// 4. 走真实的加壳路由：不写 approval；重启读回仍要问；页面上不再有 approval 入口。
{
  const built = makeCtx({ store: { schemaVersion: 1, items: [] } });
  await mod.apply(built.ctx);
  const add = built.routes.get("/plugins/thinking-space/shells/add");
  await add([Buffer.from("skillId=side-demo")], { writeHead() {}, end() {} });
  const store = built.saved[0];
  check("加壳写入原始权限声明", store?.items[0]?.requiredPermission === SKILL.danger);
  check("加壳不写 approval 字段", store?.items[0]?.approval === undefined);

  const restarted = await runTool("skill_side_demo", { permission: "full", store });
  check("重启读回后仍要问", restarted.out.status === "needs_confirmation" && restarted.calls.length === 0);

  check("没有 /approval 路由", built.routes.get("/plugins/thinking-space/shells/approval") === undefined);
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
  const built = makeCtx({ skills, store: { schemaVersion: 1, items: [item(SKILL)] } });
  await mod.apply(built.ctx);
  skills[0].danger = "full";
  const drifted = await built.tools.find((tool) => tool.name === "skill_side_demo").run({}, { permission: "full" });
  check("权限声明漂移时拦下", drifted.status === "blocked" && /权限声明已变更/.test(drifted.note) && built.calls.length === 0);
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
