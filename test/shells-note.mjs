// 第 3 条：旧记录清理写盘失败时，页面要真的把这句话显示出来。
// 之前 lastNote 赋了值，但页面只从 URL 的 ?note= 读，永远看不到。
import { pathToFileURL } from "node:url";

const mod = await import(
  pathToFileURL(new URL("../sub/shells/index.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")).href
);

const SKILL = { id: "side-demo", name: "会写文件的技能", kind: "single", danger: "ask", revision: 2, stepCount: 1, params: [] };
const item = (extra = {}) => ({
  skillId: SKILL.id,
  toolName: "skill_side_demo",
  label: SKILL.name,
  danger: "ask",
  requiredPermission: "ask",
  skillRevision: 2,
  enabled: true,
  addedAt: "2026-01-01T00:00:00.000Z",
  ...extra,
});

const results = [];
const check = (label, ok, extra = "") => {
  results.push({ label, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
};

function makeCtx({ store, saveFails = false } = {}) {
  const pages = new Map();
  const ctx = {
    config: {
      read: async () => JSON.parse(JSON.stringify(store)),
      save: async () => {
        if (saveFails) {
          const e = new Error("EACCES: permission denied, open 'shells.json'");
          e.code = "EACCES";
          throw e;
        }
      },
    },
    get: (name) => (name === "thinking-space.skills" ? { describe: async () => [SKILL] } : undefined),
    tools: {
      register: () => () => {},
      call: async (name) => {
        if (name === "space_skills") return { ok: true, result: { skills: [{ id: SKILL.id, revision: 2 }] } };
        return { ok: true, result: { status: "ok", runId: "r1", steps: [{}] } };
      },
    },
    web: { page: (path, handler) => pages.set(path, handler), api: () => {} },
    logger: { info() {}, warn() {}, error() {} },
  };
  return { ctx, pages };
}

async function getPageHtml(opts) {
  const { ctx, pages } = makeCtx(opts);
  await mod.apply(ctx);
  const handler = [...pages.values()][0];
  if (!handler) return { html: "", found: false };
  let body = "";
  const res = {
    writeHead() {},
    end(chunk) {
      body += String(chunk ?? "");
    },
  };
  await handler({ url: "/plugins/thinking-space/shells/" }, res);
  return { html: body, found: true };
}

// 1. 写盘失败：页面要带那句话，并且是 bad 色调。
{
  const store = { schemaVersion: 1, items: [item({ approval: "full" })] };
  const { html, found } = await getPageHtml({ store, saveFails: true });
  check("页面渲染成功", found && html.length > 500, `${html.length} 字节`);
  check("页面出现「旧记录清理没写进磁盘」", /旧记录清理没写进磁盘/.test(html));
  check("带上原始错误（EACCES）", /EACCES/.test(html));
  check("用的是 bad 色调", /class="notice bad"/.test(html));
}

// 2. 写盘成功：不该凭空出现这句。
{
  const store = { schemaVersion: 1, items: [item({ approval: "full" })] };
  const { html } = await getPageHtml({ store, saveFails: false });
  check("写盘成功时不显示该提示", !/旧记录清理没写进磁盘/.test(html));
}

// 3. URL 自己带的提示优先，不被启动那句盖掉。
{
  const store = { schemaVersion: 1, items: [item({ approval: "full" })] };
  const { ctx, pages } = makeCtx({ store, saveFails: true });
  await mod.apply(ctx);
  const handler = [...pages.values()][0];
  let body = "";
  await handler(
    { url: "/plugins/thinking-space/shells/?note=" + encodeURIComponent("已加壳：side-demo") + "&tone=ok" },
    { writeHead() {}, end(c) { body += String(c ?? ""); } }
  );
  check("URL 提示优先", /已加壳：side-demo/.test(body) && !/旧记录清理没写进磁盘/.test(body));
  check("URL 的 tone=ok 保留", /class="notice ok"/.test(body));
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
if (failed) process.exit(1);
