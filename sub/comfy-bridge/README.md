# 思维画布桥（comfy-bridge）

挂在「思维空间」下面的子插件。它自己不画图，只干两件事：

1. **把画布能导入什么摆到台面上** —— 列出生图插件里的 ComfyUI 工作流、列出画布可直接导入的功能包，不合格的、引用了不存在的工作流的，都标出来。
2. **当别的软件的中转** —— 任何软件把自己的流程推过来，桥先按画布那套规矩验一遍，过了就落成同一个格式的功能包，画布那边一视同仁。

出图、看图仍然走《生图》插件（`comfy_generate` / `image_view`）。桥不重复造这一层。

---

## 目录与依赖

```
plugins/
  thinking-space/
    sub/comfy-bridge/          ← 本插件
      index.ts
      plugin.yaml
      README.md
      data/                    ← 设置、来源登记、来源推包的账
  comfy/                       ← 兄弟目录，只通过它公开的 comfy.assets 服务访问，不直接读盘
    plugin.yaml
    workflows/                 ← ComfyUI 的 API 格式工作流，comfy_generate 用
    canvas-flows/              ← 画布功能包，画布「注册功能」用
```

- `plugin.yaml` 里写的是 `depends: [web]`，**不是** `depends: [comfy]`。读工作流走的是**公开服务**（见下节），
  服务不在就降级，不该把整个插件卡在 `blocked`。
- **本插件不读别的插件的目录**：不 `existsSync(plugins/comfy/plugin.yaml)`、不读别人的 `workflows/`。
  这是作者在 issue #9 里明确要求的，跨插件读磁盘一律不算。
- 生图插件不在、或版本太老没提供下面那个服务时，本插件照常起来，页面和回执里写明「当前版本不支持自动列出工作流」，
  手动导入功能包和出图照常。这是有意的：画布页少一块，用户不知道原因。

## 依赖的服务：`comfy.assets`

生图插件（`comfy` ≥ 0.3.1）在 `apply()` 里 `ctx.provide("comfy.assets", …)`，四个方法：

| 方法 | 作用 |
|---|---|
| `listWorkflows()` | 列 `workflows/` 下的 `.json`：`{name, size, mtime}` |
| `listFlows()` | 列 `canvas-flows/` 下的画布功能包（已解析过的 bundle + 校验问题） |
| `saveFlow(name, bundle)` | 写一个功能包，返回落盘路径 |
| `deleteFlow(slug)` | 删一个功能包，返回是否真删了 |

本插件用 `optionalDepends: [comfy.assets]` + `ctx.optional("comfy.assets", …)` 订阅：服务上线下线都能感知，
页面刷新时重新取一次。清单里写的就是实际服务名，不用 `ctx.get(name, false)`——后者一旦取到值就会把
`comfy.assets` 记成本插件的必需依赖，提供方一停用，桥跟着 `blocked`，原先 200 的列表变 404。

拿不到服务时只降级「自动列出工作流」这一块：提示当前版本不支持，**手动导入照常可用**。

---

## 页面

打开「思维空间 → 子插件 → 思维画布桥」，五块：

| 块 | 内容 |
|---|---|
| 体检 | 生图插件 / `comfy_generate` / 工作流数 / 功能包数 / 缺工作流的包 / 已导入画布 / 功能来源 / 画布地址 |
| 画布功能包 | 每包：节点数、工具链、**来源**、校验结论；展开能看每个节点的提示词和工作流，能删、能跳去画布 |
| 功能（全部折叠） | 每一项一个功能来源，默认收起，点开才展开：**ComfyUI**（设置 strict / 默认工作流 / 画布地址 + 工作流文件列表）和**每个外部来源**（它推了几个包 + 它自己声明的设置表单）。推一个新包过来，就自动多一项 |
| 思维画布能导入什么 | 校验规则的速查表 |

「功能」是按来源分的：内置的 ComfyUI 一项，每个外部来源各一项，**默认全部折叠**，页面再长也不会被设置表单淹掉。

