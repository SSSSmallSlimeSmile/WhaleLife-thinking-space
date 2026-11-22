// 发布/回退的逻辑冒烟：不碰真宿主，用假 ctx 和临时目录验六件事。
// 跑法：node test/publish.mjs
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const mod = await import(pathToFileURL(join(process.cwd(), "publish.ts")).href);

let pass = 0;
let fail = 0;
function check(name, ok, detail = "") {
  if (ok) { pass += 1; console.log("PASS " + name + (detail ? "  —  " + detail : "")); }
  else { fail += 1; console.log("FAIL " + name + (detail ? "  —  " + detail : "")); }
}

// —— 一、纯函数 ——
check("subIdFor 稳定", mod.subIdFor("demo-canvas-twice") === "skill-demo-canvas-twice", mod.subIdFor("demo-canvas-twice"));
check("subIdFor 收掉怪字符", mod.subIdFor("A b/c__D") === "skill-a-b-c-d", mod.subIdFor("A b/c__D"));
check("toolNameFor 合法", mod.toolNameFor("skill-demo-canvas-twice") === "skill_demo_canvas_twice");

const skill = {
  id: "pub-check-demo", name: "发布演示", kind: "single", danger: "safe",
  steps: [{ id: "n1", tool: "space_skills", plugin: "thinking-space" }],
};
const rendered = mod.renderShell(skill, "skill-pub-check-demo", "0.1.0");
check("生成源码无占位符", !/__[A-Z_]+__/.test(rendered.source));
check("生成源码有 apply", rendered.source.includes("export async function apply"));
check("生成源码带探针", rendered.source.includes("_probe"));
check("清单 id 与目录一致", rendered.manifest.includes("id: skill-pub-check-demo"));
check("静态检查通过", mod.checkRendered(rendered, "skill-pub-check-demo", rendered.toolName).length === 0,
  JSON.stringify(mod.checkRendered(rendered, "skill-pub-check-demo", rendered.toolName)));

const m0 = "id: thinking-space\nname: x\nsub: [canvas]\n";
const m1 = mod.addToManifest(m0, "skill-a");
check("清单追加", mod.addToManifest(m0, "skill-a").includes("sub: [canvas, skill-a]"), JSON.stringify(mod.addToManifest(m0, "skill-a")));
check("清单追加幂等", mod.addToManifest(m1, "skill-a") === m1);
check("清单移除", mod.removeFromManifest(m1, "skill-a").includes("sub: [canvas]"));

// —— 二、发布/验收/回退 ——
function makeHost() {
  const root = mkdtempSync(join(tmpdir(), "ts-publish-"));
  mkdirSync(join(root, "sub"), { recursive: true });
  mkdirSync(join(root, "data"), { recursive: true });
  writeFileSync(join(root, "plugin.yaml"), "id: thinking-space\nname: 思维空间\nsub: [canvas]\n", "utf8");

  const tools = [];          // 宿主里现存的工具
  const probe = { version: "0.1.0" };  // 假探针回的版本，升版用例里要跟着改
  const pages = [];
  const apis = [];
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    tools: {
      call: async (name) => ({ ok: true, result: { status: "ok", tool: name, version: probe.version } }),
    },
    web: {
      page: (path, handler, entry) => { pages.push({ path, handler, entry }); },
      api: (path, handler) => { apis.push({ path, handler }); },
    },
  };
  const hooks = {
    here: root,
    parentId: "thinking-space",
    readSkills: async () => [skill],
    toolNames: async () => tools.slice(),
    readBody: async (req) => req.body ?? "",
    escape: (v) => String(v ?? ""),
    html: (t, b) => t + b,
  };
  return { root, tools, probe, pages, apis, ctx, hooks };
}

function request(body) {
  return { method: "POST", body: JSON.stringify(body) };
}
function response() {
  const res = { status: 0, body: null, writeHead(s) { this.status = s; }, end(text) { this.body = JSON.parse(text); } };
  return res;
}
function route(apis, path) {
  const found = apis.filter((item) => item.path === path);
  return found[found.length - 1].handler;
}

const host = makeHost();
mod.registerSkillPublish(host.ctx, host.hooks);
const publishRoute = route(host.apis, "/plugins/thinking-space/shells/publish");
const verifyRoute = route(host.apis, "/plugins/thinking-space/shells/verify");
const rollbackRoute = route(host.apis, "/plugins/thinking-space/shells/rollback");

// 1) 首次发布
let res = response();
await publishRoute(request({ skillId: "pub-check-demo" }), res);
check("首次发布 ok", res.body?.ok === true && res.body?.reused === false, JSON.stringify(res.body).slice(0, 160));
check("首次发布写了两个文件",
  existsSync(join(host.root, "sub", "skill-pub-check-demo", "index.ts")) &&
  existsSync(join(host.root, "sub", "skill-pub-check-demo", "plugin.yaml")));
check("父清单登记了子插件", readFileSync(join(host.root, "plugin.yaml"), "utf8").includes("sub: [canvas, skill-pub-check-demo]"));
check("首次发布没备份目录", res.body?.backup === null);
const pendingAfterPublish = JSON.parse(readFileSync(join(host.root, "data", "publish-pending.json"), "utf8"));
check("发布后留了作业记录，阶段 written",
  pendingAfterPublish.jobs.length === 1 && pendingAfterPublish.jobs[0].phase === "written",
  JSON.stringify(pendingAfterPublish.jobs.map((job) => job.phase)));
check("作业记录带着发布 id 和备份位置",
  pendingAfterPublish.jobs[0].publishId === res.body?.publishId && pendingAfterPublish.jobs[0].backup === null);

