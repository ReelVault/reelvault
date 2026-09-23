<#
.SYNOPSIS
    ReelVault installer for Windows.

.DESCRIPTION
    Downloads the release archive, installs it under your user profile,
    installs ffmpeg when missing, and creates a Start Menu shortcut.
    The web UI and API are served on one port (default 3030):
        http://localhost:3030

.EXAMPLE
    .\install.ps1                          # latest release, defaults
    .\install.ps1 -Remote                  # reachable from other devices on the LAN
    .\install.ps1 -Port 8080               # custom port
    .\install.ps1 -Autostart               # start ReelVault when you sign in
    .\install.ps1 -Upgrade                 # update an existing install (keeps data)
    .\install.ps1 -Full                    # archive with bundled ffmpeg/ffprobe
    .\install.ps1 -Uninstall               # remove files and shortcuts (-Purge deletes data)
#>
[CmdletBinding()]
param(
	[switch]$Remote,
	[int]$Port = 3030,
	[string]$Dir = "$env:LOCALAPPDATA\ReelVault",
	[string]$Version = "",
	[string]$File = "",
	[switch]$Autostart,
	[switch]$Upgrade,
	[switch]$Full,
	[switch]$NoShortcut,
	[switch]$Uninstall,
	[switch]$Purge
)

$ErrorActionPreference = "Stop"
$Repo = "ReelVault/ReelVault.Server"
$StartMenuDir = [Environment]::GetFolderPath("Programs")
$ShortcutPath = Join-Path $StartMenuDir "ReelVault.lnk"
$StartupShortcutPath = Join-Path $StartMenuDir "Programs\Startup\ReelVault.lnk"

function Write-Step($message) { Write-Host "==> $message" -ForegroundColor Cyan }
function Write-Warn2($message) { Write-Host "warning: $message" -ForegroundColor Yellow }

function Get-LatestTag {
	$release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -UseBasicParsing
	return $release.tag_name
}

function Stop-ReelVaultProcesses {
	$here = $Dir
	Get-Process bun -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$here*" } | ForEach-Object {
		Write-Step "Stopping running ReelVault (pid $($_.Id))…"
		Stop-Process -Id $_.Id -Force
	}
}

function Remove-Shortcuts {
	foreach ($path in @($ShortcutPath, $StartupShortcutPath)) {
		if (Test-Path $path) { Remove-Item $path -Force }
	}
}

function New-ReelVaultShortcut($targetPath) {
	$shell = New-Object -ComObject WScript.Shell
	$shortcut = $shell.CreateShortcut($ShortcutPath)
	$shortcut.TargetPath = $targetPath
	$shortcut.WorkingDirectory = $Dir
	$shortcut.Description = "ReelVault media server"
	$shortcut.Save()
}

if ($Uninstall) {
	Stop-ReelVaultProcesses
	Remove-Shortcuts
	if (Test-Path $Dir) {
		if ($Purge) {
			Write-Step "Removing $Dir (including data)…"
			Remove-Item $Dir -Recurse -Force
		} else {
			Write-Step "Removing application files from $Dir (data\ is kept)…"
			foreach ($name in @("bun", "server", "web", "bin", "start.bat", "settings.cmd", "README.txt")) {
				$path = Join-Path $Dir $name
				if (Test-Path $path) { Remove-Item $path -Recurse -Force }
			}
		}
	}
	Write-Host ""
	Write-Host "ReelVault uninstalled." -ForegroundColor Green
	exit 0
}

function Install-FfmpegStatic {
	# winget is unavailable — fetch a static build into .\bin, which start.bat
	# puts on the PATH.
	Write-Step "Downloading a static ffmpeg build…"
	$binDir = Join-Path $Dir "bin"
	$zip = Join-Path $env:TEMP "ffmpeg-release-essentials.zip"
	Invoke-WebRequest -Uri "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip" -OutFile $zip -UseBasicParsing
	$extract = Join-Path $env:TEMP ("ffmpeg-extract-" + [guid]::NewGuid().ToString("N"))
	Expand-Archive -Path $zip -DestinationPath $extract -Force
	New-Item -ItemType Directory -Force -Path $binDir | Out-Null
	Copy-Item (Join-Path $extract "ffmpeg-*-essentials_build\bin\ffmpeg.exe") $binDir -Force
	Copy-Item (Join-Path $extract "ffmpeg-*-essentials_build\bin\ffprobe.exe") $binDir -Force
	Remove-Item $extract -Recurse -Force
	Remove-Item $zip -Force
	Write-Host "    ffmpeg installed to $binDir."
}

