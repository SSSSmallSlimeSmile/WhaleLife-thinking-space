// 发布半路中断后的恢复：作业记录先落盘、启动回退、可重复跑、清单只动自己那条。
// 跑法：node test/pending.mjs
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const mod = await import(pathToFileURL(join(process.cwd(), "publish.ts")).href);

let pass = 0;
let fail = 0;
function check(name, ok, detail = "") {
  if (ok) { pass += 1; console.log("PASS " + name + (detail ? "  - " + detail : "")); }
  else { fail += 1; console.log("FAIL " + name + (detail ? "  - " + detail : "")); }
}

const skillV1 = {
  id: "crash-demo", name: "崩溃演示", kind: "single", danger: "safe",
  steps: [{ id: "n1", tool: "space_skills", plugin: "thinking-space" }],
};
const skillV2 = { ...skillV1, name: "崩溃演示 v2", steps: [...skillV1.steps, { id: "n2", tool: "space_skills", plugin: "thinking-space" }] };

function makeHost(skills) {
  const root = mkdtempSync(join(tmpdir(), "ts-pending-"));
  mkdirSync(join(root, "sub"), { recursive: true });
  mkdirSync(join(root, "data"), { recursive: true });
  writeFileSync(join(root, "plugin.yaml"), "id: thinking-space\nname: 思维空间\nsub: [canvas]\n", "utf8");
  const apis = [];
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    tools: { call: async (name) => ({ ok: true, result: { status: "ok", tool: name, version: "0.1.0" } }) },
    web: { page() {}, api: (path, handler) => apis.push({ path, handler }) },
  };
  const state = { skills };
  const hooks = {
    here: root, parentId: "thinking-space",
    readSkills: async () => state.skills,
    toolNames: async () => [],
    readBody: async (req) => req.body ?? "",
    escape: (v) => String(v ?? ""),
    html: (t, b) => t + b,
  };
  function boot() { mod.registerSkillPublish(ctx, hooks); }
  boot();
  const routeOf = (path) => {
    const found = apis.filter((item) => item.path === path);
    return found[found.length - 1].handler;
  };
  return { root, state, hooks, boot, routeOf, ctx };
}

function response() {
  return { status: 0, body: null, writeHead(s) { this.status = s; }, end(text) { this.body = JSON.parse(text); } };
}
function request(body) { return { method: "POST", body: JSON.stringify(body) }; }
const readPending = (root) => JSON.parse(readFileSync(join(root, "data", "publish-pending.json"), "utf8")).jobs;
const readRegistry = (root) => JSON.parse(readFileSync(join(root, "data", "publishes.json"), "utf8")).items;
const versionOf = (root, subId) => /^version:\s*(.+)$/m.exec(readFileSync(join(root, "sub", subId, "plugin.yaml"), "utf8"))[1].trim();

// ── 一、先落盘作业记录，再碰目录 ──
const host = makeHost([skillV1]);
let res = response();
await host.routeOf("/plugins/thinking-space/shells/publish")(request({ skillId: "crash-demo" }), res);
check("首次发布成功", res.body?.ok === true, JSON.stringify(res.body).slice(0, 120));
check("发布返回 publishId", typeof res.body?.publishId === "string" && res.body.publishId.length > 8, String(res.body?.publishId));
check("作业记录在、阶段 written", readPending(host.root)[0]?.phase === "written", JSON.stringify(readPending(host.root).map((j) => j.phase)));
check("作业记录写了 publishId 与备份位", readPending(host.root)[0]?.publishId === res.body.publishId && readPending(host.root)[0]?.backup === null);

// ── 二、升版时进程半路退出（旧目录已移走、新文件还没写）──
host.state.skills = [skillV2];
const beforeV1 = readFileSync(join(host.root, "sub", "skill-crash-demo", "index.ts"), "utf8");
const manifestBefore = readFileSync(join(host.root, "plugin.yaml"), "utf8");
let exitCode = 0;
try {
  execFileSync(process.execPath, [".tmp/crash-publish.mjs", host.root, "crash-demo"], {
    env: { ...process.env, WL_PUBLISH_FAULT: "exit-after-remove" },
    stdio: "pipe",
  });
} catch (error) {
  exitCode = error.status ?? -1;
}
check("故障注入让进程停在替换中途", exitCode === 37, String(exitCode));
check("那一刻旧目录已经不在了", !existsSync(join(host.root, "sub", "skill-crash-demo", "index.ts")));
check("那一刻父清单还没动", readFileSync(join(host.root, "plugin.yaml"), "utf8") === manifestBefore);
const stuck = readPending(host.root);
check("作业记录停在 preparing，且指向备份",
  stuck.length === 1 && stuck[0].phase === "preparing" && typeof stuck[0].backup === "string",
  JSON.stringify(stuck.map((job) => [job.phase, job.backup])));

