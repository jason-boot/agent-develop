# Little Sunshine 打包与部署

本文说明如何将 Web 版部署到 Ubuntu + Nginx，并介绍桌面安装包的构建方式。项目采用 monorepo：`frontend/` 是静态前端，`backend/` 是 Node.js API 服务，`packages/shared/` 是共享类型。数据库、模型 API Key 和 MCP Token 均由后端管理。

## Web 版：Ubuntu + Nginx

### 环境要求

- Ubuntu Linux 服务器
- Node.js 22 或更高版本
- Nginx
- PM2（也可以用 systemd 管理后端）

### 构建

在仓库根目录执行：

```bash
npm ci
npm run build
```

构建产物：

- `frontend/out/`：静态前端文件。
- `backend/.next/standalone/`：独立后端和运行所需文件。部署时复制整个目录，保留其中的 `backend/` 和 `node_modules/` 结构。

### 放置部署文件

以下用 `/opt/little-sunshine` 作为部署目录。将 `frontend/out/` 的**内容**复制到 `frontend/`，将 `backend/.next/standalone/` 的**全部内容**复制到 `backend-standalone/`：

```text
/opt/little-sunshine/
├── frontend/
│   ├── index.html
│   └── _next/
├── backend-standalone/
│   ├── backend/
│   │   ├── server.js
│   │   └── .next/
│   └── node_modules/
└── ecosystem.config.cjs
```

构建和运行环境应使用兼容的 Node.js 版本。后端入口为 `backend-standalone/backend/server.js`。

### 配置后端数据目录

为应用数据创建独立的持久化目录。首次部署时可复制模板；已有 `database.json` 时不要覆盖：

```bash
sudo install -d -o ubuntu -g ubuntu -m 750 /var/lib/little-sunshine
sudo -u ubuntu cp database.example.json /var/lib/little-sunshine/database.json
chmod 600 /var/lib/little-sunshine/database.json
```

编辑 `/var/lib/little-sunshine/database.json`。默认 `provider` 为 `sqlite`，SQLite 文件 `conversations.sqlite` 也会保存在该目录。选择 MySQL 时，先创建数据库并配置连接信息。应用重启后才会加载数据库配置变更。

如服务器上没有仓库目录，可先把仓库根目录的 `database.example.json` 复制到服务器临时位置，再执行上述复制命令。

### 配置账号注册与第三方登录

用户使用应用用户名和密码注册，数据库中的 `users.id` 是唯一用户 ID。GitHub、Gitee 等第三方账号通过 `user_identities` 绑定到该用户，不会单独创建应用用户。第三方账号首次登录若尚未绑定，会提示先注册或登录，再从左下角账户菜单完成绑定。

分别在 GitHub 的 **Settings → Developer settings → OAuth Apps**、Gitee 的第三方应用设置，以及 Google Cloud 的 OAuth 客户端设置中创建 OAuth 应用。Homepage URL 填写站点地址；Google 客户端类型选择 **Web application**。授权回调地址按需填写：

```text
https://你的域名/api/auth/oauth/github/callback
https://你的域名/api/auth/oauth/gitee/callback
https://你的域名/api/auth/oauth/google/callback
```

将仓库中的 `backend/auth.example.json` 复制到后端数据目录并命名为 `auth.json`：

```bash
sudo -u ubuntu cp backend/auth.example.json /var/lib/little-sunshine/auth.json
sudo -u ubuntu chmod 600 /var/lib/little-sunshine/auth.json
```

