// 技能壳的逻辑冒烟：不碰真宿主，用假 ctx 验「转发、失败、超时、墓碑、开关」五件事。
// 跑法：node test/skill-shell.mjs
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const shellDir = join(testDir, "..", "sub", "skill-demo-canvas-twice");
const flag = join(shellDir, "data", "uninstall.flag");

const mod = await import(pathToFileURL(join(shellDir, "index.ts")).href);

function makeCtx(config = {}, call = async () => ({ ok: true, result: { status: "ok" } })) {
  const tools = [];
  const pages = [];
  const apis = [];
  const saved = [];
  const ctx = {
    config: {
      read: async () => { if (config instanceof Error) throw config; return config; },
      save: async (file, value) => { saved.push({ file, value }); },
    },
    tools: {
      register: (tool) => { tools.push(tool); return () => {}; },
      call: (name, args, session) => call(name, args, session),
    },
    web: {
      page: (path, handler, entry) => { pages.push({ path, handler, entry }); },
      api: (path, handler) => { apis.push({ path, handler }); },
    },
    logger: { log() {}, debug() {}, info() {}, warn() {}, error() {} },
  };
  return { ctx, tools, pages, apis, saved };
}

const results = [];
function check(label, ok, extra = "") {
  results.push({ label, ok, extra });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  —  " + extra : ""}`);
}

// 1 正常：技能回 ok，壳把状态和步数带出来
{
  const { ctx, tools, pages, apis } = makeCtx({}, async (name, args) => {
    if (name !== "space_run") throw new Error("调错了工具：" + name);
    if (args.id !== "demo-canvas-twice") throw new Error("技能 id 传错：" + args.id);
    return { ok: true, result: { status: "ok", runId: "run_1", steps: [{}, {}] } };
  });
  await mod.apply(ctx);
  const run = tools.find(t => t.name === "skill_demo_canvas_twice");
  const out = await run.run({}, {});
  check("正常转发：状态和步数带出来", out.status === "ok" && out.steps === 2 && out.runId === "run_1", JSON.stringify(out));
  check("注册了两个工具，页面和表单也都挂上", tools.length === 2 && pages.length === 1 && apis.length === 1, `tools=${tools.length} pages=${pages.length} apis=${apis.length}`);
  check("危险等级写死 ask，关不开关都一样", run.danger === "ask" && tools.every(t => t.danger === "ask" || t.name.endsWith("_uninstall")));
}

// 2 技能自己失败：壳如实转述，不吞
{
  const { ctx, tools } = makeCtx({}, async () => ({ ok: false, result: "权限不够" }));
  await mod.apply(ctx);
  const out = await tools[0].run({}, {});
  check("技能失败：原因原样带出", out.status === "failed" && out.note === "权限不够", JSON.stringify(out));
}

// 3 超时：只报先停在这里，不假装技能结束了
{
  const { ctx, tools } = makeCtx({ timeoutMs: 5000 }, () => new Promise(() => {}));
  await mod.apply(ctx);
  const t0 = Date.now();
  const out = await tools[0].run({}, {});
  const took = Date.now() - t0;
  check("超时：报先停在这里，不伪造结果", out.status === "failed" && /超过 5000 毫秒/.test(out.note), `${took}ms · ${out.note}`);
}

// 4 卸载：只写墓碑，不删目录
{
  if (existsSync(flag)) rmSync(flag);
  const { ctx, tools } = makeCtx({});
  await mod.apply(ctx);
  const uninstall = tools.find(t => t.name.endsWith("_uninstall"));
  const out = await uninstall.run({ reason: "冒烟测试" }, {});
  const written = existsSync(flag) ? JSON.parse(readFileSync(flag, "utf8")) : null;
  check("卸载：写墓碑、目录还在、状态 pending", out.status === "pending" && written?.reason === "冒烟测试" && existsSync(shellDir), JSON.stringify(written));
  // 冒烟不留墓碑，否则下次启动父插件会真把这个目录清掉。
  if (existsSync(flag)) rmSync(flag);
  check("卸载：测试后墓碑已清掉", !existsSync(flag));
}

// 5 关掉开关：工具不注册，但页面还在
{
  const { ctx, tools, pages } = makeCtx({ enabled: false });
  await mod.apply(ctx);
  check("关掉开关：不注册工具，页面还在", tools.length === 0 && pages.length === 1, `tools=${tools.length} pages=${pages.length}`);
}

// 6 配置读不到：退回默认，不炸
{
  const { ctx, tools } = makeCtx(new Error("没有配置文件"));
  await mod.apply(ctx);
  check("配置读不到：用默认值继续", tools.length === 2, `tools=${tools.length}`);
}

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
