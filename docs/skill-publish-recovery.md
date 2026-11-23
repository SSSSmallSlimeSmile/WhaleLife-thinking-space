# 技能发布：半路中断的恢复，与「重载没回音」的核对

基线：`30635e4`（思维空间 0.3.0 的发布流程）。本次提交 `244570a`，版本升到 **0.3.1**。
改动 5 个文件，+653 −60。

---

## 一、现象

**1. 写到一半退出，没人知道该退到哪一版**

发布要按顺序做四件事：备好暂存文件 → 备份旧目录和父清单 → 换掉正式目录、改父清单 → 登记发布记录。

顺序里有个空档：**旧目录已经删了、新文件还没写完，登记却还没落**。
这时候进程被杀（重启、崩溃、电源），重启后：

- 盘上只有一个空目录或半份文件；
- 备份目录在 `data/publish-backups/<stamp>/` 里躺着，但没有任何记录指向它——不知道这份备份是给哪个子插件的；
- 启动自愈只看登记表，登记表里没有这一条，于是什么都没发生，半份目录留在那儿，下次发布才撞车。

**2. 重载请求断线，前端分不清是「宿主拒了」还是「没收到回音」**

原来页面只有一句话：`await reloadParent(id)` 抛错就当失败，直接回退。
但真实情况下三种结果完全不同：

- 宿主明确拒绝（400/500）→ 确实没重载，该回退；
- 请求断了/超时，**宿主其实已经重载完了** → 这时候回退，等于把一版好的撤掉；
- 接口回成功但插件仍在重载中 → 立刻查版本会查到旧版本，误判成失败。

而且原来验收不比版本：工具在、探针回 `ok` 就算通过，**哪怕内存里跑的还是上一版**。

---

## 二、原因

- 恢复靠的是「登记表」，而登记写在整个替换流程的最后一步。**最需要它的时候，它还没写。**
- 清单回退是整份覆盖：用备份的 `plugin.yaml` 盖回去，会把**这期间别的发布**加进去的登记一起抹掉。
- 前端把「网络异常」当成了「操作失败」，没有中间态；面板也没有按 `publishId` 对账，旧页面可能去回退另一轮发布。
- 探针返回 `{status:"ok"}` 但没校验版本号。

---

## 三、改法

### 1. 作业记录先落盘（`publish.ts`）

新增 `data/publish-pending.json`（临时文件 + rename，写一半断电不留半份）：

```json
{ "schemaVersion": 1, "jobs": [ { "publishId", "subId", "skillId", "version",
  "first", "backup", "manifestBackup", "phase": "preparing|written", "at", "note" } ] }
```

写入时机：**备份做完之后、动正式目录之前**。写不进去就整个发布中止，旧版一个字节不动，返回「恢复记录写不进去，已停止发布（旧版没动）」。

阶段只有两个，对应「可能正在替换」和「已写完，等重载验收」。写完文件和清单后推进到 `written`，验收通过或回退成功后才销掉。

### 2. 启动恢复（`recoverPending()`，在 `healOnBoot()` 之前跑）

对每条未完成记录，先核对盘上的**实际**状态（入口里有没有工具名、版本号、父清单有没有登记）：

| 实际状态 | 处理 |
| --- | --- |
| `phase=preparing` 且没写完 | 回退：铺回旧目录、清单只撤/补自己那条，登记写 `rolled-back`/`withdrawn` 并保留原因 |
| `phase=preparing` 但其实已写完 | 推进到 `written`，保留待验收，不回退 |
| `phase=written` 且文件完整 | 保留，日志提示「上次发布还没验收」 |
| `phase=written` 但文件/清单对不上 | 回退 |
| 恢复本身抛错 | 记录留着，写 `note: 恢复失败：…`，下次启动再试 |

**可重复跑**：已经退干净的再跑一次，只是重新铺同样的文件、写同样内容，不会多删。只有恢复动作成功后才把记录销掉。

