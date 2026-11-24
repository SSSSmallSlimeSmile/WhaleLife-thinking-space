// 验证工作流清单在同一个桥实例中经历可用、不可用、空目录和恢复。
import assert from "node:assert/strict";
import { apply } from "../sub/comfy-bridge/index.ts";

const tools = new Map();
const pages = new Map();
let updateBinding;
let workflowResult = [{ name: "demo.json", size: 256, mtime: "2026-01-01" }];
const service = {
  listFlows: async () => [],
  listWorkflows: async () => {
    if (workflowResult instanceof Error) throw workflowResult;
    return workflowResult;
  },
};
await apply({
  optional: (_name, subscriber) => { updateBinding = subscriber; },
  config: { read: async () => undefined },
  tools: {
    list: () => [{ function: { name: "comfy_generate" } }],
    register: (tool) => tools.set(tool.name, tool),
  },
  web: { page: (path, handler) => pages.set(path, handler), api() {} },
  logger: { info() {} },
});

const list = () => tools.get("comfy_workflow_list").run();
async function checkUnavailable() {
  const status = await list();
  assert.equal(status.workflowState, "unavailable");
  assert.match(status.note, /服务不可用.*手动导入.*出图/);
  let html;
  await pages.get("/plugins/thinking-space/comfy-bridge/")({}, {
    writeHead() {},
    end: (body) => { html = body; },
  });
  assert.match(html, /工作流列表服务不可用/);
  assert.doesNotMatch(html, /没有工作流文件|目录里没有/);
}

updateBinding({ service });
assert.deepEqual((await list()).workflows, workflowResult);
updateBinding(null);
await checkUnavailable();
updateBinding({ service });
workflowResult = { 0: { name: "demo.json" } };
await checkUnavailable();
workflowResult = new Error("服务启动中");
await checkUnavailable();
workflowResult = [];
assert.equal((await list()).workflowState, "empty");
assert.match((await list()).note, /目录里没有/);
workflowResult = [{ name: "restored.json", size: 256, mtime: "2026-01-01" }];
const restored = await list();
assert.equal(restored.workflowState, "ready");
assert.deepEqual(restored.workflows, workflowResult);
console.log("PASS  工作流可用、解绑、非数组、调用失败、空目录和自动恢复");
