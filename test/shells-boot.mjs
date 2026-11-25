// 冷启动归一 + 同名工具取严。两条都是作者挑过的方向：
// 「危险等级会往 safe 滑」和「重载/冷重启之后照旧」。
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Readable } from "node:stream";

const shellUrl = new URL("../sub/shells/index.ts", import.meta.url);
const mod = await import(pathToFileURL(shellUrl.pathname.replace(/^\/([A-Za-z]:)/, "$1")).href);

const results = [];
const check = (label, ok, extra = "") => {
  results.push({ label, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
};

function makeCtx({ disk = { schemaVersion: 1, items: [] }, skills = [{ id: "skill_one", name: "一号", kind: "single", danger: "ask", revision: 1, stepCount: 1, params: [] }] } = {}) {
  let saved = JSON.parse(JSON.stringify(disk));
  const registered = new Map();
  const state = {
    lastTool: undefined,
    get saved() { return saved; },
    get registered() { return [...registered.keys()]; },
  };
  const ctx = {
    config: {
      read: async () => JSON.parse(JSON.stringify(saved)),
      save: async (_file, value) => { saved = JSON.parse(JSON.stringify(value)); },
    },
    get: (name) => (name === "thinking-space.skills" ? { describe: async () => skills } : undefined),
    tools: {
      register: (tool) => { registered.set(tool.name, tool); state.lastTool = tool; return () => registered.delete(tool.name); },
      call: async (name) => (name === "space_skills" ? { ok: true, result: { skills } } : { ok: true, result: {} }),
    },
    web: { page: () => {}, api: () => {} },
    logger: { info() {}, warn() {}, error() {} },
  };
  return { ctx, state };
}

// 1. 脏记录冷启动：danger 是坏值、缺 requiredPermission、还残留 approval。
{
  const disk = { schemaVersion: 1, items: [{ skillId: "skill_one", toolName: "skill_one", label: "一号", danger: "bogus", approval: "full", skillRevision: 1, enabled: true, addedAt: "2026-01-01T00:00:00.000Z" }] };
  const b = makeCtx({ disk });
  await mod.apply(b.ctx);
  const it = b.state.saved.items[0] ?? {};
  check("冷启动：坏 danger 归一成 ask", it.danger === "ask", String(it.danger));
  check("冷启动：缺 requiredPermission 按技能补成 ask", it.requiredPermission === "ask", String(it.requiredPermission));
  check("冷启动：旧 approval 字段被清掉", it.approval === undefined, String(it.approval));
  check("冷启动：工具注册上了", b.state.registered.includes("skill_one"), b.state.registered.join(","));
}

// 2. 旧记录存的是 full、技能也声明 full：补回 full，不往上也不往下抹。
{
  const skills = [{ id: "skill_one", name: "一号", kind: "single", danger: "full", revision: 1, stepCount: 1, params: [] }];
  const disk = { schemaVersion: 1, items: [{ skillId: "skill_one", toolName: "skill_one", label: "一号", danger: "full", skillRevision: 1, enabled: true, addedAt: "2026-01-01T00:00:00.000Z" }] };
  const b = makeCtx({ disk, skills });
  await mod.apply(b.ctx);
  const it = b.state.saved.items[0] ?? {};
  check("冷启动：full 记录按技能补成 full", it.danger === "full" && it.requiredPermission === "full", `${it.danger}/${it.requiredPermission}`);
}

// 3. 技能声明读不到：不能猜 safe，权限留空（运行时照旧拦），工具仍注册。
{
  const disk = { schemaVersion: 1, items: [{ skillId: "skill_one", toolName: "skill_one", label: "一号", danger: "bogus", skillRevision: 1, enabled: true, addedAt: "2026-01-01T00:00:00.000Z" }] };
  const b = makeCtx({ disk, skills: [] });
  await mod.apply(b.ctx);
  const it = b.state.saved.items[0] ?? {};
  check("技能声明不在：danger 不会落到 safe", it.danger !== "safe", String(it.danger));
  check("技能声明不在：requiredPermission 留空", it.requiredPermission === undefined, String(it.requiredPermission));
  check("技能声明不在：工具仍注册", b.state.registered.includes("skill_one"), b.state.registered.join(","));
}

// 4. 同名工具取严：抽父插件里真实的 stricterDanger 跑，不复制实现。
{
  const src = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
  const dline = src.match(/^const dangers\b[^\n]*$/m);
  const fn = src.match(/const stricterDanger = \(a: unknown, b: unknown\)[\s\S]*?\n\};/);
  if (!dline || !fn) {
    check("抽得到 dangers / stricterDanger", false, dline ? "缺函数" : "缺常量");
  } else {
    const js = (dline[0] + "\n" + fn[0])
      .replace(/\s+as const/g, "")
      .replace(/\(a: unknown, b: unknown\): string \| undefined/, "(a, b)")
      .replace(/a as Danger/g, "a")
      .replace(/b as Danger/g, "b");
    const stricterDanger = new Function(js + "\nreturn stricterDanger;")();
    const cases = [
      ["ask + 缺字段", "ask", undefined, "ask"],
      ["缺字段 + ask", undefined, "ask", "ask"],
      ["safe + 缺字段", "safe", undefined, "ask"],
      ["缺字段 + safe", undefined, "safe", "ask"],
      ["bogus + full", "bogus", "full", "full"],
      ["full + bogus", "full", "bogus", "full"],
      ["safe + safe", "safe", "safe", "safe"],
      ["ask + full", "ask", "full", "full"],
    ];
    for (const [label, a, b2, want] of cases) {
      const got = stricterDanger(a, b2);
      check(`取严：${label} => ${want}`, got === want, String(got));
    }
  }
}

// 5. 内存态（不是磁盘）：技能声明不在时，注册出来的工具等级不能是 safe。
{
  const disk = { schemaVersion: 1, items: [{ skillId: "skill_one", toolName: "skill_one", label: "一号", danger: "bogus", skillRevision: 1, enabled: true, addedAt: "2026-01-01T00:00:00.000Z" }] };
  const b = makeCtx({ disk, skills: [] });
  await mod.apply(b.ctx);
  const tool = b.state.lastTool;
  check("内存态：注册工具等级不是 safe", tool && tool.danger !== "safe", String(tool && tool.danger));
  check("内存态：注册工具等级是 ask", tool && tool.danger === "ask", String(tool && tool.danger));
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
if (failed) process.exit(1);
