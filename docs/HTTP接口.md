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
Content-Type: application/json

{"id": "技能id"}
```

表单方式也行：

```
id=技能id&p:参数名=参数值&confirmSideEffects=on
```

`p:xxx` 是传参数的形式。链里有副作用步骤时必须 `confirmSideEffects`。

返回 303 → `space?ran=<runId>`，或 `space?ran_err=<原因>`。

## 跑完去哪看

| 位置 | 内容 |
|---|---|
| `data/stats.json` | 每个技能的累计：runs / ok / failed / reasons / sources |
| `data/runs.json` | 逐次记录：at / skill / status / source，保留 90 天或 2000 条 |
| `space_trace { runId }` | 每一步的状态、耗时、实际参数、输出摘要——**只在内存留一小时**，重启后查不到 |

## 一个容易误判的现象

测试机上跑出 `status: "skipped"` 不一定是坏了。比如技能第一步是 `usage_today`，而这台机器从没跑过模型、没有用量数据，它返回空，后面依赖它的步骤就 `skipped`。

判断方法：看 `space_trace` 里哪一步先空，而不是看最终状态。
