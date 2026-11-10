# Windows Browser Bridge EXE 打包步骤

本文说明如何在 Windows 上把本项目的本机 MCP 桥接程序打包成一个安装器 EXE。安装器使用 Inno Setup；安装器配置在项目根目录的 `BrowserBridge-Installer.iss`。

## 这个 EXE 包含什么

生成的 `BrowserBridge-Windows-Setup-v1.2.2.exe` 会包含本机 MCP 连接程序和安装脚本。用户运行后选择安装目录，安装器会解压文件、安装程序依赖，并创建开始菜单快捷方式（可选桌面快捷方式）。桥接依赖安装完成后，安装器会询问是否安装六个本地 MCP（MySQL、Playwright、Filesystem、Memory、Sequential Thinking、Everything）；输入 `yes` 后逐个检查并安装，已安装的包会提示并跳过。安装完成后运行 `Start-BrowserBridge.cmd`，输入项目地址和当前配对码；再到项目的本地工具页面配置需要在本机启动的 MCP 命令。

安装器构建不需要在 Windows 上运行整个网站，也不需要复制后端数据库。由于安装过程会执行 `npm install`，安装电脑需要预先安装 Node.js 20 或更新的 LTS 版本，并且安装时可以访问 npm registry。当前安装包不包含 Node.js，也不会把 npm 依赖预先编译进 EXE。

## 准备 Windows 构建目录

推荐在 Windows 电脑上从 Git 仓库检出与服务器相同的项目版本：

1. 安装 Git for Windows（如果尚未安装）。
2. 在 PowerShell 中克隆项目，或把项目复制到 Windows。只需要保留下面这些文件及其目录结构：
   - `BrowserBridge-Installer.iss`
   - `frontend/public/Install-BrowserBridge.ps1`
   - `frontend/public/browser-bridge.zip`
3. 确认 `frontend/public/browser-bridge.zip` 与 `Install-BrowserBridge.ps1` 来自同一版本。不要只更新其中一个文件。

也可以直接把上面三个文件从 Linux 项目复制到 Windows 的一个工作目录中，并按列出的路径放好。

## 安装打包工具

1. 从 Inno Setup 官方网站下载并安装 Inno Setup 6。
2. 构建这台电脑不需要安装 Node.js，因为 Inno Setup 只把文件封装进 EXE。Node.js 是运行安装器的目标电脑所需的前置条件。
3. 确认 Windows Defender 或其他安全软件允许运行 Inno Setup 编译器。

## 编译安装器

1. 在 Windows 文件资源管理器中打开项目根目录。
2. 双击 `BrowserBridge-Installer.iss`。如果文件没有关联 Inno Setup，可先打开 Inno Setup Compiler，再用 **File → Open** 选择该文件。
3. 在 Inno Setup Compiler 中按 **Compile**，或按 **Ctrl+F9**。
4. 等待编译结束。安装器会输出到项目根目录的 `dist/windows/BrowserBridge-Windows-Setup-v1.2.2.exe`。
5. 编译器底部显示 **Compile successful** 时，说明 EXE 已生成。

如果编译器提示找不到文件，先检查三个必需文件是否按上一节的相对路径放置，再重新编译。

## 在 Windows 上检查生成的 EXE

建议先在一台已安装 Node.js 20 LTS 或更新版本的 Windows 电脑上检查：

1. 双击 `dist/windows/BrowserBridge-Windows-Setup-v1.2.2.exe`。
2. 安装器启动时会先检查 npm。若没有检测到 npm，会提示安装 Node.js 20 LTS 或更高版本并退出。通过检查后，在安装向导中选择安装目录。依赖安装会在安装过程中自动运行，并显示 PowerShell 窗口及 npm 输出；不会等到最后再显示“运行 powershell.exe”的勾选项。安装过程会从 npm registry 获取桥接程序依赖，需要网络连接。
3. 安装结束后，从开始菜单运行 **Little Sunshine Browser Bridge**。按需在 Chrome 或 Edge 安装 Playwright Extension，并在本地工具页面配置对应的本机 MCP 命令。
4. 在项目的“内部工具”页面生成当前配对码；启动连接程序时输入项目地址和配对码。
5. 在浏览器扩展中选择要控制的已有标签页，然后确认项目页面显示已连接。
6. 关闭连接窗口后，再次运行开始菜单快捷方式，确认可以用新的配对码重新连接。安装本身无需重复执行。

如果安装依赖时出现 `npm` 找不到的错误，请在目标电脑安装 Node.js 20 LTS 或更新版本，然后重新运行 EXE。若 npm 安装失败，安装器会显示错误并中止；详细输出保存在 `%TEMP%\little-sunshine-browser-bridge-install.log` 中。

## 发布到项目页面供下载

编译成功后，把 `dist/windows/BrowserBridge-Windows-Setup-v1.2.2.exe` 复制到项目的 `frontend/public/` 目录。ZIP 安装包版本为 `1.2.2`，文件名为 `BrowserBridge-Windows-Installer-v1.2.2.zip`。桥接运行时版本由 `frontend/browser-bridge/package.json` 管理；桥接代码有改动时也要递增运行时版本，只有外层安装脚本变更时则只递增安装包版本。然后在 `frontend/src/app/page.tsx` 的“下载 Windows 安装器”链接中使用对应版本文件名。

```tsx
href="/BrowserBridge-Windows-Setup-v1.2.2.exe"
```

提交 EXE 和页面链接变更，并按项目现有方式重新构建、部署前端。确认部署后下载链接能取得 EXE，再让用户使用新版安装器。

## 当前安装器的边界

这个 EXE 将安装器脚本和浏览器连接程序封装在一起，但安装时仍从 npm registry 安装依赖，所以目标电脑需要 Node.js 20+ 和网络。若要让 EXE 完全离线安装并且不要求目标电脑安装 Node.js，需要进一步把 Node.js 运行时和所有 npm 依赖一起打包；这会明显增加安装包体积，需要单独调整构建方案。

