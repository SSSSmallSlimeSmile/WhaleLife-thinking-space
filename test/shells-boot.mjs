// Run with Node 24+. Add --mutate to verify that each regression fails its target assertion.
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const adjacentRoot = fileURLToPath(new URL("../", import.meta.url));
const repo = existsSync(join(adjacentRoot, "sub", "shells", "index.ts"))
  ? adjacentRoot
  : "K:/Github/thinking-space-test";
const parentFile = "index.ts";
const shellFile = join("sub", "shells", "index.ts");
const entryFiles = [parentFile, shellFile];

const skillId = "skill_one";
const stepTool = "boot_probe";
const skill = {
  id: skillId, name: "Boot probe", description: "", kind: "single",
  danger: "safe", revision: 1, stepCount: 1, params: [],
  steps: [{ id: "s1", tool: stepTool, plugin: "test", params: {}, next: null }],
};
const shell = {
  skillId, toolName: skillId, label: skill.name, danger: "ask",
  skillRevision: 1, enabled: true, addedAt: "2026-01-01T00:00:00.000Z",
};

function makeCtx({ files = {}, skills = [], catalog = [] } = {}) {
  const saved = new Map(Object.entries(structuredClone(files)));
  const writes = [];
  const tools = new Map();
  const calls = [];
  const ctx = {
    config: Object.assign(
      (file) => structuredClone(saved.get(file) ?? {}),
      {
        read: async (file) => structuredClone(saved.get(file) ?? {}),
        save: async (file, value) => {
          writes.push(file);
          saved.set(file, structuredClone(value));
        },
      },
    ),
    get: (name) => name === "thinking-space.skills" ? { describe: async () => skills } : undefined,
    provide() {},
    on: () => () => {},
    tools: {
      register(tool) {
        tools.set(tool.name, tool);
        return () => tools.delete(tool.name);
      },
      catalog: async () => catalog,
      async call(name) {
        calls.push(name);
        return { ok: true, result: { done: true } };
      },
    },
    web: { page() {}, api() {} },
    logger: { info() {}, warn() {}, error() {} },
  };
  return { ctx, saved, writes, tools, calls };
}

const approvalLabel = "legacy approval alone triggers a save that removes approval";
const fullLabel = "registered shell preserves full read from disk";
const gateLabel = (order) => "catalog [" + order + "] stops at side-effect confirmation";
const callsLabel = (order) => "catalog [" + order + "] calls the step tool zero times";
const confirmLabel = (order) => "catalog [" + order + "] runs the step tool once when confirmed";

async function runSuite(parent, shells) {
  const failed = [];
  let passed = 0;
  function check(label, ok, actual) {
    if (ok) passed += 1;
    else failed.push(label);
    console.log((ok ? "PASS  " : "FAIL  ") + label + (ok ? "" : " — " + JSON.stringify(actual)));
  }

  async function boot(fields, skills) {
    const b = makeCtx({ files: { "shells.json": { schemaVersion: 1, items: [{ ...shell, ...fields }] } }, skills });
    await shells.apply(b.ctx);
    return { ...b, tool: b.tools.get(skillId), item: b.saved.get("shells.json").items[0] };
  }

  {
    // Both permission fields are already valid, so only approval can trigger a save.
    const b = await boot({ requiredPermission: "ask", approval: "full" }, [{ ...skill, danger: "ask" }]);
    check(approvalLabel, b.writes.length === 1 && b.writes[0] === "shells.json" &&
      b.item && !Object.hasOwn(b.item, "approval"), { writes: b.writes, item: b.item });
  }

  {
    const b = await boot({ danger: "bogus", requiredPermission: "bogus" });
    check("invalid stored danger registers as ask", b.tool?.danger === "ask", b.tool?.danger);
    const out = await b.tool?.run({}, { permission: "full" });
    check("invalid stored permission blocks before consulting the current skill",
      out?.status === "blocked" && /壳记录里没有技能的权限声明/.test(out.note), out);
    check("invalid stored permission never forwards to space_run", !b.calls.includes("space_run"), b.calls);
  }

  {
    // A valid permission prevents backfill from masking a read-time downgrade.
    const b = await boot({ danger: "full", requiredPermission: "full" }, [{ ...skill, danger: "full" }]);
    check(fullLabel, b.tool?.danger === "full", b.tool?.danger);
  }

  {
    const b = await boot({ danger: "ask" }, [{ ...skill, danger: "full" }]);
    check("missing stored permission is backfilled and saved as full",
      b.writes.includes("shells.json") && b.item?.requiredPermission === "full" && b.item?.danger === "full",
      { writes: b.writes, item: b.item });
    check("permission backfill registers the repaired full danger", b.tool?.danger === "full", b.tool?.danger);
  }

  {
    const b = await boot({ danger: "safe", requiredPermission: "safe" });
    const out = await b.tool?.run({}, { permission: "full" });
    check("valid stored permission blocks when the current skill is missing",
      out?.status === "blocked" && /读不到当前技能的权限声明/.test(out.note), out);
    check("missing current skill never forwards to space_run", !b.calls.includes("space_run"), b.calls);
  }

  {
    const b = await boot({ danger: "safe", requiredPermission: "safe" }, [skill]);
    check("valid safe shell registers as safe", b.tool?.danger === "safe", b.tool?.danger);
  }

  async function runSpace(order, extra = {}) {
    const b = makeCtx({
      files: { "skills.json": { schemaVersion: 1, skills: [skill] } },
      catalog: order.map(danger => ({ name: stepTool, plugin: "test", danger })),
    });
    await parent.apply(b.ctx);
    const out = await b.tools.get("space_run").run({ id: skillId, ...extra }, { permission: "full" });
    return { out, stepCalls: b.calls.filter(name => name === stepTool).length };
  }

  for (const order of [["full", "safe"], ["safe", "full"]]) {
    const { out, stepCalls } = await runSpace(order);
    check(gateLabel(order), out?.status === "blocked" &&
      /含副作用步骤.*需要 confirmSideEffects:true/.test(out.error), out);
    check(callsLabel(order), stepCalls === 0, stepCalls);

    // Confirming the same chain must go through: a stricter danger is a gate, not a permanent block.
    const confirmed = await runSpace(order, { confirmSideEffects: true });
    check(confirmLabel(order), confirmed.out?.status === "ok" && confirmed.stepCalls === 1, confirmed);
  }

  const safe = await runSpace(["safe", "safe"]);
  check("catalog [safe,safe] runs the step tool once",
    safe.out?.status === "ok" && safe.stepCalls === 1, safe);

  console.log(passed + " PASS / " + failed.length + " FAIL");
  return failed;
}

