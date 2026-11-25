// 审查出来的几条并发/失败路径：整份快照写盘会互相覆盖、写盘失败后运行态与磁盘分叉、
// 注销失败把句柄丢了。这些都是「回执说成功、实际没成」那一类。
import { pathToFileURL } from "node:url";
import { Readable } from "node:stream";

const mod = await import(
  pathToFileURL(new URL("../sub/shells/index.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")).href
);

const skills = [
  { id: "skill_one", name: "一号", kind: "single", danger: "ask", revision: 1, stepCount: 1, params: [] },
  { id: "skill_two", name: "二号", kind: "single", danger: "ask", revision: 1, stepCount: 1, params: [] },
];

const results = [];
const check = (label, ok, extra = "") => {
  results.push({ label, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
};

function makeCtx({ disk = { schemaVersion: 1, items: [] }, failSave = () => false, disposeThrows = false } = {}) {
  const routes = new Map();
  let saved = JSON.parse(JSON.stringify(disk));
  const registered = new Map();
  const state = {
    saveFails: failSave,
    disposeThrows,
    get saved() {
      return saved;
    },
    get registered() {
      return [...registered.keys()];
    },
  };
  const ctx = {
    config: {
      read: async () => JSON.parse(JSON.stringify(saved)),
      save: async (_file, value) => {
        if (state.saveFails()) {
          const e = new Error("EACCES: permission denied, open 'shells.json'");
          e.code = "EACCES";
          throw e;
        }
        await new Promise((r) => setTimeout(r, 5)); // 让并发请求真的交错
        saved = JSON.parse(JSON.stringify(value));
      },
    },
    get: (name) => (name === "thinking-space.skills" ? { describe: async () => skills } : undefined),
    tools: {
      register: (tool) => {
        registered.set(tool.name, tool);
        return () => {
          if (state.disposeThrows) throw new Error("注销失败：句柄已失效");
          registered.delete(tool.name);
        };
      },
      call: async (name) => {
        if (name === "space_skills") return { ok: true, result: { skills } };
        return { ok: true, result: { status: "ok", runId: "r1", steps: [{}] } };
      },
    },
    web: { page: () => {}, api: (path, handler) => routes.set(path, handler) },
    logger: { info() {}, warn() {}, error() {} },
  };
  return { ctx, routes, state };
}

async function post(route, body) {
  const req = Readable.from([Buffer.from(body)]);
  let status = 0;
  let location = "";
  const res = {
    writeHead(code, headers) {
      status = code;
      location = String(headers?.Location ?? "");
    },
    end() {},
  };
  await route(req, res);
  return { status, location: decodeURIComponent(location) };
}

// 1. 两条不同技能的加壳同时进来：两份都必须在磁盘上（原来会只剩一份）。
{
  const built = makeCtx();
  await mod.apply(built.ctx);
  const add = [...built.routes.entries()].find(([p]) => p.endsWith("add"))[1];
  await Promise.all([
    post(add, "skillId=skill_one"),
    post(add, "skillId=skill_two"),
  ]);
  const ids = built.state.saved.items.map((i) => i.skillId).sort();
  check("并发加两个壳，磁盘两条都在", ids.join(",") === "skill_one,skill_two", ids.join(","));
  check("两个工具都注册了", built.state.registered.length === 2, built.state.registered.join(","));
}

// 2. 同一条技能并发加两次：只留一条，不能出现 _2 后缀。
{
  const built = makeCtx();
  await mod.apply(built.ctx);
  const add = [...built.routes.entries()].find(([p]) => p.endsWith("add"))[1];
  await Promise.all([post(add, "skillId=skill_one"), post(add, "skillId=skill_one")]);
  const names = built.state.saved.items.map((i) => i.toolName);
  check("同一技能并发加壳只留一条", names.length === 1, names.join(","));
  check("没有 _2 后缀", !names.some((n) => n.endsWith("_2")), names.join(","));
}

// 3. 删除时写盘失败：回执要是失败，内存、工具表、磁盘三边一致（都还留着）。
{
  const disk = { schemaVersion: 1, items: [{ skillId: "skill_one", toolName: "skill_one", label: "一号", danger: "ask", requiredPermission: "ask", skillRevision: 1, enabled: true, addedAt: "2026-01-01T00:00:00.000Z" }] };
  const built = makeCtx({ disk });
  await mod.apply(built.ctx);
  check("启动后已注册", built.state.registered.includes("skill_one"), built.state.registered.join(","));
  built.state.saveFails = () => true;
  const remove = [...built.routes.entries()].find(([p]) => p.endsWith("remove"))[1];
  const r = await post(remove, "skillId=skill_one");
  check("写盘失败时回执是失败", /bad/.test(r.location) || /没删成/.test(r.location), r.location);
  check("磁盘没被改（仍有一条）", built.state.saved.items.length === 1, String(built.state.saved.items.length));
  check("写盘失败后工具还在（没和磁盘分叉）", built.state.registered.includes("skill_one"), built.state.registered.join(","));
}

// 4. 注销抛错：句柄不能丢，页面要留一句提示。
{
  const disk = { schemaVersion: 1, items: [{ skillId: "skill_one", toolName: "skill_one", label: "一号", danger: "ask", requiredPermission: "ask", skillRevision: 1, enabled: true, addedAt: "2026-01-01T00:00:00.000Z" }] };
  const built = makeCtx({ disk });
  await mod.apply(built.ctx);
  built.state.disposeThrows = true;
  // 删掉记录 → 注销抛错 → 走 syncRegistrations 的失败分支
  const remove = [...built.routes.entries()].find(([p]) => p.endsWith("remove"))[1];
  await post(remove, "skillId=skill_one");
  const page = [...built.routes.entries()].find(([p]) => p.includes("shells") && p.endsWith("/"))?.[1];
  let html = "";
  if (page) {
    await page({ url: "/plugins/thinking-space/shells/" }, { writeHead() {}, end(c) { html += String(c ?? ""); } });
  }
  check("注销失败后工具没被当成已注销", built.state.registered.includes("skill_one"), built.state.registered.join(","));
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
if (failed) process.exit(1);