// 2) 没重载就验收 → 工具不在 → 失败
res = response();
await verifyRoute(request({ subId: "skill-pub-check-demo" }), res);
check("未重载时验收失败", res.body?.ok === false && String(res.body?.reason ?? "").includes("工具表里没有"), String(res.body?.reason ?? ""));

// 3) 模拟重载：工具出现 → 验收通过
host.tools.push({ name: "skill_pub_check_demo", plugin: "thinking-space/skill-pub-check-demo" });
host.tools.push({ name: "skill_pub_check_demo_probe", plugin: "thinking-space/skill-pub-check-demo" });
res = response();
await verifyRoute(request({ subId: "skill-pub-check-demo" }), res);
check("重载后验收通过", res.body?.ok === true && res.body?.stage === "verified", JSON.stringify(res.body).slice(0, 160));
check("探针回了版本", res.body?.version === "0.1.0");
check("验收通过后销掉作业记录",
  JSON.parse(readFileSync(join(host.root, "data", "publish-pending.json"), "utf8")).jobs.length === 0);

// 4) 同内容重复发布 → 复用，不写不重载
const beforeText = readFileSync(join(host.root, "sub", "skill-pub-check-demo", "index.ts"), "utf8");
res = response();
await publishRoute(request({ skillId: "pub-check-demo" }), res);
check("重复发布复用", res.body?.ok === true && res.body?.reused === true && res.body?.wroteFiles === 0, JSON.stringify(res.body).slice(0, 160));
check("重复发布没改文件", readFileSync(join(host.root, "sub", "skill-pub-check-demo", "index.ts"), "utf8") === beforeText);
const registryAfter = JSON.parse(readFileSync(join(host.root, "data", "publishes.json"), "utf8"));
check("只有一个子插件登记", registryAfter.items.filter((item) => item.subId === "skill-pub-check-demo").length === 1);
check("工具入口只有一个", host.tools.filter((tool) => tool.name === "skill_pub_check_demo").length === 1);

// 5) 新版发布后加载失败 → 回退 → 旧文件回来
const changed = { ...skill, name: "发布演示 v2", steps: [...skill.steps, { id: "n2", tool: "space_skills", plugin: "thinking-space" }] };
host.hooks.readSkills = async () => [changed];
res = response();
await publishRoute(request({ skillId: "pub-check-demo" }), res);
check("新版本写进去了", res.body?.ok === true && res.body?.version === "0.1.1", JSON.stringify(res.body).slice(0, 160));
check("新版本内容确实变了", readFileSync(join(host.root, "sub", "skill-pub-check-demo", "index.ts"), "utf8") !== beforeText);
host.probe.version = "0.1.1";

// 模拟新版加载失败：工具从宿主里消失
host.tools.length = 0;
res = response();
await verifyRoute(request({ subId: "skill-pub-check-demo" }), res);
check("新版验收失败", res.body?.ok === false);

res = response();
await rollbackRoute(request({ subId: "skill-pub-check-demo", reason: "验收没过" }), res);
check("回退 ok 且是恢复不是删除", res.body?.ok === true && res.body?.restored === true && res.body?.removed === false, JSON.stringify(res.body).slice(0, 200));
check("旧版文件铺回来了", readFileSync(join(host.root, "sub", "skill-pub-check-demo", "index.ts"), "utf8") === beforeText);
check("父清单还留着登记", readFileSync(join(host.root, "plugin.yaml"), "utf8").includes("skill-pub-check-demo"));

// 6) 首次发布失败 → 撤掉目录和登记
const host2 = makeHost();
host2.hooks.readSkills = async () => [{ ...skill, id: "pub-other" }];
mod.registerSkillPublish(host2.ctx, host2.hooks);
const pub2 = route(host2.apis, "/plugins/thinking-space/shells/publish");
const back2 = route(host2.apis, "/plugins/thinking-space/shells/rollback");
res = response();
await pub2(request({ skillId: "pub-other" }), res);
check("第二条也能发布", res.body?.ok === true, JSON.stringify(res.body).slice(0, 120));
res = response();
await back2(request({ subId: "skill-pub-other", reason: "首次发布失败" }), res);
check("首次发布失败是删除", res.body?.ok === true && res.body?.removed === true);
check("目录撤掉了", !existsSync(join(host2.root, "sub", "skill-pub-other")));
check("清单登记撤掉了", !readFileSync(join(host2.root, "plugin.yaml"), "utf8").includes("skill-pub-other"));

// 7) 启动自愈：上次停在 written、文件却坏了 → 自动回退
const host3 = makeHost();
host3.hooks.readSkills = async () => [skill];
mod.registerSkillPublish(host3.ctx, host3.hooks);
const pub3 = route(host3.apis, "/plugins/thinking-space/shells/publish");
res = response();
await pub3(request({ skillId: "pub-check-demo" }), res);
// 把入口弄坏，再模拟宿主重启：新注册一遍
writeFileSync(join(host3.root, "sub", "skill-pub-check-demo", "index.ts"), "// broken\n", "utf8");
mod.registerSkillPublish(host3.ctx, host3.hooks);
const healed = JSON.parse(readFileSync(join(host3.root, "data", "publishes.json"), "utf8"));
const record = healed.items.find((item) => item.subId === "skill-pub-check-demo");
check("启动自愈把记录标成撤回", record?.stage === "withdrawn", String(record?.stage));
check("启动自愈撤掉了坏目录", !existsSync(join(host3.root, "sub", "skill-pub-check-demo")));
check("启动自愈撤掉了清单登记", !readFileSync(join(host3.root, "plugin.yaml"), "utf8").includes("skill-pub-check-demo"));

for (const item of [host, host2, host3]) rmSync(item.root, { recursive: true, force: true });

console.log(`\n${pass}/${pass + fail} 通过`);
process.exit(fail ? 1 : 0);
