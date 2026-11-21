# WhaleLife-thinking-space

给 [WhaleLife](https://github.com/horizon-rust/horizon) 用的 **技能库插件**（插件 id：`thinking-space`，页面标题「思维空间」）。

把「一串工具调用」存成一条可复用的**技能**，之后一句 `space_run` 就能跑完整条链，不用让模型每一步都重新推理一遍。

> **状态**：本机（Windows 11 + WhaleLife 本机实例）跑通过，没有在其它系统、其它宿主机上验证过。
> 本仓库是实验性版本，接口来自我们自己的需求，**不是**上游官方插件。
>
> **画布的启停只在 Windows 验证过**：查端口、结束进程走的是 `taskkill` 和 PowerShell，Linux / macOS 上「启动画布 / 停止」会失败。技能库、执行器、页面、自动整理这些不依赖平台。
> 画布脚本路径必须自己在设置页填（出厂为空，插件里不写死任何人的路径）。
> 画布的两份文件（`canvas/index.html` + `canvas/whalelife-workbench.cjs`）随本仓库提供，见第十节；它们不是插件的一部分，需要手动启动。

---

## 一、它解决什么

模型每调一次工具，就要重传一次完整上下文。

```
原生：  surf_search → 一轮完整推理 → surf_read → 一轮完整推理 → 总结
技能组：space_run(搜资料) → 一次调用，内部串完两步 → 总结
```

实测（同一台机器、同一个查询任务）：

| | 轮数 | input token | 墙钟时间 |
|---|---|---|---|
| 原生 | 3 | 71,269 | 99.6 秒 |
| 技能组 | 2 | 48,127 | 17.7 秒 |
| 变化 | −1 | **−32%** | **−82%** |

**反面也记着**：参数名写错一次（技能声明「关键词」，模型填了 `query`），那一轮整废，变成 4 轮 94,714 token，**比原生还多 33%**。省下来的会被一次失误赔回去。

数据来源与完整口径见 [`docs/实测数据.md`](docs/实测数据.md)。

---

## 二、仓库结构

```
plugins/thinking-space/     插件本体（放进宿主 plugins/ 就能用）
  index.ts                  单文件，约 152 KB
  plugin.yaml               id / depends
  README.md                 插件级说明（工具表、路由表、坑）
  LICENSE  LICENSE-ADDITIONAL  NOTICE.md  THIRD_PARTY_NOTICES.md
  data/settings.example.json  出厂设置示例
docs/                       开发与对接文档
  technical           技术说明.md
  integration         插件接入规范.md
  measured            实测数据.md
  questions           待问清单.md
  upstream-note       给上游的插件说明.md
  early-requirement   早期需求.md
README.md                   本文件
```

---

## 三、安装

```
1. 把 plugins/thinking-space/ 整个目录复制到 <WhaleLife>/plugins/
2. 复制 data/settings.example.json 为 data/settings.json（不改也行，代码有默认值）
3. 重启宿主
```

**依赖**：`web`（注册页面和 POST 接口）、`tools`（调用其它插件的工具）。没 `tools` 这个技能库跑不起来。

**可选**：技能里引用的工具得真存在，否则保存时校验不过、状态显示「待核实」。示例技能用到 `surf_search` / `surf_read`，要装 `surf`。

**权限**：页面读写技能定义、启动画布进程，需要 `full`。

---

## 四、八个工具

| 工具 | 用途 |
|---|---|
| `space_skills({ query? })` | 列出技能：ID、名称、步数、权限、状态、跑过几次、上次成败、版本号。给了 query 就按目标匹配，最多返回三个候选，带匹配理由、必填参数、`useWhen`，危险级不是 safe 的会单独提示 |
| `space_skill_save({ id, spec })` | 新建或覆盖同 ID 的技能，校验不过返回 `blocked` 和原因 |
| `space_draft({ name, tools })` | 给一串工具名，自动查归属插件、连 `next` 链，生成草稿并预校验（不保存） |
| `space_run({ id, params, confirmSideEffects, via })` | 真跑一遍，返回逐步回执。via 记来源：`user`（用户明确点名这条技能）/ `self`（自己判断该用，默认）|
| `space_trace({ runId })` | 按 runId 取回一次运行的完整步骤（内存留一小时） |
| `space_organize({ force })` | 从最近的工具调用记录里找反复出现的链，整理成技能。只收 danger 全为 safe 的链；必填参数没有默认值的链会跳过并说明原因 |
| `space_ports({ tool? })` | 读调用记录里存下来的返回值形状，反推每个工具的输出端口路径和类型。纯文本口、空返回、未观测过的各有明确结论 |
| `space_trim({ skill, apply })` | 跑通后如果判定某步白跑，会在回执里留下建议但不自动改。`apply: true` 才真删，`false` 丢弃建议 |

## 五、页面

| 路由 | 内容 |
|---|---|
| `/plugins/thinking-space/` | 介绍、当前状态、设置（含画布启动/停止）、打开画布 |
| `/plugins/thinking-space/space` | 功能库 / 复合功能库列表，每条可「跑一次」「编辑步骤」 |
| `/plugins/thinking-space/edit?id=` | 改步骤：参数 JSON、上移/下移/删除、新增一步 |
| `/plugins/thinking-space/settings` | 同一个设置页 |
| `/plugins/thinking-space/local` | 本机能力：宿主提供什么工具接口、按插件分组的工具数、工具清单（中文名/插件/危险级/输出声明） |
| `/plugins/thinking-space/export` | 导出全部技能为 JSON |

---

## 六、技能定义长什么样

```json
{
  "schemaVersion": 1,
  "id": "search-and-read",
  "name": "搜资料",
  "kind": "composite",
  "params": [{ "name": "query", "label": "关键词", "type": "string", "required": true }],
  "steps": [
    { "id": "n1", "plugin": "surf", "tool": "surf_search",
      "params": { "query": "${query}", "limit": 5 }, "next": "n2" },
    { "id": "n2", "plugin": "surf", "tool": "surf_read",
      "params": { "url": "${n1.data.results[0].url}" }, "next": null }
  ]
}
```

技能还可以带三个可选边界字段，用来让 `space_skills({ query })` 找到它：

```json
{
  "useWhen": "要找一篇具体网页并读到正文，或者用户要出处。例：帮我查一下 AstrBot 插件怎么开发，读完告诉我。",
  "notFor": "只要几个链接、不需要正文时不要用它，直接 surf_search 更快。例：给我几个 AstrBot 的链接。",
  "outputs": "读到的正文摘录，附带 matched / weak / unrelated 的相关性判定。"
}
```

三条约定：

- **机器名与标签分开**。`name` 是给模型调用的（`query`），`label` 是给人看的（关键词）。别名放 `aliases`，老写法继续能用。
- **方括号下标**可以直接取数组元素：`${n1.data.results[0].url}`。
- **候选回落**用 `$try`：前一个取不到就试下一个。

---

## 七、五态回执

| 状态 | 含义 |
|---|---|
| `ok` | 正常跑完 |
| `empty` | 上游没数据，后续步骤未启动 |
| `failed` | 可重试的失败 |
| `uncertain` | **结果未知，不得自动重试**（单步超时走这档） |
| `blocked` | 缺前置条件（技能不存在、缺必填参数、含副作用步骤未确认） |
| `skipped` | 这一步没结果，但后面不依赖它，已继续 |

`uncertain` 单独一档是有意的：写文件、发消息这类动作超时后，你不知道它做没做，自动重试可能做两遍。

---

## 八、自动整理与自动精简

**自动整理**：跑完一轮后，从 `calls.json` 里找反复出现的工具链，攒够次数就存成技能。

```
连续出现 3 次才算一条链（可配）
间隔超 120 分钟算断开
只整理 danger 全 safe 的链
```

**自动精简**：一条技能跑通后回头看，有没有哪一步白跑。

```
删步骤  四条同时满足：跑成功 + 输出没人引用 + 不是最后一步 + 无需确认
        一次最多删到剩 2 步，逐步变短，不一次砍到底
砍候选  $try 连续 3 次都是第一条命中 → 砍掉从没命中的候选
```

**有副作用的步骤永远不会被自动删掉。**

---

## 九、统计与使用趋势

每次跑完都会追加一条到 `data/runs.json`（保留最近 90 天、最多 2000 条），页面顶部的「使用趋势」按今天 / 近 7 天 / 近 30 天画柱状图：绿是成功、红是失败，下面跟一张按技能分组的表。

`stats.json` 里另有汇总：`runs`、`ok`、`failed`、`lastAt`、`reasons`（按原因分类的失败次数）、`sources`（user / self / page / chat）。

> `sources` 里的 `user` / `self` 是后加的；之前的记录归在 `chat`，标「旧记录（未分类）」，不硬塞进新类别。

---

## 十、画布（可选组件）

插件页有一个「启动画布 / 停止」按钮，拉起的是 `canvas/whalelife-workbench.cjs` —— 一个**独立的** node 小服务，默认监听 9281，把画布页面和宿主（9270）连起来。

画布本身是单文件网页 `canvas/index.html`，不是插件，不注册任何工具。**它和技能库目前没有双向同步**：技能能注入成节点看，画布上的改动不回写技能定义。

### 装法

```
1. 把 canvas\ 整个目录放到任意位置（不要放进 plugins\）
2. 设置页 → 画布服务 → 画布脚本路径 → 填 whalelife-workbench.cjs 的完整路径
3. 设置页 → 画布服务 → 启动画布
4. 浏览器打开 http://127.0.0.1:9281/
```

### 依赖

- 需要 WhaleLife 宿主在跑（画布靠它取插件列表、市场目录、工具目录）
- 启停走 `taskkill` 和 PowerShell，**只在 Windows 验过**
- 画布自己每 3 秒探一次宿主端口，宿主没了会自己退出

### 相关命令

| 参数 | 作用 |
|---|---|
| `?flow=<流程id>` | 打开并居中的某条流程 |
| `?skill=<技能id>` | 把一条技能注入成节点并选中 |
| `?flow=<id>&node=<节点id>` | 顺便选中某个节点 |

画布和技能库的契约问题（端口声明、双向同步）见 [`docs/插件接入规范.md`](docs/插件接入规范.md)。

---

### 降级读取（旧宿主）

工具目录优先用 `ctx.tools.catalog()`，它带插件归属、危险级、输出声明。宿主没有这个接口时，自动退回 `ctx.tools.list()`：工具名和描述能用，插件归属、危险级、输出声明拿不到，画布端口会标「未声明」。

打开 `/plugins/thinking-space/local` 能直接看到这台机器走的是哪条路：顶部徽章写着 `catalog 可用` 或 `catalog 不可用`，清单里拿不到的字段显示「未声明」。都不可用时不报错，只是工具列表为空。

---

## 十一、已知问题

| 问题 | 状态 |
|---|---|
| 自动整理学出来的技能**参数是空的** | 只能当模板，不能直接跑（会 `blocked：缺少必填参数`） |
| 页面视觉只在代码层验过 | HTML 里有元素、路由返回 200，**没有逐项在浏览器点过** |
| 自动整理长期是否产出有用技能 | 未验。今天存下的多数来自调试操作 |
| `space_trace` 只留一小时 | 重启后查不到，没做持久化 |
| 插件工具返回 `ok:true` 但正文写「服务没起」 | 本层做了文字嗅探，但这是权宜之计，见待问清单第 4 条 |
| 画布是独立组件 | 不在 `plugins/` 里，要手动配路径和启动；启停只在 Windows 验过 |

---

## 十二、文档

- [`docs/技术说明.md`](docs/技术说明.md) —— 存储结构、执行器、五态、自动整理与精简的实现细节
- [`docs/实测数据.md`](docs/实测数据.md) —— 原生调用 vs 技能组、自动整理、自动精简、候选砍枝的原始数字
- [`docs/插件接入规范.md`](docs/插件接入规范.md) —— 建议上游加一个可选的输出端口声明，让插件市场的插件能无缝转进来
- [`docs/待问清单.md`](docs/待问清单.md) —— 需要上游拍板的问题
- [`docs/给上游的插件说明.md`](docs/给上游的插件说明.md) —— 十二节完整说明，含设计取舍
- [`plugins/thinking-space/README.md`](plugins/thinking-space/README.md) —— 插件级说明

---

## 十三、许可

AGPL-3.0-only。第三方声明见 `plugins/thinking-space/THIRD_PARTY_NOTICES.md`。

本仓库是实验性改动，**不是官方版本**。接口怎么定，以上游为准。
