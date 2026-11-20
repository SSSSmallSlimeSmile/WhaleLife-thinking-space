# WhaleLife-thinking-space-test

给 [WhaleLife](https://github.com/horizon-rust/horizon) 用的 **技能库插件**（插件 id：`thinking-space`，页面标题「思维空间」）。

把「一串工具调用」存成一条可复用的**技能**，之后一句 `space_run` 就能跑完整条链，不用让模型每一步都重新推理一遍。

> **状态**：本机（Windows 11 + WhaleLife 本机实例）跑通过，没有在其它系统、其它宿主机上验证过。
> 本仓库是实验性版本，接口来自我们自己的需求，**不是**上游官方插件。
>
> **画布的启停只在 Windows 验证过**：查端口、结束进程走的是 `taskkill` 和 PowerShell，Linux / macOS 上「启动画布 / 停止」会失败。技能库、执行器、页面、自动整理这些不依赖平台。
> 画布脚本路径必须自己在设置页填（出厂为空，插件里不写死任何人的路径）。

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
  index.ts                  单文件，约 105 KB
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

## 四、六个工具

| 工具 | 用途 |
|---|---|
| `space_skills()` | 列出技能：ID、名称、步数、权限、状态、跑过几次、上次成败、版本号 |
| `space_skill_save({ id, spec })` | 新建或覆盖同 ID 的技能，校验不过返回 `blocked` 和原因 |
| `space_draft({ name, tools })` | 给一串工具名，自动查归属插件、连 `next` 链，生成草稿并预校验（不保存） |
| `space_run({ id, params, confirmSideEffects })` | 真跑一遍，返回逐步回执 |
| `space_trace({ runId })` | 按 runId 取回一次运行的完整步骤（内存留一小时） |
| `space_organize({ force })` | 从最近的工具调用记录里找反复出现的链，整理成技能 |

## 五、页面

| 路由 | 内容 |
|---|---|
| `/plugins/thinking-space/` | 介绍、当前状态、设置（含画布启动/停止）、打开画布 |
| `/plugins/thinking-space/space` | 功能库 / 复合功能库列表，每条可「跑一次」「编辑步骤」 |
| `/plugins/thinking-space/edit?id=` | 改步骤：参数 JSON、上移/下移/删除、新增一步 |
| `/plugins/thinking-space/settings` | 同一个设置页 |
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

## 九、和画布（工作台）的关系

插件页有一个「启动画布 / 停止」按钮，能拉起一个**独立的** node 脚本（画布原型，不在本仓库）。

那是实验性的可视化流程编辑器，和本插件的技能库**还没有双向同步**。两边都是「工具链」的概念，但数据格式不同，要打通得先定契约——见 [`docs/插件接入规范.md`](docs/插件接入规范.md)。

---

## 十、已知问题

| 问题 | 状态 |
|---|---|
| 自动整理学出来的技能**参数是空的** | 只能当模板，不能直接跑（会 `blocked：缺少必填参数`） |
| 页面视觉只在代码层验过 | HTML 里有元素、路由返回 200，**没有逐项在浏览器点过** |
| 自动整理长期是否产出有用技能 | 未验。今天存下的多数来自调试操作 |
| `space_trace` 只留一小时 | 重启后查不到，没做持久化 |
| 插件工具返回 `ok:true` 但正文写「服务没起」 | 本层做了文字嗅探，但这是权宜之计，见待问清单第 4 条 |

---

## 十一、文档

- [`docs/技术说明.md`](docs/技术说明.md) —— 存储结构、执行器、五态、自动整理与精简的实现细节
- [`docs/实测数据.md`](docs/实测数据.md) —— 原生调用 vs 技能组、自动整理、自动精简、候选砍枝的原始数字
- [`docs/插件接入规范.md`](docs/插件接入规范.md) —— 建议上游加一个可选的输出端口声明，让插件市场的插件能无缝转进来
- [`docs/待问清单.md`](docs/待问清单.md) —— 需要上游拍板的问题
- [`docs/给上游的插件说明.md`](docs/给上游的插件说明.md) —— 十二节完整说明，含设计取舍
- [`plugins/thinking-space/README.md`](plugins/thinking-space/README.md) —— 插件级说明

---

## 十二、许可

AGPL-3.0-only。第三方声明见 `plugins/thinking-space/THIRD_PARTY_NOTICES.md`。

本仓库是实验性改动，**不是官方版本**。接口怎么定，以上游为准。
