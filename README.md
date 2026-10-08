# Codex Monitor

一个**只读**的本地 Codex / Codex++ 会话监视器。在电脑上跑起来，用手机浏览器就能查看所有会话、实时进度和成果图。

## 特点

- **只读**：绝不写入 `~/.codex`。SQLite 以 `readOnly` 打开，不会和运行中的 Codex 抢锁、不会污染会话状态。
- **零依赖**：只用 Node 内置模块（`node:http` / `node:sqlite` / `node:crypto`），不需要 `npm install`。
- **不暴露公网**：默认只监听 `127.0.0.1` 和 Tailscale 地址，校园网里的其他设备扫不到。
- **实时**：基于 SSE 推送，Codex 往 rollout 文件写一行，手机 1 秒内就能看到。

## 环境要求

- Node.js **22.5+**（需要内置的 `node:sqlite`；本机实测 v24.12.0 正常）
- 电脑上装有 Codex / Codex++，即存在 `~/.codex` 目录
- 手机端建议装 [Tailscale](https://tailscale.com/download) 并登录同一账号

## 快速开始

```powershell
cd C:\Users\queenie\codex-monitor

# 设置访问密码（至少 6 位）
node server.mjs --set-password 你的密码

# 启动
node server.mjs
```

启动后会打印两个地址：

```
  本机       http://127.0.0.1:8787
  Tailscale  http://100.x.x.x:8787
```

首次不带 `--set-password` 启动时会自动生成一个随机密码并打印出来。

## 手机接入

1. 在手机（和电脑）上安装 Tailscale，两端登录**同一个账号**。
2. 确认电脑端 Tailscale 是已连接状态。
3. 手机浏览器打开启动日志里那个 `http://100.x.x.x:8787`。
4. 输入密码即可。

> 为什么不用校园网 IP：校园网是几千人共享的二层网络，把这个端口绑到 `0.0.0.0` 等于把一个能看到你**全部代码、对话记录和 API 密钥**的服务丢给整个校园网，一个密码是唯一的屏障。Tailscale 是加密点对点，不开放任何公网端口。

## 配置项

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `8787` | 监听端口 |
| `CODEX_HOME` | `~/.codex` | Codex 数据目录 |
| `CODEX_MONITOR_HOME` | `~/.codex-monitor` | 密码配置存放位置 |

密码以 `scrypt` 加盐哈希存储，不保存明文。

## 数据来源

工具完全基于 Codex 自己落盘的文件，不依赖任何私有接口：

| 用途 | 来源 |
|---|---|
| 会话列表 | `~/.codex/session_index.jsonl` |
| 对话内容 | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` |
| 进度状态 | `~/.codex/thread_history_1.sqlite` → `thread_turns.status` |
| 成果图 | `~/.codex/visualizations/YYYY/MM/DD/<thread_id>/` |

## 已知限制

- **只读**：不能从手机给 Codex 发指令。要做到这一点需要对接 `codex-plus-plus` 在 `127.0.0.1:57321` 的本地 API（需鉴权），复杂度更高。
- 超大会话默认只读取末尾 3MB、最多 400 条，界面会提示"已截断"。
- 会话记录里 `reasoning` 的 `encrypted_content` 无法解密，只显示模型给出的 `summary`（通常为空）。这是模型侧加密，不是工具的问题。
- 登录会话存在内存中，**重启服务后需要重新登录**。

## 安全说明

- 服务默认**只绑回环 + Tailscale**，不监听校园网 IP。
- 登录失败 5 次锁定该来源 IP 60 秒。
- 媒体接口做了路径穿越校验，只允许读取 `visualizations/` 和 `computer-use/` 下的文件。
- 密码通过 HttpOnly + SameSite=Strict Cookie 维护会话。

如果你确实要对外暴露（不推荐），请自行在前面加一层 HTTPS 反向代理，不要直接把明文 HTTP 挂到公网。