const mutations = [
  {
    name: "skip the save triggered solely by leftover approval",
    file: shellFile,
    before: "let patched = strippedLegacyApproval;",
    after: "let patched = false;",
    expected: [approvalLabel],
  },
  {
    name: "downgrade stored full danger to ask on read",
    file: shellFile,
    before: 'item.danger === "full" || item.danger === "safe" ? item.danger : "ask"',
    after: 'item.danger === "safe" ? item.danger : "ask"',
    expected: [fullLabel],
  },
  {
    name: "require confirmation even after the caller confirms",
    file: parentFile,
    before: "if (sideEffects && args?.confirmSideEffects !== true)",
    after: "if (sideEffects)",
    expected: [confirmLabel(["full", "safe"]), confirmLabel(["safe", "full"])],
  },
  {
    name: "overwrite duplicate catalog entries with the last entry",
    file: parentFile,
    before: "map.set(tool.name, prev ? { ...tool, danger: stricterDanger(prev.danger, tool.danger) } : tool);",
    after: "map.set(tool.name, tool);",
    expected: [gateLabel(["full", "safe"]), callsLabel(["full", "safe"])],
  },
];

async function runCopy(mutation) {
  // Parent apply scans its own subdirectory at startup. Stage only the two entry points.
  const dir = mkdtempSync(join(resolve(tmpdir()), "shells-boot-"));
  const sub = join(dir, "sub");
  const shellDir = join(sub, "shells");
  try {
    mkdirSync(shellDir, { recursive: true });
    for (const file of entryFiles) {
      let source = readFileSync(join(repo, file));
      if (file === mutation?.file) {
        source = source.toString("utf8");
        if (source.split(mutation.before).length !== 2) {
          throw new Error("Expected exactly one mutation site for " + mutation.name);
        }
        source = source.replace(mutation.before, mutation.after);
      }
      writeFileSync(join(dir, file), source);
    }

    const parent = await import(pathToFileURL(join(dir, parentFile)).href);
    const shells = await import(pathToFileURL(join(dir, shellFile)).href);
    return await runSuite(parent, shells);
  } finally {
    for (const path of entryFiles.map(file => join(dir, file))) {
      if (existsSync(path)) unlinkSync(path);
    }
    for (const path of [shellDir, sub, dir]) {
      if (existsSync(path)) rmdirSync(path);
    }
  }
}

const baseline = await runCopy();
if (baseline.length > 0) {
  process.exitCode = 1;
} else if (process.argv.includes("--mutate")) {
  for (const mutation of mutations) {
    console.log("\nMutation: " + mutation.name);
    const failed = await runCopy(mutation);
    if (mutation.expected.every(label => failed.includes(label))) {
      console.log("Mutation detected");
    } else {
      console.error("Mutation missed a target assertion: " + mutation.expected.filter(label => !failed.includes(label)).join(", "));
      process.exitCode = 1;
    }
  }
}
