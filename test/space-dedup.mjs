// 同名工具条目 + 真 space_run 预检。
// 目的：目录里出现同名工具（一条 safe、一条 full/ask）时，不管哪条排在后面，
// 未确认的情况下都不能放行，底层工具一次都不能被调。
//
// 这条为什么有必要：catalogByName 以前是 Map 后值覆盖。一条误标 safe 的同名条目
// 能把前面那条 full 顶掉，预检跟着放行——静默降级，页面上什么都看不出来。
// 两种顺序都测，是因为只测一种的话，「取严」被删掉也仍有可能通过：
//   [safe, full] 顺序若退回后值覆盖 → safe → 放行（本测试咬住）
//   [full, safe] 顺序若退回后值覆盖 → full → 拦下（本测试看不出差别）
// 所以两个顺序缺一不可。
import { pathToFileURL } from "node:url";

const ENTRY = process.env.SPACE_ENTRY || "K:/Github/thinking-space-test/index.ts";
const entry = pathToFileURL(ENTRY).href;
const mod = await import(entry);

const results = [];
const check = (label, ok, extra = "") => {
  results.push({ label, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
};

const SKILL = {
  schemaVersion: 1, id: "dup_probe", name: "双条目探针", description: "",
  kind: "single", params: [],
  steps: [{ id: "s1", tool: "dup_tool", plugin: "demo", params: {}, next: null }],
  danger: "safe", revision: 1,
};

function makeCtx({ catalog, skill = SKILL } = {}) {
  const files = new Map([["skills.json", { schemaVersion: 1, skills: skill ? [skill] : [] }]]);
  const registered = new Map();
  const calls = [];
  const ctx = {
    config: {
      read: async (file) => files.get(file) ?? {},
      save: async (file, v) => { files.set(file, v); },
    },
    get: () => undefined,
    on: () => () => {},
    provide: () => {},
    tools: {
      register: (tool) => { registered.set(tool.name, tool); return () => registered.delete(tool.name); },
      catalog: async () => catalog,
      list: async () => [],
      call: async (name, args) => { calls.push({ name, args }); return { ok: true, result: { done: true } }; },
    },
    web: { page: () => {}, api: () => {} },
    logger: { info() {}, warn() {}, error() {} },
  };
  return { ctx, registered, calls };
}

async function runOnce(catalog, { confirm, permission = "full" } = {}) {
  const { ctx, registered, calls } = makeCtx({ catalog });
  await mod.apply(ctx);
  const tool = registered.get("space_run");
  if (!tool) return { missing: true, calls };
  const args = { id: "dup_probe" };
  if (confirm !== undefined) args.confirmSideEffects = confirm;
  const out = await tool.run(args, { permission });
  return { out, calls };
}

// 1. [safe, full]：后一条是 full。若退回旧的「后值覆盖」，这里会变成 full 被 safe 顶掉 → 放行。
{
  const r = await runOnce([
    { name: "dup_tool", plugin: "demo", danger: "safe" },
    { name: "dup_tool", plugin: "demo", danger: "full" },
  ]);
  check("同名 [safe,full]：未确认时停在预检", r.out?.status === "blocked", String(r.out?.status));
  check("同名 [safe,full]：底层工具调用 0 次", r.calls.length === 0, String(r.calls.length));
}

// 2. [full, safe]：后一条是 safe。旧的「后值覆盖」会在这里降成 safe → 放行。
//    这条才是真正咬住静默降级的那条。
{
  const r = await runOnce([
    { name: "dup_tool", plugin: "demo", danger: "full" },
    { name: "dup_tool", plugin: "demo", danger: "safe" },
  ]);
  check("同名 [full,safe]：未确认时停在预检", r.out?.status === "blocked", String(r.out?.status));
  check("同名 [full,safe]：底层工具调用 0 次", r.calls.length === 0, String(r.calls.length));
}

// 3. 一条 full + 一条缺 danger 字段：缺的那条不能把 full 抹成未知以外的低档。
{
  const r = await runOnce([
    { name: "dup_tool", plugin: "demo", danger: "full" },
    { name: "dup_tool", plugin: "demo" },
  ]);
  check("同名 [full,缺字段]：未确认时停在预检", r.out?.status === "blocked", String(r.out?.status));
  check("同名 [full,缺字段]：底层工具调用 0 次", r.calls.length === 0, String(r.calls.length));
}

// 4. 两条都 safe：不能被误拦。这是对照组，证明上面三条不是「一律拦」。
{
  const r = await runOnce([
    { name: "dup_tool", plugin: "demo", danger: "safe" },
    { name: "dup_tool", plugin: "demo", danger: "safe" },
  ]);
  check("同名 [safe,safe]：放行并真跑一步", r.out?.status === "ok", String(r.out?.status));
  check("同名 [safe,safe]：底层工具调用 1 次", r.calls.length === 1, String(r.calls.length));
}

// 5. 显式确认后应当放行——证明拦住的原因是「未确认」，不是「工具不可用」。
{
  const r = await runOnce(
    [
      { name: "dup_tool", plugin: "demo", danger: "safe" },
      { name: "dup_tool", plugin: "demo", danger: "full" },
    ],
    { confirm: true },
  );
  check("同名 [safe,full]：确认后放行", r.out?.status === "ok", String(r.out?.status));
  check("同名 [safe,full]：确认后调用 1 次", r.calls.length === 1, String(r.calls.length));
}

// 6. 单条 ask 也应当拦下，确认「未知即至少 ask」这条口径在预检里成立。
{
  const r = await runOnce([{ name: "dup_tool", plugin: "demo", danger: "ask" }]);
  check("单条 ask：未确认时停在预检", r.out?.status === "blocked", String(r.out?.status));
  check("单条 ask：底层工具调用 0 次", r.calls.length === 0, String(r.calls.length));
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
if (failed) process.exit(1);
