# 思维空间 · 技能库插件

WhaleLife 插件。把「一串工具调用」存成一条可复用的技能，之后一句 `space_run` 就能跑完整条链，不用让模型每一步都重新推理一遍。

技能定义存在服务端 `data/skills.json`，模型和页面读同一份。跑一次省下来的不是时间——是**中间每一步的上下文重传**。

---

## 一、它能做什么

| 工具 | 用途 |
|---|---|
| `space_skills()` | 列出技能：ID、名称、步数、权限、状态、跑过几次、上次成败、版本号；另外返回开关状态和自动整理线索 |
| `space_skill_save({ id, spec })` | 新建或覆盖同 ID 的技能，校验不过返回 `blocked` 和具体原因 |
| `space_draft({ name, tools })` | 给一串工具名，自动查归属插件、声明必填参数、连 `next` 链，生成草稿并预校验（不保存） |
| `space_run({ id, params, confirmSideEffects })` | 真跑一遍，返回逐步回执 |
| `space_trace({ runId, recent })` | 按 `runId` 取回一次运行的完整步骤（内存留一小时） |
| `space_organize({ force })` | 从最近的工具调用记录里找反复出现的工具链，整理成技能 |
| `space_ports({ tool })` | 从记录下来的返回值形状反推每个工具的输出端口和类型，供拼技能时查「上一步哪个字段能接下去」。是观测不是声明：`trusted` 只在同一形状出现过三次以上时为真 |

页面：

| 路由 | 内容 |
|---|---|
| `/plugins/thinking-space/` | 介绍、当前状态、设置、打开画布 |
| `/plugins/thinking-space/space` | 功能库 / 复合功能库列表，每条可「跑一次」「编辑步骤」 |
| `/plugins/thinking-space/edit?id=` | 改步骤：参数 JSON、上移 / 下移 / 删除、新增一步 |
| `/plugins/thinking-space/settings` | 同一个设置页（插件管理里点「设置」走这条） |
| `/plugins/thinking-space/export` | 导出全部技能为 JSON |

---

## 二、安装

```
plugins/thinking-space/
  index.ts
  plugin.yaml          depends: [web, tools, models]
  README.md
  LICENSE  LICENSE-ADDITIONAL  NOTICE.md  THIRD_PARTY_NOTICES.md
  data/settings.example.json
```

把整个目录放进 `plugins/`，重启。

**依赖**：`web`（注册页面和 POST 接口）、`tools`（调用其它插件的工具）。没有 `tools` 这个技能库跑不起来。

**可选依赖**：技能里引用的工具得真存在，否则保存时校验不过、状态显示「待核实」。第一个示例用到了 `surf_search` / `surf_read`，装 `surf` 才有。

### 导航入口

插件自己声明导航，**不用改宿主任何文件**：

```ts
ctx.web.page("/plugins/thinking-space/", handler, { title: "思维空间", navigation: true });
```

装好后侧栏「插件页面」组会出现「思维空间」；点进去是设置主页，技能列表从主页的「查看技能列表」进。

早期版本曾在 `core/ui/index.html` 和 `app.js` 里硬编码入口（`space-nav` / `thinkingSpaceTitle`），
现已全部撤掉，仓库里不再需要任何主干改动。
---

## 三、技能长什么样

```json
{
  "schemaVersion": 1,
  "name": "搜资料",
  "kind": "composite",
  "description": "搜索并读取首条可读网页",
  "params": [
    { "name": "query", "label": "关键词", "type": "string", "required": true,
      "aliases": ["关键词", "q"] }
  ],
  "steps": [
    { "id": "n1", "tool": "surf_search", "plugin": "surf",
      "params": { "query": "${query}", "limit": 3 }, "next": "n2" },
    { "id": "n2", "tool": "surf_read", "plugin": "surf",
      "params": { "url": { "$try": [
        "${n1.data.results[0].url}",
        "${n1.data.results[1].url}",
        "${n1.data.results[2].url}"
      ] } }, "next": null }
  ]
}
```

三条要记的规则：

**一、占位用 `${...}`，数组下标用方括号。** `${n1.data.results[0].url}` 对，`${n1.data.results.0.url}` 会被校验器拦下并指出是哪一步写错。

**二、参数名用工具 schema 的机器名，人看的名字放在 `label`。** `query` 是机器名，「关键词」是标签，`aliases` 收旧写法。同一个参数三套名字并存，是我自己踩过的坑——调用时写成工具的字段名，页面显示中文标签。

