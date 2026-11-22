// 页面脚本的重载判定：接口拒绝 / 请求断开 / 成功，三种结果分开走。
// 跑法：node test/shells-client.mjs
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";

const mod = await import(pathToFileURL(join(process.cwd(), "publish.ts")).href);

let pass = 0;
let fail = 0;
function check(name, ok, detail = "") {
  if (ok) { pass += 1; console.log("PASS " + name + (detail ? "  - " + detail : "")); }
  else { fail += 1; console.log("FAIL " + name + (detail ? "  - " + detail : "")); }
}

const skill = {
  id: "client-demo", name: "页面判定演示", kind: "single", danger: "safe",
  steps: [{ id: "n1", tool: "space_skills", plugin: "thinking-space" }],
};

const root = mkdtempSync(join(tmpdir(), "ts-client-"));
mkdirSync(join(root, "sub"), { recursive: true });
mkdirSync(join(root, "data"), { recursive: true });
writeFileSync(join(root, "plugin.yaml"), "id: thinking-space\nname: 思维空间\nsub: [canvas]\n", "utf8");

const apis = [];
const pages = [];
const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  tools: { call: async () => ({ ok: true, result: { status: "ok" } }) },
  web: {
    page: (path, handler) => pages.push({ path, handler }),
    api: (path, handler) => apis.push({ path, handler }),
  },
};
mod.registerSkillPublish(ctx, {
  here: root, parentId: "thinking-space",
  readSkills: async () => [skill],
  toolNames: async () => [],
  readBody: async (req) => req.body ?? "",
  escape: (v) => String(v ?? ""),
  html: (t, b) => t + b,
});

// 取页面 HTML 里的那段脚本
let html = "";
const pageRes = { status: 0, writeHead(s) { this.status = s; }, end(text) { html = text; } };
await pages[pages.length - 1].handler({ method: "GET", url: "/plugins/thinking-space/shells" }, pageRes);
const start = html.indexOf("<script>");
const end = html.lastIndexOf("</script>");
check("页面里带脚本", start >= 0 && end > start, "html " + html.length + " 字节");
const script = html.slice(start + "<script>".length, end);
check("脚本里没有反引号（不会被模板字符串吃掉）", !script.includes("`"));

// —— 一个能把 fetch 按场景换掉的沙盒 ——
function sandbox(config) {
  const calls = { reload: 0, rollback: 0, verify: 0, publish: 0, status: 0 };
  const appended = [];
  const report = { textContent: "", appendChild() {} };
  const bar = { textContent: "", appendChild(node) { appended.push(node); } };
  const json = (body) => ({ ok: true, status: 200, json: async () => body });
  async function fetchMock(path, options) {
    if (path.startsWith("/plugins/thinking-space/shells/publish")) { calls.publish += 1; return json(config.publish ?? { ok: true, subId: "skill-client-demo", toolName: "skill_client_demo", version: "0.2.0", publishId: "pub-1", reloadId: "thinking-space", needsReload: true }); }
    if (path.startsWith("/plugins/thinking-space/shells/verify")) { calls.verify += 1; return json(config.verify ?? { ok: true, version: "0.2.0" }); }
    if (path.startsWith("/plugins/thinking-space/shells/rollback")) { calls.rollback += 1; return json(config.rollback ?? { ok: true, version: "0.1.0", needsReload: true, reloadId: "thinking-space" }); }
    if (path === "/api/plugin") { calls.reload += 1; if (config.reloadThrows) throw new Error("Failed to fetch"); return json({ ok: true }); }
    if (path.startsWith("/api/status")) {
      calls.status += 1;
      if (config.statusDown) throw new Error("ECONNREFUSED");
      return json({ plugins: config.plugins ?? [], pending: config.pending ?? [] });
    }
    throw new Error("unexpected path " + path);
  }
  const context = {
    window: {},
    document: {
      getElementById: (id) => (id === "report" ? report : id === "resume" ? bar : null),
      createElement: () => ({ textContent: "", dataset: {}, addEventListener() {} }),
      querySelectorAll: () => [],
    },
    fetch: fetchMock,
    setTimeout: (fn) => { fn(); return 0; },
    console,
  };
  vm.createContext(context);
  vm.runInContext(script, context, { filename: "shells-client.js" });
  return { shells: context.window.__shells, calls, report, appended, context };
}

