# 画布（可选组件）

思维空间的画布页面。**不是插件**，不注册任何工具，是一个独立的小服务加一张单文件网页。

主说明见 [../README.md](../README.md)，这里只讲怎么把画布跑起来。

## 两份文件

```
index.html                 画布页面本身，单文件，样式和脚本都内联
whalelife-workbench.cjs    本地服务，默认监听 9281
```

## 跑起来

```
1  装好并启动 WhaleLife 宿主（画布靠它取插件列表、市场目录、工具目录）
2  把这两份文件放在任意目录（建议和插件分开，不要放进 plugins/）
3  打开宿主 → 插件页面 →「思维空间」→ 设置 → 画布服务
4  画布脚本路径   填 whalelife-workbench.cjs 的完整路径
5  点「启动画布」，等端口起来
6  浏览器打开 http://127.0.0.1:9281/
```

停止：同一个设置页点「停止」。宿主退出时画布会自己退（每 3 秒探一次宿主端口，连续两次连不上就退出）。

## 用命令行直接跑

```bash
node whalelife-workbench.cjs --port 9281 --upstream 9270
```

- `--port`：画布监听的端口，默认 9281
- `--upstream`：宿主端口，默认 9270

两个端口也可以走环境变量：`WORKBENCH_PORT` / `WORKBENCH_WHALE_PORT`。命令行参数优先，其次是环境变量，都没有才用默认值。两个端口不能相同。

设置环境变量 `WORKBENCH_WATCH_PARENT=0` 可以关掉"宿主退出就自己退"的看门狗；`WORKBENCH_WATCH_GRACE_MS` 改启动缓冲，默认 15000 毫秒。

## URL 参数

| 参数 | 作用 |
|---|---|
| `?flow=<流程id>` | 打开后居中到这条流程 |
| `?node=<节点id>` | 顺便选中某个节点（可以和 flow 一起用） |
| `?skill=<技能id>` | 从技能库取一条技能，注入成节点并选中 |

`?skill=` 需要宿主在跑，且插件里注册了 `GET /plugins/thinking-space/skill?id=` 这条路由。

## 依赖

- WhaleLife 宿主在跑
- 需要宿主的同源代理能到 `/plugins/thinking-space/*` 和 `/market/*`
- 启停走 `taskkill` / PowerShell，**只在 Windows 验过**；Linux 和 macOS 上按钮会失败，需要手动 `node whalelife-workbench.cjs`

## 状态

实验性。页面在浏览器里跑通过，但**不是每项功能都在真实环境逐条验证过**。和技能库的双向同步还没做——技能能转成节点看，画布上的改动不回写技能定义。

契约问题（端口声明、双向同步）见 [../docs/插件接入规范.md](../docs/插件接入规范.md)。