### 3. 回退只动自己那条（`restoreFrom`）

不再整份回拷 `plugin.yaml`，改成：

- 有备份（升版失败）→ `addToManifest`（确保这条登记在）；
- 首次发布失败 → `removeFromManifest`（撤掉这条）。

这样别的发布期间加进来的条目不受影响。

### 4. 探针验收比对版本（`probe`）

```ts
const ok = answered && (!want || got === want);
// 不通过时 reason 写明「探针返回 v0.1.0，目标 v0.1.1」
```

### 5. 前端：三种结果分开，断线先查状态（页面脚本）

- `reloadParent()` 返回 `ok` / `rejected`（HTTP 非 2xx、或 `{ok:false}`）/ `unreachable`（fetch 抛错）。
- 统一走 `settle(job, tries, wait)`：轮询 `/api/status`
  - 子插件 `enabled === false` → `disabled`（已写入，保持停用，**不重载不回退**）；
  - 版本 === 目标版本 → 调 `/verify`，通过即 `ok`；
  - 版本还是旧的 / 工具还没有 → 继续轮询；
  - 状态接口全连不上 → `unknown`。
- 分支：
  - `ok` → 完成；
  - `disabled` → 提示启用后再核对；
  - `unknown` → 显示「重载结果待确认」+「继续核对」按钮，**不自动回退**；
  - `stale`/`missing` → 回退 → 再重载 → 核对旧版。
- 发布前先探一次 `/api/status` 记下 `enabledBefore`；原本停用的直接跳过重载。
- 「继续核对」按 `publishId` 对账：待确认列表里已经没有这条（被别的轮次顶掉/已回退）就拒绝处理，不误伤。
- 页面新增待确认列表，记录 `stage=written` 时表格里多一个「核对」按钮。

`/status` 现在多返回 `pending`（未完成作业）和每条记录的 `publishId`。

### 6. 测试专用故障注入

```ts
if (process.env.WL_PUBLISH_FAULT === "exit-after-remove") process.exit(37);
```

位置在「旧目录已移走、新文件还没写」，只认环境变量，正常跑不触发。用来在隔离实例里模拟宿主半路被杀。

---

## 四、改动文件

| 文件 | 变动 |
| --- | --- |
| `publish.ts` | +390 −? 作业记录、启动恢复、清单回退收窄、版本比对、`publishId`、状态接口、页面脚本 |
| `plugin.yaml` | 0.3.0 → 0.3.1 |
| `test/publish.mjs` | 探针版本可调；新增作业记录存在/销掉两条断言；自愈阶段名改为 `withdrawn` |
| `test/pending.mjs` | 新增，26 条：作业记录先落盘、崩溃注入、重启恢复、可重复跑、写完不回退、清单只动自己、记录写失败则中止 |
| `test/shells-client.mjs` | 新增，17 条：从真实页面里抠出脚本在 vm 里跑，覆盖正常/断线/待确认/旧版回退/停用/过期继续核对 |

---

## 五、复现命令

```powershell
cd <插件仓库>
$tsc = "<宿主目录>/node_modules/typescript/bin/tsc"
node $tsc --noEmit -p .tmp\tscheck\tsconfig.check.json

node test\publish.mjs        # 38/38
node test\pending.mjs        # 26/26（含故障注入：子进程 exit 37）
node test\shells-client.mjs  # 17/17
node test\skill-shell.mjs    # 9/9
```

隔离实例真机（纯净版 9272，装 0.3.1 后）：

```powershell
node .tmp\accept-pending.mjs http://127.0.0.1:9272   # 21/21
```

---

## 六、验收结果

### 单测与类型

- `tsc --noEmit`：**0 error**（`publish.ts` 在 `include` 里，`--listFiles` 确认）
- `publish` 38/38、`pending` 26/26、`shells-client` 17/17、`skill-shell` 9/9

### 故障一：替换中途退出（隔离实例 + 故障注入）

