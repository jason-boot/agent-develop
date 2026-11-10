param(
  [string]$InstallDir,
  [switch]$NoPause
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
$logPath = Join-Path $env:TEMP 'little-sunshine-browser-bridge-install.log'
$transcriptStarted = $false
$locationPushed = $false
$installFailed = $false
try {
  Start-Transcript -Path $logPath -Append | Out-Null
  $transcriptStarted = $true
  if (-not $InstallDir) {
    $folderPicker = New-Object System.Windows.Forms.FolderBrowserDialog
    $folderPicker.Description = '选择 BrowserBridge 本机连接程序的安装目录'
    $folderPicker.ShowNewFolderButton = $true
    if ($folderPicker.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { throw '已取消安装。' }
    $InstallDir = $folderPicker.SelectedPath
  }

  if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw '没有找到 Node.js/npm。请先安装 Node.js 20 LTS 或更新版本，再重新运行安装器。' }

  $installDir = $InstallDir
  New-Item -ItemType Directory -Path $installDir -Force | Out-Null
  $archivePath = Join-Path $PSScriptRoot 'browser-bridge.zip'
  if (-not (Test-Path $archivePath)) { throw '安装包缺少 browser-bridge.zip，请重新下载完整安装包。' }
  Write-Host '正在解压本机浏览器连接程序…'
  Expand-Archive -Path $archivePath -DestinationPath $installDir -Force
  $startScript = @'
$ErrorActionPreference = 'Stop'
$appUrl = (Read-Host '请输入项目地址，例如 https://example.com').Trim().TrimEnd('/')
if ($appUrl -notmatch '^https?://') { throw '项目地址必须以 http:// 或 https:// 开头。' }
$pairingCode = (Read-Host '请输入项目“内部工具”页面当前显示的配对码').Trim()
if (-not $pairingCode) { throw '配对码不能为空。' }
Push-Location $PSScriptRoot
try {
  npm run local -- $appUrl $pairingCode
  if ($LASTEXITCODE -ne 0) { throw '浏览器连接程序已退出，请检查错误信息。' }
} finally { Pop-Location }
Read-Host '连接已结束。按回车关闭此窗口' | Out-Null
'@
  Set-Content -Path (Join-Path $installDir 'Start-BrowserBridge.ps1') -Value $startScript -Encoding UTF8
  $launcher = "@echo off`r`npowershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -NoExit -File `"%~dp0Start-BrowserBridge.ps1`"`r`n"
  Set-Content -Path (Join-Path $installDir 'Start-BrowserBridge.cmd') -Value $launcher -Encoding ASCII
  Push-Location $installDir
  $locationPushed = $true
  Write-Host '正在安装 BrowserBridge 依赖…'
  npm install
  $npmExitCode = $LASTEXITCODE
  if ($npmExitCode -ne 0) { throw "npm install 失败，退出代码：$npmExitCode。请查看安装日志。" }
  $installLocalTools = (Read-Host 'BrowserBridge 已安装。是否接着安装六个本地 MCP 工具？输入 yes 继续，其他输入跳过').Trim()
  if ($installLocalTools -ieq 'yes') {
    $localMcpPackages = @(
      @{ PackageName = '@futuretea/mysql-mcp-server'; PluginFolder = '@futuretea/mysql-mcp-server' },
      @{ PackageName = '@playwright/mcp'; PluginFolder = '@playwright/mcp' },
      @{ PackageName = '@modelcontextprotocol/server-filesystem'; PluginFolder = '@modelcontextprotocol/server-filesystem' },
      @{ PackageName = '@modelcontextprotocol/server-memory'; PluginFolder = '@modelcontextprotocol/server-memory' },
      @{ PackageName = '@modelcontextprotocol/server-sequential-thinking'; PluginFolder = '@modelcontextprotocol/server-sequential-thinking' },
      @{ PackageName = '@modelcontextprotocol/server-everything'; PluginFolder = '@modelcontextprotocol/server-everything' }
    )
    $pluginRoot = Join-Path $installDir 'plugins'
    $installFailures = @()
    foreach ($tool in $localMcpPackages) {
      $packageName = $tool.PackageName
      $packageDirectory = Join-Path $pluginRoot $tool.PluginFolder
      $candidateDirectories = @($packageDirectory, (Join-Path $pluginRoot $packageName), $pluginRoot)
      if (Test-Path $pluginRoot) {
        foreach ($entry in Get-ChildItem -LiteralPath $pluginRoot -Directory -ErrorAction SilentlyContinue) {
          if ($entry.Name -eq 'node_modules') { continue }
          $candidateDirectories += $entry.FullName
          if ($entry.Name.StartsWith('@')) {
            foreach ($scopedEntry in Get-ChildItem -LiteralPath $entry.FullName -Directory -ErrorAction SilentlyContinue) { $candidateDirectories += $scopedEntry.FullName }
          }
        }
      }
      $installedDirectory = ''
      foreach ($candidateDirectory in ($candidateDirectories | Select-Object -Unique)) {
        $candidatePackagePath = Join-Path $candidateDirectory 'node_modules'
        foreach ($packagePart in $packageName.Split('/')) { $candidatePackagePath = Join-Path $candidatePackagePath $packagePart }
        if (Test-Path (Join-Path $candidatePackagePath 'package.json')) { $installedDirectory = $candidateDirectory; break }
      }
      if ($installedDirectory) {
        if ($installedDirectory -ne $packageDirectory -and $installedDirectory -ne $pluginRoot) {
          Write-Host "已安装，跳过重新下载：$packageName（复制到安装来源目录）"
          if (-not (Test-Path $packageDirectory)) {
            New-Item -ItemType Directory -Path $packageDirectory -Force | Out-Null
            Get-ChildItem -LiteralPath $installedDirectory -Force | Copy-Item -Destination $packageDirectory -Recurse -Force
          }
        } elseif ($installedDirectory -eq $pluginRoot) {
          Write-Host "已安装，跳过：$packageName（位于 plugins 根目录）"
        } else {
          Write-Host "已安装，跳过：$packageName"
        }
        $targetPackagePath = Join-Path $packageDirectory 'node_modules'
        foreach ($packagePart in $packageName.Split('/')) { $targetPackagePath = Join-Path $targetPackagePath $packagePart }
        if ($packageDirectory -ne $pluginRoot -and (Test-Path (Join-Path $targetPackagePath 'package.json'))) {
          $rootManifest = Join-Path $packageDirectory 'package.json'
          if (-not (Test-Path $rootManifest)) {
            [System.IO.File]::WriteAllText($rootManifest, '{"name":"little-sunshine-local-mcp","version":"1.0.0","private":true}', [System.Text.UTF8Encoding]::new($false))
          }
          $pluginManifest = Join-Path $packageDirectory '.browserbridge-mcp.json'
          $pluginManifestJson = @{ packageName = $packageName } | ConvertTo-Json -Compress
          [System.IO.File]::WriteAllText($pluginManifest, $pluginManifestJson, [System.Text.UTF8Encoding]::new($false))
        }
        continue
      }
      New-Item -ItemType Directory -Path $packageDirectory -Force | Out-Null
      $rootManifest = Join-Path $packageDirectory 'package.json'
      if (-not (Test-Path $rootManifest)) {
        [System.IO.File]::WriteAllText($rootManifest, '{"name":"little-sunshine-local-mcp","version":"1.0.0","private":true}', [System.Text.UTF8Encoding]::new($false))
      }
      $npmArgs = @('install', '--prefix', $packageDirectory, '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org', "$packageName@latest")
      $displayArgs = $npmArgs | ForEach-Object { if ($_ -match '[\s"]') { '"' + $_.Replace('"', '\\"') + '"' } else { $_ } }
      Write-Host "[BrowserBridge] MCP 安装命令: npm $($displayArgs -join ' ')"
      & npm @npmArgs
      if ($LASTEXITCODE -ne 0) {
        Write-Host "安装失败：$packageName（退出代码 $LASTEXITCODE）" -ForegroundColor Red
        $installFailures += $packageName
        continue
      }
      $pluginManifest = Join-Path $packageDirectory '.browserbridge-mcp.json'
      $pluginManifestJson = @{ packageName = $packageName } | ConvertTo-Json -Compress
      [System.IO.File]::WriteAllText($pluginManifest, $pluginManifestJson, [System.Text.UTF8Encoding]::new($false))
      Write-Host "已安装：$packageName"
    }
    if ($installFailures.Count -gt 0) { Write-Host "以下工具未能安装：$($installFailures -join ', ')。可以稍后在本地工具卡片中重试。" -ForegroundColor Yellow }
  } else {
    Write-Host '已跳过本地 MCP 工具安装；之后可以在项目的本地工具页面逐个安装。'
  }
  Write-Host '桥接工具安装完成。现在打开连接窗口，请输入项目地址和配对码。以后也可以单独运行 Start-BrowserBridge.cmd 再次连接。'
} catch {
  $installFailed = $true
  $message = $_.Exception.Message
  Write-Host "`n安装失败：$message" -ForegroundColor Red
  Write-Host "详细日志：$logPath"
  [System.Windows.Forms.MessageBox]::Show("安装失败：$message`n`n详细日志：$logPath", 'BrowserBridge 安装器', [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Error) | Out-Null
} finally {
  if ($locationPushed) { Pop-Location -ErrorAction SilentlyContinue }
  if ($transcriptStarted) { Stop-Transcript | Out-Null }
  if (-not $NoPause -and $installFailed) { Read-Host '安装器已结束。按回车关闭此窗口' | Out-Null }
}
if ($installFailed) { exit 1 }
Start-Process -FilePath (Join-Path $installDir 'Start-BrowserBridge.cmd') -WorkingDirectory $installDir