**三、`{"$try": [...]}` 是候选回落。** 按顺序试，第一个成功的采用；每个候选的成败都进回执。适合「第一条搜索结果读不了就换第二条」。

---

## 四、运行状态：五态

| 状态 | 含义 | 该怎么做 |
|---|---|---|
| `ok` | 正常 | — |
| `failed` | 这一步可重试 | 看 error 决定 |
| `uncertain` | 结果未知（单步超时） | **不要自动重试**，可能已经产生副作用 |
| `blocked` | 缺前置条件（技能不存在、缺必填参数、含未确认的副作用步骤） | 补条件再跑 |
| `skipped` | 这一步没成，但后面的步骤不依赖它，已继续 | 看整体回执 |

**全部步骤都叫 `skipped` 时，整体抬成 `failed`**——一步都没干成，报「跳过」会让人以为没事。

**单步超时**（默认 60 秒，可设 1–600）只是不再等，不中断底层调用。所以超时记的是 `uncertain`，不是 `failed`。

### 业务失败识别

插件工具的常见写法是返回 `{ ok: true }`，然后在正文里写「服务没起」「显存不够」。执行器会看输出里的文字：

```
强词（任意长度 ≤300 字）  没在跑 / 未启动 / 已停止 / 显存不够 / 低于阈值 / 请先启动 …
弱词（仅 ≤60 字短句）      失败 / 错误 / 无法 / 找不到 / 拒绝 / error / failed / denied
```

长正文不参与弱词判定——`surf_read` 读回来的几千字里出现「错误处理」不会误判。宁可漏判，也不错杀。

---

## 五、自动整理（「学会技能」）

开着时，插件监听 `tool/called` 事件，记录工具名和成败：

```
排除     space_*（自己）、hands_*（动手类，永远会被跳过）、transient 调用只记名字不记参数和结果
窗口     默认留最近 800 条
```

整理时：

```
按会话分组 → 按时间排序 → 间隔超过窗口（默认 120 分钟）就断开 → 切 2~5 步 n-gram
→ 出现次数 ≥ 阈值（默认 3）→ 技能库里还没有同样工具序列 → 存成 auto-<hash>，每次最多 3 条
```

三条去重规则（都是踩过坑补的）：

**一、周期折叠。** `a,b,a`、`a,b,a,b` 能由 `a,b` 重复拼出来的，丢掉长的那条。第一版没做，连做三轮同一组合就生成 2 步 / 3 步 / 4 步三个版本。

**二、错位周期。** 判定得检查所有偏移量，否则 `[surf, ledger, surf]` 和 `[ledger, surf]` 认不出是同一个循环。

**三、反向折叠。** 链里没有 `hands_` 这类顺序敏感工具时，`a→b` 和 `b→a` 等价，只留一条。`hands_write → hands_run` 和反过来不是一回事，不能折。

**含确认步骤的链默认不存**，除非设置里打开「允许整理含确认步骤的链」。打开了也只是存下来，跑的时候到那一步仍会停下来征求同意。

---

## 六、自动精简（跑熟了会变短）

跑通一次，就回头看这条链有没有哪一步白跑。

**删步骤**（四条全满足）：这一步跑成了 · 输出没被后面任何一步引用 · 不是最后一步 · 工具不需要确认。

有副作用的步骤永远不会被自动删。删到只剩 2 步就停手，所以 4 步的链是逐步变短的：

```
跑一次  4 → 3
再跑   3 → 2
```

**砍候选**：连续 3 次都是 `$try` 的第一条命中，就砍掉后面从没命中的候选，清掉计数不反复触发。

每次改写版本号 +1，回执里带 `trimmed: { from, to, dropped, revision, cut }`，页面显示「这条技能跑完自己缩短了」。

---

## 七、设置项

