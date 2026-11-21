# HTTP 接口调用

插件页面自己在用这些接口。外部脚本或 curl 调用时，注意下面几处容易踩的地方——都是实测踩出来的。

## 导入技能

```
POST /plugins/thinking-space/import
Content-Type: application/json

{"payload": "{\"skills\":[ ... ]}"}
```

**四条注意事项：**

1. **字段名是 `payload`，值是 JSON 字符串**，不是直接传 `{"skills":[...]}`。传错了会得到「没有数据可导入」。
2. **每条技能必须带 `schemaVersion: 1`**，少了会报「技能 ID 或 schemaVersion 无效」。
3. **步数约束**：`kind: "single"` 要求正好 1 步；`kind: "composite"` 要求 2–20 步。写 composite 却只给 1 步，会报「单步技能须有 1 步，复合技能须有 2–20 步」。
4. **必填参数要给全**。工具声明了必填项而步骤里没给，会报「n1 缺少工具必填参数」。

返回 303，跳到 `settings?imported=导入完成：新增 N 条，覆盖 M 条`；失败时 `settings?import_err=原因`。

## 运行技能

```
POST /plugins/thinking-space/run
Content-Type: application/x-www-form-urlencoded

id=技能id&p:参数名=参数值&confirmSideEffects=on
```

`p:xxx` 是传参数的形式。链里有副作用步骤时必须 `confirmSideEffects`。

**用 JSON 也一样，键名必须带 `p:` 前缀：**

```
{"id": "技能id", "p:query": "要搜的词"}
```

**注意：`{"id":"x","params":{"query":"y"}}` 这种写法参数会被丢掉**——处理逻辑只认以 `p:` 开头的键，`params` 对象整个不读。表现是运行返回 `blocked`，理由是「缺少必填参数 query」。

返回 303 → `space?ran=<runId>`，或 `space?ran_err=<原因>`。

## 改设置

```
POST /plugins/thinking-space/settings
Content-Type: application/x-www-form-urlencoded

allowUse=on&allowSave=on&maxSteps=20&...
```

**这是全量替换，不是局部更新。** 没提交的字段会被写成默认值：

- 所有勾选项（`allowUse` / `allowSave` / `autoOrganize` / `observeHands` / `allowRiskyChains` / `learnOnRequest`）没出现就是 `false`
- `maxSteps`、`organizeThreshold` 等没出现就用内置默认值

页面上的表单会带上所有控件的当前状态，所以正常点击保存没问题。但**用 JSON 只传一两个字段会静默清掉其余设置**——最坏的后果是把 `allowUse` 清成 false，之后任何技能运行都返回：

> blocked：设置里关掉了「允许使用整理好的技能」。

如果你确实想局部改，先 GET 设置页拿现状，改完再整份提交；或者直接改 `data/settings.json` 后热重载插件。

## 跑完去哪看

| 位置 | 内容 |
|---|---|
| `data/stats.json` | 每个技能的累计：runs / ok / failed / reasons / sources |
| `data/runs.json` | 逐次记录：at / skill / status / source，保留 90 天或 2000 条 |
| `data/failures.json` | 只记失败：at / skill / status / reason / error，最多 200 条 |
| `data/calls.json` | 工具调用记录与返回形状，自动整理和端口推断用它 |
| `space_trace { runId }` | 每一步的状态、耗时、实际参数、输出摘要——**只在内存留一小时**，重启后查不到 |

## 两个容易误判的现象

**一、`status: "skipped"` 不一定是坏了。** 比如技能第一步是 `usage_today`，而这台机器从没跑过模型、没有用量数据，它返回空，后面依赖它的步骤就 `skipped`。判断方法：看 `space_trace` 里哪一步先空，而不是看最终状态。

**二、`blocked` 且回执里没有步骤明细。** 这通常不是执行失败，是运行前就被拦下了——最常见就是上面说的 `allowUse` 关着。回执文字会直接说明原因，先看那句话。