`auth.json` 使用 `providers` 配置第三方平台。仓库模板包含 GitHub、Gitee 和 Google 示例；未填写凭据的平台不会显示登录或绑定入口。Gitee 配置使用 `https://gitee.com/oauth/authorize`、`https://gitee.com/oauth/token` 和 `https://gitee.com/api/v5/user`，权限范围为 `user_info`。Google 配置使用 OpenID Connect UserInfo（`sub` 作为第三方用户 ID），权限范围为 `openid profile email`。按平台填写 `clientId`、`clientSecret`，并将回调地址中的域名替换成实际站点域名；Google Cloud 中配置的授权重定向 URI 必须与 `auth.json` 的 `callbackUrl` 完全相同。参考 [Gitee OAuth 文档](https://gitee.com/api/v5/oauth_doc) 和 [Google OAuth Web 应用文档](https://developers.google.com/identity/protocols/oauth2/web-server)。

本机开发时，将 `appBaseUrl` 和对应 provider 的 `callbackUrl` 改为 `http://localhost:3000` 下的地址。后端依次从 `USAGE_AGENT_CONFIG_DIR/auth.json`、当前工作目录下的 `.agent-data/auth.json`、当前工作目录的 `auth.json`、当前工作目录下的 `backend/auth.json` 读取配置；也可通过 `JWT_SECRET`、`APP_BASE_URL` 环境变量覆盖相应配置。JWT 签名密钥首次启动时生成并保存在数据目录的 `jwt-secret.key`，请在备份中保留该文件。

配置后执行 `pm2 restart little-sunshine-api --update-env`。真实的 `auth.json` 不要提交到 Git；仓库已忽略 `.agent-data/` 目录。

登录有效期为 7 天，使用 HttpOnly JWT Cookie。每个请求都会校验用户存在、启用状态和 token 版本；暂不保存独立 session 记录。HTTPS 部署时 Cookie 会自动设置 Secure 属性。注册用户名为 3–32 个字母、数字、中文、下划线或连字符，密码为 8–128 个字符。

### 用 PM2 启动后端

以 `ubuntu` 用户在 `/opt/little-sunshine/` 下创建 `ecosystem.config.cjs`：

```js
module.exports = {
  apps: [{
    name: "little-sunshine-api",
    cwd: "/opt/little-sunshine/backend-standalone/backend",
    script: "server.js",
    env: {
      NODE_ENV: "production",
      HOSTNAME: "127.0.0.1",
      PORT: "3001",
      USAGE_AGENT_CONFIG_DIR: "/var/lib/little-sunshine"
    }
  }]
};
```

安装 PM2 并启动服务：

```bash
sudo npm install -g pm2
cd /opt/little-sunshine
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

`pm2 startup` 会输出一条需要用 `sudo` 执行的命令，按终端提示执行。常用命令：

```bash
pm2 status
pm2 logs little-sunshine-api
pm2 restart little-sunshine-api
```

确认后端健康检查可用：

```bash
curl http://127.0.0.1:3001/api/health
```

预期返回 `{"status":"ok"}`。

### 配置 Nginx

将 `your-domain.example` 替换为实际域名：

```nginx
server {
    listen 80;
    server_name your-domain.example;
    root /opt/little-sunshine/frontend;
    index index.html;
    client_max_body_size 25m;

    location /api/ {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_request_buffering off;
        proxy_read_timeout 3600s;
    }

    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

`proxy_buffering off` 用于让聊天流式响应及时送达浏览器；`client_max_body_size` 为带图片的聊天请求留出空间。保存配置后检查并重新加载 Nginx：

```bash
sudo nginx -t
sudo systemctl reload nginx
```

之后通过 `http://your-domain.example` 访问。生产环境建议为域名配置 HTTPS。

### 更新部署

重新构建并将新的 `frontend/out/` 和整个 `backend/.next/standalone/` 复制到部署目录。保留 `/var/lib/little-sunshine/` 中的数据库和密钥配置，然后重启后端：

```bash
pm2 restart little-sunshine-api
```

定期备份 `/var/lib/little-sunshine/`。不要把该目录或其中的密钥文件放进 Git 仓库。

## 桌面安装包

在目标操作系统上从仓库根目录执行：

```bash
npm ci
npm run desktop:build
```

安装包会生成在 `dist/`。Linux 构建 AppImage；Windows 安装程序和 macOS dmg 应分别在对应操作系统上构建。桌面版数据库配置会保存在操作系统的应用配置目录中，可从应用菜单“配置 → 打开配置目录”打开。

## 安全说明

Web API 除健康检查、注册/登录和第三方 OAuth 入口/回调外均要求有效的 JWT 登录 Cookie。请为公网域名启用 HTTPS，并只在后端配置 OAuth Client Secret。桌面安装版使用本机用户数据目录，不要求账号登录。
