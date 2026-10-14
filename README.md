# Little Sunshine

基于 Next.js 和 TypeScript 的聊天助手。项目按前后端分离的 monorepo 组织：`frontend/` 提供静态 Web 界面，`backend/` 提供 API 和数据服务，`packages/shared/` 保存前后端共用类型。数据库和模型密钥只由后端读取和管理。

## 本地开发

在仓库根目录安装依赖并启动前后端：

```bash
npm install
npm run dev
```

前端地址为 http://localhost:3000，后端 API 监听 3001。开发时前端将 `/api/*` 转发到后端。

## 构建与部署

```bash
npm run build
```

构建会生成：

- `frontend/out/`：由 Nginx 或其他静态文件服务器托管的前端文件。
- `backend/.next/standalone/`：Node.js API 后端及其运行依赖。

后端 standalone 服务入口为 `backend/.next/standalone/backend/server.js`。部署时设置持久化配置目录并启动后端，例如：

```bash
USAGE_AGENT_CONFIG_DIR=/var/lib/little-sunshine PORT=3001 HOSTNAME=127.0.0.1 node backend/.next/standalone/backend/server.js
```

Nginx 将站点根目录指向 `frontend/out`，并将 `/api/` 请求反向代理至 `http://127.0.0.1:3001`。例如：

```nginx
server {
    listen 80;
    server_name your-domain.example;
    root /home/ubuntu/app/agent-develop/frontend/out;
    index index.html;

    location /api/ {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

可用 systemd 或 PM2 管理后端进程。前端和 API 通过同一个站点域名通信，因此无需额外配置浏览器 CORS。

## 桌面客户端

开发时运行 `npm run desktop:dev`，打包运行 `npm run desktop:build`。桌面客户端在本机启动 API 后端，并通过本地静态文件服务展示前端。用户配置目录由操作系统决定：Windows 通常是 `%APPDATA%/Usage Copilot`，macOS 是 `~/Library/Application Support/Usage Copilot`，Linux 是 `~/.config/Usage Copilot`。

## 数据库配置

应用会话、模型配置和外部 MCP 配置由后端存储，支持 SQLite 或 MySQL。配置文件 `database.json` 放在 `USAGE_AGENT_CONFIG_DIR` 指定的目录；未设置时使用后端工作目录下的 `.agent-data/`。没有配置文件时默认使用 SQLite，数据库文件为 `conversations.sqlite`。可复制 `backend/database.example.json` 后编辑。选择 MySQL 时，服务会自动创建所需表；需提前创建数据库，并为账号授予建表、增删改查权限。修改配置后重启后端。

SQLite 和 MySQL 数据分别存储，切换 `provider` 不会自动复制现有数据。数据库表预留了 `user_id`，登录接入前固定为 `1`。

## 模型与 MCP

模型 API Key 和外部 MCP 配置保存在后端，不会返回到浏览器。聊天时后端把已授权的 MCP 工具清单提供给所选模型，模型可以自主调用只读查询工具，再根据结果回答。每轮最多 5 次模型回合、每次最多 4 个工具调用；项目分析模式使用单独的文件工具限制。

用量查询 MCP 是独立服务。请在应用的“外部 MCP”管理中填写服务地址和 Bearer Token；主应用只保留连接外部 MCP 的客户端代码，不保存用量数据库凭据或提供用量数据库查询 API。若模型服务不支持工具调用，用量问题无法自动查询。

应用配置的会话、模型与外部 MCP 表包含 `user_id`。登录功能接入前，当前用户 ID 固定为 `1`；已有 SQLite 数据升级时也会归属到用户 `1`。