// ── 三、重启：靠作业记录把旧版铺回来 ──
host.boot();
check("重启后旧版目录回来了", existsSync(join(host.root, "sub", "skill-crash-demo", "index.ts")));
check("回来的是旧版本", versionOf(host.root, "skill-crash-demo") === "0.1.0", versionOf(host.root, "skill-crash-demo"));
check("旧版内容一字不差", readFileSync(join(host.root, "sub", "skill-crash-demo", "index.ts"), "utf8") === beforeV1);
check("父清单还是原样", readFileSync(join(host.root, "plugin.yaml"), "utf8") === manifestBefore);
check("作业记录销掉了", readPending(host.root).length === 0);
const afterRecover = readRegistry(host.root).find((item) => item.subId === "skill-crash-demo");
check("登记记成 rolled-back 并留了原因",
  afterRecover?.stage === "rolled-back" && String(afterRecover?.reason ?? "").includes("中途中断"),
  String(afterRecover?.stage) + " / " + String(afterRecover?.reason));

// ── 四、恢复可重复跑：再启一次什么也不变 ──
const snapshot = readFileSync(join(host.root, "sub", "skill-crash-demo", "index.ts"), "utf8");
const manifestSnapshot = readFileSync(join(host.root, "plugin.yaml"), "utf8");
host.boot();
check("再恢复一次不改文件", readFileSync(join(host.root, "sub", "skill-crash-demo", "index.ts"), "utf8") === snapshot);
check("再恢复一次不改清单", readFileSync(join(host.root, "plugin.yaml"), "utf8") === manifestSnapshot);
check("再恢复一次不新增作业", readPending(host.root).length === 0);

// ── 五、文件和清单都写完了、只差重载 → 保留待验收，不回退 ──
const host2 = makeHost([skillV1]);
res = response();
await host2.routeOf("/plugins/thinking-space/shells/publish")(request({ skillId: "crash-demo" }), res);
// 手工把阶段拨回 preparing，模拟「写完文件、还没推进阶段就退出」
const file2 = JSON.parse(readFileSync(join(host2.root, "data", "publish-pending.json"), "utf8"));
file2.jobs[0].phase = "preparing";
writeFileSync(join(host2.root, "data", "publish-pending.json"), JSON.stringify(file2, null, 2), "utf8");
host2.boot();
check("写完了就该保留：阶段升到 written", readPending(host2.root)[0]?.phase === "written", String(readPending(host2.root)[0]?.phase));
check("写完了就不回退：目录还在", existsSync(join(host2.root, "sub", "skill-crash-demo", "index.ts")));
check("写完了就不回退：清单还登记着", readFileSync(join(host2.root, "plugin.yaml"), "utf8").includes("skill-crash-demo"));

// ── 六、回退只动自己那条，不覆盖别人的清单改动 ──
const host3 = makeHost([skillV1]);
res = response();
await host3.routeOf("/plugins/thinking-space/shells/publish")(request({ skillId: "crash-demo" }), res);
// 模拟：发布之后，别的插件（别的发布）又往清单里加了一条
const manifest3 = readFileSync(join(host3.root, "plugin.yaml"), "utf8").replace("sub: [canvas, skill-crash-demo]", "sub: [canvas, skill-crash-demo, later-plugin]");
writeFileSync(join(host3.root, "plugin.yaml"), manifest3, "utf8");
res = response();
await host3.routeOf("/plugins/thinking-space/shells/rollback")(request({ subId: "skill-crash-demo", reason: "手动撤回" }), res);
const manifestAfterRollback = readFileSync(join(host3.root, "plugin.yaml"), "utf8");
check("回退拿掉了自己那条", !manifestAfterRollback.includes("skill-crash-demo"));
check("回退没抹掉后来那条", manifestAfterRollback.includes("later-plugin"), manifestAfterRollback.replace(/\n/g, " | "));
check("回退后作业记录也销了", readPending(host3.root).length === 0);

// ── 七、作业记录写不进去 → 不发布，旧版原样 ──
const host4 = makeHost([skillV1]);
res = response();
await host4.routeOf("/plugins/thinking-space/shells/publish")(request({ skillId: "crash-demo" }), res);
const goodV1 = readFileSync(join(host4.root, "sub", "skill-crash-demo", "index.ts"), "utf8");
// 让写作业记录必然失败：把临时文件名占成一个目录
mkdirSync(join(host4.root, "data", "publish-pending.json.tmp"), { recursive: true });
host4.state.skills = [skillV2];
res = response();
await host4.routeOf("/plugins/thinking-space/shells/publish")(request({ skillId: "crash-demo" }), res);
check("记录写不进去就不发布", res.body?.ok === false && String(res.body?.error ?? "").includes("恢复记录写不进去"), JSON.stringify(res.body).slice(0, 160));
check("旧版文件没动", readFileSync(join(host4.root, "sub", "skill-crash-demo", "index.ts"), "utf8") === goodV1);
check("旧版版本号没动", versionOf(host4.root, "skill-crash-demo") === "0.1.0");

for (const item of [host, host2, host3, host4]) rmSync(item.root, { recursive: true, force: true });

console.log("\n" + pass + "/" + (pass + fail) + " 通过");
process.exit(fail ? 1 : 0);