$versionLabel = if ($Version -ne "") { $Version } else { "latest" }
Write-Step "Downloading ReelVault $versionLabel…"

if ($File -ne "") {
	if (-not (Test-Path $File)) { throw "archive not found: $File" }
	$archivePath = $File
} else {
	if ($Version -eq "") { $Version = Get-LatestTag }
	$suffix = if ($Full) { "-full" } else { "" }
	$asset = "ReelVault-$($Version.TrimStart('v'))-windows-x64$suffix.zip"
	$url = "https://github.com/$Repo/releases/download/$Version/$asset"
	$archivePath = Join-Path $env:TEMP $asset
	Write-Host "    $url"
	Invoke-WebRequest -Uri $url -OutFile $archivePath -UseBasicParsing
}

Write-Step "Installing to $Dir…"
$extractDir = Join-Path $env:TEMP ("reelvault-extract-" + [guid]::NewGuid().ToString("N"))
Expand-Archive -Path $archivePath -DestinationPath $extractDir -Force

if (-not (Test-Path $Dir)) { New-Item -ItemType Directory -Path $Dir | Out-Null }
Stop-ReelVaultProcesses
Copy-Item -Path (Join-Path $extractDir "ReelVault\*") -Destination $Dir -Recurse -Force
Remove-Item $extractDir -Recurse -Force
if ($File -eq "") { Remove-Item $archivePath -Force }

Write-Step "Setting up ffmpeg…"
if ($Full) {
	$bundled = @((Join-Path $Dir "bin\ffmpeg.exe"), (Join-Path $Dir "bin\ffprobe.exe"))
	if ($bundled | Where-Object { -not (Test-Path $_) }) {
		throw "the full archive did not contain bin\ffmpeg.exe and bin\ffprobe.exe"
	}
	Write-Host "    using the bundled ffmpeg/ffprobe."
} elseif (Get-Command ffmpeg -ErrorAction SilentlyContinue) {
	Write-Host "    ffmpeg already installed."
} elseif (Get-Command winget -ErrorAction SilentlyContinue) {
	winget install --id Gyan.FFmpeg -e --silent --accept-source-agreements --accept-package-agreements
	Write-Warn2 "If the server cannot find ffmpeg, sign out and back in (PATH refresh)."
} else {
	Install-FfmpegStatic
}

Write-Step "Writing settings (port $Port$(if ($Remote) { ", LAN access" })…"
$settings = "@echo off`r`n"
$settings += 'set "APP_PORT=' + $Port + '"' + "`r`n"
if ($Remote) { $settings += 'set "APP_HOST=0.0.0.0"' + "`r`n" }
Set-Content -Path (Join-Path $Dir "settings.cmd") -Value $settings -Encoding ASCII

if (-not $NoShortcut) {
	Write-Step "Creating Start Menu shortcut…"
	New-ReelVaultShortcut (Join-Path $Dir "start.bat")
	if ($Autostart) {
		Copy-Item $ShortcutPath $StartupShortcutPath -Force
	}
}

if ($Remote) {
	Write-Warn2 "Allow port $Port in Windows Firewall if other devices cannot connect:"
	Write-Host "    netsh advfirewall firewall add rule name=`"ReelVault`" dir=in action=allow protocol=TCP localport=$Port"
}

Write-Host ""
Write-Host "  ReelVault is installed." -ForegroundColor Green
Write-Host ""
Write-Host "    Address:  http://localhost:$Port"
Write-Host "    Data:     $Dir\data"
Write-Host "    Start:    Start Menu → ReelVault  (or $Dir\start.bat)"
Write-Host ""
Write-Host "  Open the address above and create the administrator account."
Write-Host ""