> 页面必须带 `settings: true` 才出现在控制台页签里。宿主 `core/ui/extensions.js` 的 `selection` 和 `groupPage` 两处都只认 `p.settings || p.navigation`，只给 `title` 的话页面能打开（200），但控制台里永远是「暂无可用页面」。

---

## 接口

三条，都是同源的，不需要额外鉴权（宿主本来就是本地服务）。

### GET `/plugins/thinking-space/comfy-bridge/api`

机器可读的端点清单、模板、校验规则。别的软件先读这个，不用翻文档猜。

### POST `/plugins/thinking-space/comfy-bridge/providers`

注册一个「来源」。`Content-Type: application/json`：

```json
{
  "id": "blender",
  "name": "Blender",
  "description": "从 Blender 导出渲染流程",
  "fields": [
    { "key": "engine", "label": "渲染引擎", "placeholder": "CYCLES" }
  ]
}
```

- `id`：字母数字下划线减号，最长 60。同一个 id 再发就是更新（`settings` 保留）。
- `fields` 是它想让用户在桥页面上填的项。页面会照这个渲染表单，值存在 `data/providers.json`，不经过画布。

### POST `/plugins/thinking-space/comfy-bridge/import`

推一个功能包。`Content-Type: application/json`：

```json
{
  "provider": { "id": "blender", "name": "Blender" },
  "name": "我的流程",
  "bundle": { "schemaVersion": 1, "rootId": "my-flow", "flows": [ ... ] }
}
```

- 先按画布那套校验走一遍，**过不了直接 400**，`problems` 里逐条列出，**不落盘**。
- 过了就写到 `plugins/comfy/canvas-flows/<name>.json`，并在 `data/imports.json` 里记一笔来源。
- `provider.id` 没注册过的话会自动补一条最小登记，省得还要多打一次请求。
- 同名的包会被覆盖（这是有意的：同一个软件反复导出，用户要的是最新那份）。

返回：

```json
{ "ok": true, "slug": "我的流程", "file": "…\\canvas-flows\\我的流程.json",
  "flowId": "my-flow", "provider": "blender", "note": "…" }
```

### GET `/plugins/thinking-space/comfy-bridge/flows`

当前可导入的功能包列表，画布的「注册功能」对话框读的就是这条。

---

## 功能文件模板

让别的软件照着生成。这是**最小可用**的一份：

```json
{
  "schemaVersion": 1,
  "rootId": "my-flow",
  "flows": [
    {
      "id": "my-flow",
      "name": "我的流程",
      "nodes": [
        {
          "id": "n1",
          "type": "comfy_generate",
          "x": 120,
          "y": 120,
          "params": { "workflow": "我的工作流.json", "prompt": "${prompt}" }
        }
      ],
      "edges": []
    }
  ]
}
```

带两步、第二次用到第一次结果的：

```json
{
  "schemaVersion": 1,
  "rootId": "draw-and-view",
  "flows": [
    {
      "id": "draw-and-view",
      "name": "出图并看图",
      "nodes": [
        { "id": "n1", "type": "comfy_generate", "x": 120, "y": 120,
          "params": { "workflow": "nova-anime.json", "prompt": "${prompt}" } },
        { "id": "n2", "type": "image_view", "x": 360, "y": 120,
          "params": { "path": "${n1.data.path}" } }
      ],
      "edges": [["n1", "n2", "path"]]
    }
  ]
}
```

### 字段说明

| 字段 | 必填 | 规矩 |
|---|---|---|
| `schemaVersion` | ✅ | **必须等于 1**。别的版本画布直接拒 |
| `rootId` | 建议 | 指向 `flows` 里某一页的 id，画布拿它决定打开哪一页 |
| `flows` | ✅ | 非空数组 |
| `flows[].id` | ✅ | 只允许 `[A-Za-z0-9_-]`，长度 1–80。**中文名不能直接当 id**，要换成哈希或 slug |
| `flows[].name` | 建议 | 显示名，可以是中文 |
| `flows[].nodes` | ✅ | 数组，可以为空 |
| `nodes[].id` | ✅ | 非空字符串，图内唯一 |
| `nodes[].type` | ✅ | **必须是画布上已存在的工具名**（`comfy_generate` / `image_view` / `surf_search` / 第三方插件的工具…） |
| `nodes[].x` / `.y` | 建议 | 数字，画布上的位置。缺了也能导，只是叠在一起 |
| `nodes[].params` | 建议 | 传给工具的参数 |
| `edges` | 建议 | 数组，元素是 `[起点节点 id, 终点节点 id, 终点参数名]` |