```
发布 v0.1.0 → 改技能 → 带 WL_PUBLISH_FAULT=exit-after-remove 再发布
  子进程退出码 37
  旧目录已不在（index.ts 不存在）
  父清单与发布前逐字节相同
  publish-pending.json：1 条，phase=preparing，backup=20261122-…（指向旧版整目录）

重启（重新注册插件）
  旧目录回来了，版本 0.1.0，入口逐字节等于崩溃前
  父清单仍是原样
  作业记录已销掉
  登记表：stage=rolled-back，reason=「上次发布在替换中途中断，已回退」

再跑一次恢复
  文件没变、清单没变、没有新增作业  → 可重复跑
```

### 故障二：重载成功但浏览器没收到响应

vm 里跑真实页面脚本，`fetch("/api/plugin")` 抛 `Failed to fetch`：

```
reloadParent → {kind:"unreachable"}
settle → {state:"ok", detail:"探针返回 v0.2.0"}
重载请求次数 1，回退次数 0
```

即：断线不回退、不重复重载，先查状态、按版本结论。

真机对应一半（HTTP 层）：`/api/plugin reload` 返回后，`/api/status` 读到 `version=0.1.1`、`/verify` 通过。浏览器真的断网这一半没在真机模拟（见第八节）。

### 故障三：停用状态不变

```
stop 之后：enabled=false，status=stopped
同一内容再发布：reused=true，writes=0
再查：enabled 仍是 false        ← 没被发布改回来
页面：/shells 200，带 #resume 与「继续核对」
start 之后：status=active，/verify 通过   ← 实际运行验收留到启用后
```

### 恢复前后的版本与工具状态（重点）

| 时刻 | 目录版本 | 父清单 | 登记 | 工具 |
| --- | --- | --- | --- | --- |
| 替换前 | 0.1.0 | 有该 subId | verified | skill_accept_pending_demo |
| 崩溃瞬间 | 目录已删 | 有（未改） | 仍是上一版记录 | 内存里还有旧工具（进程未重启时） |
| 重启后 | 0.1.0（还原） | 有（原样） | rolled-back + 原因 | 旧工具可用（探针通过） |
| 再恢复一次 | 0.1.0（不变） | 不变 | 不变 | 不变 |

---

## 七、一处宿主竞态（不是本补丁的问题，没修）

验收时踩到：探针刚返回、立刻 `stop` 子插件，宿主日志出现

```
[ERROR] 插件失败 {"id":"thinking-space","error":{"message":"Cannot write headers after they are sent to the client"}}
```

父插件被带成 `failed`，紧接着的请求报「接口不存在」「请先启用父插件」。位置在 `core/plugin-process.ts:48`（转发插件 HTTP 响应时对已结束的 res 再写一次）。

我在验收脚本里把节奏放慢（探针之后等 800ms 再停用），此后 21/21 稳定通过。这是**宿主 core 的响应收尾竞态**，要修得动 `forwardPluginHttp`，不在本次补丁范围，也不该混进这个 PR。

---

## 八、未覆盖项

1. **真实浏览器断网**：故障二的前端分支是在 vm 里用抛错的 `fetch` 验的，没有真的拔网线/断代理。
2. **故障注入 ≠ 真崩溃**：`process.exit(37)` 走的是同一段代码之后的退出，但没有覆盖「正在写文件时断电」这种只写了一半的情况（写文件是 `writeFileSync` 小文件，原子性靠 rename 的只有登记和作业记录）。
3. **多实例并发发布同一条技能**：发布有进程内串行队列，跨进程没有锁；两个宿主同时发同一条会互相覆盖。未验。
4. **宿主重启时插件被停用**：`recoverPending` 只核对磁盘，不看 `config/plugins.json` 的停用位；停用状态下仍会回退文件（这是对的，但未在真机断言）。
5. **`phase=written` 的作业在进程重启后会一直留着**，直到有人点「核对」或回退；没有超时清理策略。
