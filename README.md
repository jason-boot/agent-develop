# LLM 使用记录助手

基于 Next.js 和 TypeScript 的聊天助手。用量查询通过外部 MCP 服务提供，主应用不直接连接用量数据库。聊天后端将已授权的 MCP 工具清单交给当前选择的模型，由模型判断是否调用工具及其参数。

## 启动

执行 `npm install`，再执行 `npm run dev`。
打开 http://localhost:3000，添加模型配置和需要使用的外部 MCP 服务。

## 桌面客户端

开发时执行 `npm run desktop:dev`，会同时启动 Next.js 和 Electron 窗口。打包执行 `npm run desktop:build`；当前 Linux 会生成 AppImage。Windows 的 NSIS 安装程序和 macOS 的 dmg 需要在对应操作系统上构建。

安装后的桌面客户端会在本机回环地址启动内置服务，关闭应用时一并退出。用户配置目录由操作系统决定：Windows 通常是 `%APPDATA%/Usage Copilot`，macOS 是 `~/Library/Application Support/Usage Copilot`，Linux 是 `~/.config/Usage Copilot`。

聊天输入框旁的模型下拉菜单可添加、编辑、删除自定义模型并测试连接。可选协议为 Chat（Chat Completions）、Messages（Anthropic Messages）和 Responses（OpenAI Responses）。API 地址旁的“输入完整地址”开关控制地址处理方式：开启时直接请求填写的 URL，关闭时将协议对应的路径追加到服务根地址。模型配置与 API Key 保存在所选应用数据库中，不会返回到浏览器。每轮聊天都会把 MCP 工具清单提供给选中模型；模型可直接回答普通问题，也可自主调用只读查询工具，再根据结果回答。

## 应用数据存储

应用本身的会话、模型配置和外部 MCP 配置支持 SQLite 或 MySQL。配置文件名为 `database.json`，放在应用配置目录：开发模式默认为项目 `.agent-data/`，桌面版为操作系统的 Usage Copilot 用户配置目录。没有该文件时默认使用 SQLite。开发模式可执行 `mkdir -p .agent-data && cp database.example.json .agent-data/database.json` 后编辑；桌面版从应用菜单打开配置目录时会自动放入模板。选择 MySQL 时，服务会自动创建所需表；需提前创建数据库，并为账号授予建表、增删改查权限。修改配置后重启服务。

```json
{
  "provider": "mysql",
  "mysql": {
    "host": "127.0.0.1",
    "port": 3306,
    "user": "little_sunshine",
    "password": "replace-me",
    "database": "little_sunshine",
    "ssl": false,
    "connectionLimit": 8
  }
}
```

SQLite 数据与 MySQL 数据分别存储，切换 `provider` 不会自动复制现有数据。数据库表预留了 `user_id`，登录接入前固定为 `1`。

## MCP 查询工具

用量查询 MCP 已拆分为独立服务，项目不再托管 MCP 服务端点。请在应用的“外部 MCP”管理中添加独立服务地址（例如 `https://your-host/mcp`）及 Bearer Token；聊天时应用会通过 MCP 客户端调用已启用的外部工具。工具授权和只读限制在外部 MCP 管理中配置。

聊天请求将 MCP 工具定义转换为所选协议支持的工具调用格式，并以流式方式接收模型文本及工具调用参数。后端通过 MCP 客户端执行模型选择的工具，再把结果放回对话交给模型生成最终回答；每轮最多 5 次模型回合、每次最多 4 个工具调用。

## 当前支持的问法

- 今天、昨天、本月、近七天的总请求、Token、费用和平均延迟
- 各模型使用量与费用汇总
- 费用最高的模型
- 失败请求、超时请求列表

`src/lib/usage-mcp.ts` 仅保留连接外部 MCP 的客户端代码。用量 MCP 的数据库连接由独立服务的 JSON 配置管理，主应用不保存用量数据库凭据或提供数据库查询 API。若配置的模型服务不支持工具调用，用量问题无法自动查询。

应用的会话、模型配置和外部 MCP 配置表包含 `user_id`。登录功能接入前，当前用户 ID 固定为 `1`；已有 SQLite 数据升级时也会归属到用户 `1`。