### 参数怎么写才「可填」

这一步决定发布成技能之后**能不能换参数**：

- `"prompt": "a quiet library"` → 写死。发布出来的技能每次都画同一张。
- `"prompt": "${prompt}"` → **提升成技能的可填参数**。发布后调用时传进去就行。
- `"path": "${n1.data.path}"` → 引用前一个步骤的输出字段。

**悬空占位符是坑**：`${seed}` 这种如果调用时没给值，会被原样当作字符串传给工具，`comfy_generate` 那边直接报 `invalid int value: '${seed}'`。所以可选参数要么给默认值，要么用 `{"$try": ["${seed}", 12345]}` 这种写法回落，要么干脆别写在 params 里、让工具自己随机。

---

## 注意事项

**一、工作流文件得另外带**
功能包里的 `workflow` 字段填的只是个**文件名**，指向 `plugins/comfy/workflows/` 里的某个 `.json`。包本身不含工作流内容。所以：

- 用 ComfyUI 扩展导出时，「存到 WhaleLife」会一次写两份（工作流 + 功能包）
- 走 `POST /import` 的第三方软件，要自己把工作流文件放进 `workflows/`，否则页面会给这个包挂红标「缺工作流」

**二、strict 模式**
默认开着：只列能通过校验的包，不合格的直接隐藏，只在体检里显示「隐藏 N 条」。要看全部就去「ComfyUI」折叠里关掉。

**三、同名覆盖**
`POST /import` 遇到同名包会直接覆盖。所以包名要稳定（用固定的 slug），不要每次带时间戳——否则目录会越堆越多。

**四、来源删了，包不删**
在页面上「移除来源」只删登记，它推上来的功能包文件留着（文件是用户的，留给他自己决定）。要清包用「删除这个包」。

**五、路径就是兄弟目录**
工作流目录和功能包目录是按 `sub/comfy-bridge` 的位置算出来的（`../../comfy/workflows`），不写盘符。所以 `plugins/comfy` 必须和 `plugins/thinking-space` 平级——这是 WhaleLife 的标准布局，正常安装就是这个样子。

**六、页面地址**
`/plugins/thinking-space/comfy-bridge/`。这个路径是跟着子插件 id 走的，改名会变。

---

## 和 ComfyUI 扩展的关系

`ComfyUI-WhaleLife-thinkspace` 是另一份东西，装在 ComfyUI 的 `custom_nodes/` 下，负责**从 ComfyUI 里把流程导出**：

- 「编辑 → 存到 WhaleLife」：写工作流 + 功能包到目标目录
- 「编辑 → 导出画布功能文件」：只下载功能包，不写盘（不用装 WhaleLife 也能用）

桥负责**列出和转手**，扩展负责**生成**。两者通过同一个目录格式对接，谁都不直接调对方。

---

## 开发

```powershell
# 类型检查（借用上游宿主自带的 typescript）
node <WhaleLife>\node_modules\typescript\bin\tsc --noEmit -p <这个仓库>\tsconfig.check.json

# 改完之后重载父插件（子插件跟着重启）
# POST /api/plugin  {"id":"thinking-space","action":"reload"}
```

改插件 `index.ts` **不用重启整个宿主**：插件跑在独立子进程里，重载就是杀进程重开，没有 ESM 缓存。代价是正在跑的调用会被掐断。

许可证：AGPL-3.0-only，附加条款见上游 `LICENSE-ADDITIONAL`。
