<#
  打包會議摘要助理，產生可上傳到 Chrome 線上應用程式商店的 zip。

  用法（在 D:\MA 資料夾）：
    # 使用者各自填 Groq 金鑰
    powershell -ExecutionPolicy Bypass -File build.ps1

    # 走組織代理伺服器（使用者什麼都不用填）
    powershell -ExecutionPolicy Bypass -File build.ps1 -ProxyUrl https://xxx.workers.dev -AccessCode 你的存取碼

    # 要開放「存到 Google 文件」時再加上
    -GoogleClientId 1234-xxxx.apps.googleusercontent.com

  產出：
    dist\meeting-assistant-<版本>.zip   上傳到商店用
    dist\unpacked\                        本機測試用（chrome://extensions → 載入未封裝項目）
#>
param(
  [string]$ProxyUrl = "",
  [string]$AccessCode = "",
  [string]$GoogleClientId = ""
)
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$utf8 = New-Object System.Text.UTF8Encoding($false)
$dist = Join-Path $root "dist"
$stage = Join-Path $dist "unpacked"

if ($ProxyUrl -and -not $AccessCode) { throw "使用 -ProxyUrl 時也要給 -AccessCode" }
if ($ProxyUrl -and $ProxyUrl -notmatch '^https://') { throw "-ProxyUrl 必須是 https:// 開頭" }

# 1. 複製擴充功能需要的檔案（說明文件、部署檔不打包）
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force $stage | Out-Null
$include = "manifest.json", "background.js", "config.json", "icons", "content", "lib", "offscreen", "options", "perm", "popup", "live", "ui", "welcome"
foreach ($i in $include) { Copy-Item (Join-Path $root $i) (Join-Path $stage $i) -Recurse }

# 2. 寫入部署設定
$cfg = [ordered]@{ proxyUrl = $ProxyUrl.TrimEnd('/'); accessCode = $AccessCode }
[IO.File]::WriteAllText((Join-Path $stage "config.json"), ($cfg | ConvertTo-Json), $utf8)

# 3. 調整 manifest：沒用到的權限拿掉，商店審查比較快
$m = Get-Content (Join-Path $root "manifest.json") -Raw -Encoding UTF8 | ConvertFrom-Json
if ($GoogleClientId) {
  $m.oauth2.client_id = $GoogleClientId
} else {
  $m.PSObject.Properties.Remove("oauth2")
  $m.permissions = @($m.permissions | Where-Object { $_ -ne "identity" })
  $m.host_permissions = @($m.host_permissions | Where-Object { $_ -notmatch "googleapis\.com|accounts\.google\.com" })
}
if ($ProxyUrl) {
  $origin = ([Uri]$ProxyUrl).GetLeftPart([UriPartial]::Authority) + "/*"
  $m.host_permissions = @($m.host_permissions | Where-Object { $_ -ne "https://api.groq.com/*" }) + $origin
}
[IO.File]::WriteAllText((Join-Path $stage "manifest.json"), ($m | ConvertTo-Json -Depth 10), $utf8)

# 4. 壓縮（自己寫 zip，確保路徑用 / ——商店不接受 \ 路徑）
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$zipPath = Join-Path $dist ("meeting-assistant-" + $m.version + ".zip")
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
$zip = [IO.Compression.ZipFile]::Open($zipPath, [IO.Compression.ZipArchiveMode]::Create)
try {
  Get-ChildItem $stage -Recurse -File | ForEach-Object {
    $rel = $_.FullName.Substring($stage.Length + 1).Replace('\', '/')
    [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $rel, [IO.Compression.CompressionLevel]::Optimal) | Out-Null
  }
} finally { $zip.Dispose() }

$mode = if ($ProxyUrl) { "組織代理（$ProxyUrl）" } else { "使用者自備 Groq 金鑰" }
Write-Host ""
Write-Host "完成！版本 $($m.version)，模式：$mode" -ForegroundColor Green
Write-Host "  上傳商店： $zipPath"
Write-Host "  本機測試： $stage"