const JOB = { subId: "skill-client-demo", toolName: "skill_client_demo", version: "0.2.0", reloadId: "thinking-space", publishId: "pub-1" };
const entry = (version, enabled = true) => [{ id: "thinking-space/skill-client-demo", version, enabled }];

// 1）一切正常
let box = sandbox({ plugins: entry("0.2.0"), pending: [] });
let out = await box.shells.settle(JOB, 3, 0);
check("正常：判定为通过", out.state === "ok", JSON.stringify(out));
check("正常：settle 自己不发重载", box.calls.reload === 0, JSON.stringify(box.calls));

box = sandbox({ plugins: entry("0.2.0"), pending: [] });
out = await box.shells.full("client-demo");
check("full 正常：状态 ok", out.state === "ok", JSON.stringify(out));
check("full 正常：重载一次、验收一次", box.calls.reload === 1 && box.calls.verify === 1 && box.calls.rollback === 0,
  JSON.stringify(box.calls));

// 2）宿主重载成功，但浏览器没收到响应（fetch 抛网络错误）
const lonely = sandbox({ plugins: entry("0.2.0"), reloadThrows: true, pending: [] });
const reload = await lonely.shells.reloadParent("thinking-space");
check("断线：重载结果标记成 unreachable", reload.kind === "unreachable", JSON.stringify(reload));

box = sandbox({ plugins: entry("0.2.0"), reloadThrows: true, pending: [] });
out = await box.shells.full("client-demo");
check("断线但宿主已换版：继续验收通过", out.state === "ok", JSON.stringify(out));
check("断线时只发了一次重载，也没有误回退", box.calls.reload === 1 && box.calls.rollback === 0, JSON.stringify(box.calls));

// 3）状态接口也连不上 → 待确认，不回退
box = sandbox({ statusDown: true, pending: [{ publishId: "pub-1", subId: "skill-client-demo", version: "0.2.0", phase: "written" }] });
out = await box.shells.settle(JOB, 3, 0);
check("全连不上：判定为待确认", out.state === "unknown", JSON.stringify(out));
out = await box.shells.finish(JOB, { kind: "unreachable" });
check("待确认不回退", out.state === "unknown" && box.calls.rollback === 0, JSON.stringify(box.calls));
check("待确认时给出继续核对入口", box.appended.length === 1 && box.appended[0].textContent === "继续核对");

// 4）重载后还是旧版本 → 回退，再重载一次
box = sandbox({ plugins: entry("0.1.0"), pending: [] });
out = await box.shells.full("client-demo");
check("版本没变：走回退", out.state === "rolled-back", JSON.stringify(out));
check("版本没变：回退一次、重载两次", box.calls.rollback === 1 && box.calls.reload === 2, JSON.stringify(box.calls));

// 5）发布前就停用 → 不重载，保持停用
box = sandbox({ plugins: entry("0.1.0", false), pending: [] });
out = await box.shells.full("client-demo");
check("停用状态：判定为 disabled", out.state === "disabled", JSON.stringify(out));
check("停用状态：不发起重载也不回退", box.calls.reload === 0 && box.calls.rollback === 0, JSON.stringify(box.calls));

// 6）继续核对时，这条发布已经被别的轮次顶掉 → 不动手
const config6 = { statusDown: true, pending: [] };
box = sandbox(config6);
await box.shells.finish(JOB, { kind: "unreachable" });   // 走一遍「待确认」，把作业记进本页
box.report.textContent = "";
config6.statusDown = false;                               // 宿主回来了，但待确认列表里已经没有这一条
config6.plugins = entry("0.2.0");
config6.pending = [{ publishId: "pub-other", subId: "skill-other", version: "1.0.0", phase: "written" }];
const resumed = await box.shells.resume("pub-1");
check("过期的继续核对不处理", resumed === undefined && String(box.report.textContent).includes("不是待确认状态"), String(box.report.textContent).slice(0, 80));

rmSync(root, { recursive: true, force: true });
console.log("\n" + pass + "/" + (pass + fail) + " 通过");
process.exit(fail ? 1 : 0);