| 键 | 默认 | 说明 |
|---|---|---|
| `allowSave` | 开 | 关掉后 `space_skill_save` 和导入一律 `blocked` |
| `allowUse` | 开 | 允许在对话里使用已保存的技能。关掉后 `space_run` 一律 `blocked` |
| `autoOrganize` | 开 | 自动整理的总开关；关掉后 hints 不出现，但调用统计照记 |
| `spaceUrl` | `http://127.0.0.1:9281/` | 「打开思维空间」按钮指向的画布地址，只认 http/https，≤300 字 |
| `maxSteps` | 20 | 单条技能最多步数，1–20，只影响新保存 |
| `organizeThreshold` | 3 | 同一工具链出现几次才算一条 |
| `organizeWindowMinutes` | 120 | 两次调用隔多久算断开，5–1440 |
| `autoSaveOrganized` | 开 | 整理出的技能直接存；关掉就只在报告里列出来 |
| `allowRiskyChains` | 关 | 允许整理含确认步骤的链 |
| `learnOnRequest` | 开 | 让助手知道「用户说一句话时就该去整理」 |
| `triggerPhrase` | `XXX，你学会这个技能了吗？` | 那句话本身，`XXX` 换成人格名 |
| `stepTimeoutSeconds` | 60 | 单步超时，1–600 |
| `canvasScript` | 空 | 画布脚本的完整路径。**出厂为空**，不写死任何人的路径；留空时点「启动画布」会提示去设置页填 |
| `observeHands` | 关 | 是否记录 `hands_*` 类工具的返回值形状。开着也只记键名和类型（如 `{ok:b,result:s}`），不记路径、不记正文 |

**`learnOnRequest` 和 `triggerPhrase` 只是把状态带给模型，插件本身不监听对话。** 听不听那句话，是模型负责的事。

---

## 八、数据文件

```
data/skills.json          技能库（唯一真源）
data/settings.json        设置；出厂值见 data/settings.example.json
data/stats.json           每条技能的运行次数、失败原因分桶、候选命中统计
data/calls.json           最近的工具调用记录（自动整理 + 端口推断用，默认 800 条上限）
data/failures.json        最近的失败原因（最多 200 条，排查用）
data/param-defaults.json  可选：给没写默认值的必填参数补一份，只影响自动整理学出来的技能
```

都是纯 JSON，可以直接看、直接备份。除 `settings.example.json` 外，仓库里不带这些文件——克隆下来是干净的技能库，没有别人的调试记录。

---

## 九、已知限制与兼容性

**一、页面只能验 HTML，验不了排版。** 我没法看浏览器，只能确认接口返回的元素在不在。

**二、「管理」导航组要手改**（第二节那条）。

**三、自动整理学到的技能不一定能直接跑。** 它不知道该给参数填什么，只能声明为必填。这类技能当模板用，跑之前要补参数。

**四、调用记录从插件启动开始算。** 插件启动前的调用没有历史；想要旧数据得另读会话记录。

**五、`uncertain` 态只真撞过一次**，用超时造的。真工具卡死时的行为没验证过。

**六、单步超时不中断底层调用。** 只是不再等。

**七、`comfy_generate` 这类常驻 GPU 的工具，第二次出图可能因为显存没释放被自己的阈值拦住**，跟技能库无关。

**八、画布的启停只在 Windows 验证过。** 查端口、结束进程走的是 `taskkill` 和 PowerShell，Linux / macOS 上「启动画布 / 停止」会失败；技能库、执行器、页面、自动整理不依赖平台。

**九、宿主关闭时只收自己启起来的那一个。** 插件会记住亲手 spawn 出来的画布 PID，在 `whalelife/shutdown` 里同步 kill 掉，避免 detached 进程一直挂着占显存。你在外面手动起的画布不归它管，得自己停。

---

**十、宿主版本要求。** 本插件在 2026-11-20 前后的宿主版本上开发，用到了 `ctx.tools.catalog()` 的 `outputSchema`、`ctx.web.page` 的 `navigation` 选项、`ctx.models` 依赖。更老的宿主可能缺这些字段，表现为：端口推不出、导航不出现、模型选择为空。缺字段时插件降级而不是崩，但功能会少一块。

**十一、工具中文名是本机词典。** `TOOL_LABELS` 里那 50 条是开发机上装过的工具。别人装上后，自己插件里的工具会显示英文名（如 `my_tool`），功能不受影响，只是技能名、端口名读起来是英文。想中文化就往词典里加。

**十二、触发语里的名字要改。** 设置里 `triggerPhrase` 默认「XXX，学会这个技能了吗？」，XXX 是占位符，装上后改成你自己的人格名。

## 十三、许可

AGPL-3.0。上游附加条款原文与 NOTICE 在包内。

本插件不是 WhaleLife 官方项目。上游：[`iinukami/whalelife`](https://github.com/iinukami/whalelife)。
