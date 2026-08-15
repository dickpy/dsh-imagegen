<#
.SYNOPSIS
    DSH 插件一键备份 / 恢复同步脚本（Export → 拷到新设备 → Import）

.DESCRIPTION
    DSH 的插件由以下几部分组成，本脚本负责把它们整体打包 / 还原：

    1. profiles/<name>/package.json          —— 插件依赖 + dsh.profile.bundles（权威清单）
    2. profiles/<name>/{cordis.yml,cordis.patch.yml,pnpm-workspace.yaml,.npmrc,pnpm-lock.yaml}
    3. ~/.dsh/cordis.patch.yml               —— 用户层补丁（皮肤开关等）
    4. ~/.dsh/marketplace/installed.json     —— 插件市场安装记录（+ list-cache 注册表缓存）
    5. ~/.dsh/skills/                        —— 已安装的 skills（如 modlens）
    6. ~/.dsh/.agent-presets/                —— 已安装的 agent 预设（如梁神模式）
    7. ~/.dsh/settings.yaml                  —— 插件设置（含 API 密钥，默认导出，可 -NoSettings 排除）
    8. link: 本地插件源码                    —— 打包进 vendor/，导入时重写链接路径
    9. node_modules 中非 pnpm 管理的插件     —— 打包进 vendor/extras/（如 dsh-plugin-marketplace）
   10. （可选 -IncludePluginData）插件数据     —— dsh-ssh.json、dsh-imagegen/ 生成的图片等

    导入后会自动执行 pnpm install 重建 node_modules（原生二进制由目标机本地编译），
    并把手工放置的插件 extras 拷回 node_modules。

.EXAMPLE
    # 在本机（源设备）执行：生成 dsh-plugin-backup-<时间>.zip
    .\dsh-plugin-sync.ps1 -Export

    # 指定输出文件
    .\dsh-plugin-sync.ps1 -Export -Out D:\backup\dsh-plugins.zip

    # 在目标设备执行：还原并安装
    .\dsh-plugin-sync.ps1 -Import -Zip D:\backup\dsh-plugins.zip

    # 目标机已装好依赖，只还原文件不重装
    .\dsh-plugin-sync.ps1 -Import -Zip D:\backup\dsh-plugins.zip -SkipInstall

    # 不导出 settings.yaml（内含 API 密钥）
    .\dsh-plugin-sync.ps1 -Export -NoSettings

    # 连同插件数据（SSH 主机配置、生图历史）一起导出
    .\dsh-plugin-sync.ps1 -Export -IncludePluginData

.NOTES
    目标设备前置条件：Node.js + 全局安装 DSH（npm i -g @deepseek-ai/dsh）+ pnpm
    （若缺 pnpm：npm i -g pnpm 或 corepack enable pnpm）。
    导入前请先退出目标机上的 dsh 进程。settings.yaml / dsh-ssh.json 含敏感信息，
    请通过可信渠道传输压缩包。
#>
[CmdletBinding(DefaultParameterSetName = 'Export')]
param(
    [Parameter(ParameterSetName = 'Export')]
    [switch]$Export,

    [Parameter(ParameterSetName = 'Import', Mandatory = $true)]
    [switch]$Import,

    [Parameter(ParameterSetName = 'Export')]
    [string]$Out = '',

    [Parameter(ParameterSetName = 'Import', Mandatory = $true)]
    [string]$Zip = '',

    [Parameter(ParameterSetName = 'Import')]
    [string]$DshHome = '',

    # 不导出 settings.yaml（含 API 密钥）
    [switch]$NoSettings,

    # 连同插件数据一起导出（dsh-ssh.json、dsh-imagegen/ 等）
    [switch]$IncludePluginData,

    # 导入时跳过确认（覆盖已存在的清单）
    [switch]$Force,

    # 导入时跳过 pnpm install / dsh plugin install
    [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'

function Write-Step { param([string]$Msg) Write-Host "[*] $Msg" -ForegroundColor Cyan }
function Write-Ok   { param([string]$Msg) Write-Host "[+] $Msg" -ForegroundColor Green }
function Write-Warn { param([string]$Msg) Write-Host "[!] $Msg" -ForegroundColor Yellow }
function Write-Fail { param([string]$Msg) Write-Host "[-] $Msg" -ForegroundColor Red }

function Get-DshHome {
    if ($DshHome) { return $DshHome }
    if ($env:DSH_HOME) { return $env:DSH_HOME }
    return (Join-Path $env:USERPROFILE '.dsh')
}

function Copy-Tree {
    param([string]$Src, [string]$Dst, [string[]]$ExcludeDirs = @(), [string[]]$ExcludeFiles = @())
    if (!(Test-Path -LiteralPath $Src)) { return }
    New-Item -ItemType Directory -Force -Path $Dst | Out-Null
    Get-ChildItem -LiteralPath $Src -Force | ForEach-Object {
        if ($_.PSIsContainer) {
            $skip = $false
            foreach ($e in $ExcludeDirs) { if ($_.Name -like $e) { $skip = $true; break } }
            if (!$skip) {
                Copy-Tree -Src $_.FullName -Dst (Join-Path $Dst $_.Name) -ExcludeDirs $ExcludeDirs -ExcludeFiles $ExcludeFiles
            }
        } else {
            $skip = $false
            foreach ($e in $ExcludeFiles) { if ($_.Name -like $e) { $skip = $true; break } }
            if (!$skip) {
                Copy-Item -LiteralPath $_.FullName -Destination $Dst -Force
            }
        }
    }
}

function Get-ProfileDirs {
    param([string]$DshHome)
    $profiles = Join-Path $DshHome 'profiles'
    if (!(Test-Path $profiles)) { return @() }
    return @(Get-ChildItem $profiles -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'package.json') } | Select-Object -ExpandProperty FullName)
}

# 找出 node_modules 中"非 pnpm 管理"的手工插件：
# 顶层（含 scope 内）带有 dsh 清单字段、不在 package.json dependencies、
# 且不在 pnpm-lock.yaml packages: 中的包 —— 如 dsh-plugin-marketplace。
function Get-ManualExtras {
    param([string]$ProfileDir)
    $nm = Join-Path $ProfileDir 'node_modules'
    if (!(Test-Path $nm)) { return @() }
    $pkg = Get-Content (Join-Path $ProfileDir 'package.json') -Raw | ConvertFrom-Json
    $managed = @($pkg.dependencies.PSObject.Properties.Name)
    $lockText = ''
    $lock = Join-Path $ProfileDir 'pnpm-lock.yaml'
    if (Test-Path $lock) { $lockText = Get-Content $lock -Raw }
    $candidates = @()
    foreach ($t in @(Get-ChildItem $nm -Directory -Force)) {
        if ($t.Name -in @('.bin', '.pnpm', '.pnpm-store')) { continue }
        if ($t.Name -like '@*') { $candidates += @(Get-ChildItem $t.FullName -Directory -Force -ErrorAction SilentlyContinue) }
        else { $candidates += $t }
    }
    $result = @()
    foreach ($c in $candidates) {
        $pj = Join-Path $c.FullName 'package.json'
        if (!(Test-Path $pj)) { continue }
        try { $j = Get-Content $pj -Raw | ConvertFrom-Json } catch { continue }
        $n = [string]$j.name
        if ([string]::IsNullOrEmpty($n) -or $null -eq $j.dsh) { continue }
        if ($n -like '@deepseek-ai/*') { continue }              # harness 自带，不打包
        if ($managed -contains $n) { continue }                  # pnpm 管理，install 可还原
        $esc = [regex]::Escape($n)
        $dq = '"' + $esc + '@'
        if ($lockText -match ("'" + $esc + '@') -or $lockText -match $dq) { continue }  # 传递依赖，install 可还原
        $result += $c
    }
    return $result
}

function Export-Main {
    $dshHome = Get-DshHome
    $profiles = Get-ProfileDirs $dshHome
    if ($profiles.Count -eq 0) { Write-Fail "在 $dshHome\profiles 下没有找到任何 profile（没有 package.json）。"; exit 1 }
    Write-Ok "DSH 主目录: $dshHome"
    Write-Ok "找到 profile: $(($profiles | ForEach-Object { Split-Path $_ -Leaf }) -join ', ')"

    if (!$NoSettings -and (Test-Path (Join-Path $dshHome 'settings.yaml'))) {
        Write-Warn 'settings.yaml 将被打包 —— 其中可能包含 API 密钥（dsh-imagegen / describe-image 等）。如不想导出，请加 -NoSettings。'
    }
    if ($IncludePluginData) {
        Write-Warn '-IncludePluginData 将导出 dsh-ssh.json（含 SSH 主机配置，可能含明文密码）与 dsh-imagegen/ 图片等数据。'
    }

    $stage = Join-Path $PSScriptRoot ('.sync-stage-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force -Path $stage | Out-Null
    try {
        # --- 每类文件逐项复制到 staging ---
        $manifest = @{ schema = 1; exportedAt = (Get-Date).ToString('s'); dshHome = $dshHome; profiles = @(); vendorLinks = @(); extras = @(); settingsIncluded = $false; pluginDataIncluded = $false }

        foreach ($pd in $profiles) {
            $name = Split-Path $pd -Leaf
            $manifest.profiles += $name
            $dst = Join-Path $stage ("profiles/$name")
            New-Item -ItemType Directory -Force -Path $dst | Out-Null
            foreach ($f in @('package.json', 'cordis.yml', 'cordis.patch.yml', 'pnpm-workspace.yaml', '.npmrc', 'pnpm-lock.yaml')) {
                $src = Join-Path $pd $f
                if (Test-Path $src) { Copy-Item $src -Destination $dst -Force }
            }
            Write-Ok "已收集清单: profiles/$name"

            # --- link: 本地插件源码 ---
            $pkg = Get-Content (Join-Path $pd 'package.json') -Raw | ConvertFrom-Json
            foreach ($prop in @($pkg.dependencies.PSObject.Properties)) {
                if ($prop.Value -is [string] -and $prop.Value -like 'link:*') {
                    $srcPath = $prop.Value.Substring(5)
                    if (![System.IO.Path]::IsPathRooted($srcPath)) { $srcPath = Join-Path $pd $srcPath }
                    if (Test-Path $srcPath) {
                        $rel = 'vendor/' + ($prop.Name -replace '[@\\/:]', '_')
                        Copy-Tree -Src $srcPath -Dst (Join-Path $stage $rel) -ExcludeDirs @('node_modules', '.git', '.pnpm-store', '.sync-stage-*') -ExcludeFiles @('*.tgz', 'dsh-plugin-backup-*.zip')
                        $manifest.vendorLinks += @{ dep = $prop.Name; rel = $rel }
                        Write-Ok "已打包本地插件源码: $($prop.Name) -> $rel (来自 $srcPath)"
                    } else {
                        Write-Warn "link: 依赖 $($prop.Name) 指向的 $srcPath 不存在，已跳过。"
                    }
                }
            }

            # --- node_modules 中手工放置的插件 ---
            foreach ($extra in @(Get-ManualExtras $pd)) {
                $rel = 'vendor/extras/' + (Split-Path $extra.FullName -Leaf)
                Copy-Tree -Src $extra.FullName -Dst (Join-Path $stage $rel) -ExcludeDirs @('node_modules', '.git', '.sync-stage-*')
                $manifest.extras += (Split-Path $extra.FullName -Leaf)
                Write-Ok "已打包手工插件: $rel"
            }
        }

        # --- 用户层 patch ---
        if (Test-Path (Join-Path $dshHome 'cordis.patch.yml')) {
            Copy-Item (Join-Path $dshHome 'cordis.patch.yml') -Destination (Join-Path $stage 'home-cordis.patch.yml') -Force
            Write-Ok '已收集 ~/.dsh/cordis.patch.yml'
        }

        # --- marketplace 记录与注册表缓存 ---
        $mk = Join-Path $stage 'marketplace'
        New-Item -ItemType Directory -Force -Path $mk | Out-Null
        if (Test-Path (Join-Path $dshHome 'marketplace\installed.json')) {
            Copy-Item (Join-Path $dshHome 'marketplace\installed.json') -Destination (Join-Path $mk 'installed.json') -Force
        }
        $lc = Join-Path $dshHome 'marketplace\list-cache'
        if (Test-Path $lc) { Copy-Item $lc -Destination (Join-Path $mk 'list-cache') -Recurse -Force }
        if ((Test-Path (Join-Path $mk 'installed.json')) -or (Test-Path (Join-Path $mk 'list-cache'))) { Write-Ok '已收集 marketplace 记录' }

        # --- skills ---
        $sk = Join-Path $dshHome 'skills'
        if (Test-Path $sk) { Copy-Item $sk -Destination (Join-Path $stage 'skills') -Recurse -Force; Write-Ok "已收集 skills: $(@(Get-ChildItem $sk -Directory).Count) 个" }

        # --- agent presets ---
        $ap = Join-Path $dshHome '.agent-presets'
        if (Test-Path $ap) { Copy-Item $ap -Destination (Join-Path $stage '.agent-presets') -Recurse -Force; Write-Ok "已收集 agent-presets: $(@(Get-ChildItem $ap -Directory).Count) 个" }

        # --- settings ---
        if (!$NoSettings -and (Test-Path (Join-Path $dshHome 'settings.yaml'))) {
            Copy-Item (Join-Path $dshHome 'settings.yaml') -Destination (Join-Path $stage 'settings.yaml') -Force
            $manifest.settingsIncluded = $true
            Write-Ok '已收集 settings.yaml（含密钥，请注意保管压缩包）'
        }

        # --- 可选插件数据 ---
        if ($IncludePluginData) {
            foreach ($d in @('dsh-ssh.json', 'dsh-imagegen')) {
                $src = Join-Path $dshHome $d
                if (Test-Path $src) {
                    Copy-Item $src -Destination (Join-Path $stage $d) -Recurse -Force
                    $manifest.pluginDataIncluded = $true
                    Write-Ok "已收集插件数据: $d"
                }
            }
        }

        $manifest | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $stage 'manifest.json') -Encoding UTF8

        # --- 打包 ---
        $zip = if ($Out) { $Out } else { Join-Path $PSScriptRoot ("dsh-plugin-backup-$(Get-Date -Format 'yyyyMMdd-HHmmss').zip") }
        $zipFull = [System.IO.Path]::GetFullPath($zip)
        $parent = Split-Path $zipFull -Parent
        if ($parent -and !(Test-Path $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
        if (Test-Path $zipFull) { Remove-Item $zipFull -Force }
        $stageItems = @(Get-ChildItem $stage -Force | Select-Object -ExpandProperty FullName)
        Compress-Archive -Path $stageItems -DestinationPath $zipFull -CompressionLevel Optimal
        $mb = [math]::Round((Get-Item $zipFull).Length / 1MB, 2)
        Write-Ok "导出完成: $zipFull ($mb MB)"
        Write-Ok '下一步：把该 zip 传到目标设备，执行  .\dsh-plugin-sync.ps1 -Import -Zip <文件>'
    } finally {
        Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Import-Main {
    if (!(Test-Path $Zip)) { Write-Fail "找不到压缩包: $Zip"; exit 1 }
    $newHome = Get-DshHome
    $expand = Join-Path $env:TEMP ('.dsh-sync-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force -Path $expand | Out-Null
    try {
        Expand-Archive -Path $Zip -DestinationPath $expand -Force
        $mfPath = Join-Path $expand 'manifest.json'
        if (!(Test-Path $mfPath)) { Write-Fail '压缩包内没有 manifest.json，不是本脚本导出的备份。'; exit 1 }
        $mf = Get-Content $mfPath -Raw | ConvertFrom-Json
        Write-Ok "备份来源: $($mf.dshHome) @ $($mf.exportedAt)"
        Write-Ok "目标 DSH 主目录: $newHome"

        if ($mf.settingsIncluded) { Write-Warn '该备份含 settings.yaml（API 密钥）。导入后本机将使用同一组密钥。' }

        $webDir = Join-Path $newHome ("profiles/" + $mf.profiles[0])
        if ((Test-Path (Join-Path $webDir 'package.json')) -and !$Force) {
            $ans = Read-Host "[?] $webDir 已存在插件清单，覆盖导入？(y/N)"
            if ($ans -notmatch '^[yY]') { Write-Fail '已取消。'; exit 1 }
        }
        New-Item -ItemType Directory -Force -Path $webDir | Out-Null

        # --- 还原清单文件 ---
        $srcWeb = Join-Path $expand ("profiles/" + $mf.profiles[0])
        foreach ($f in @('package.json', 'cordis.yml', 'cordis.patch.yml', 'pnpm-workspace.yaml', '.npmrc', 'pnpm-lock.yaml')) {
            $s = Join-Path $srcWeb $f
            if (Test-Path $s) { Copy-Item $s -Destination $webDir -Force }
        }
        Write-Ok '已还原 profiles 清单文件'

        # --- 重写 pnpm 存储路径为本机默认 ---
        $defaultStore = (Join-Path $env:LOCALAPPDATA 'pnpm/store').Replace('\', '/')
        $npmrc = Join-Path $webDir '.npmrc'
        if (Test-Path $npmrc) {
            $lines = @(Get-Content $npmrc | Where-Object { $_ -notmatch '^\s*store-dir\s*=' })
            $lines += "store-dir=$defaultStore"
            Set-Content $npmrc $lines
        }
        $ws = Join-Path $webDir 'pnpm-workspace.yaml'
        if (Test-Path $ws) {
            (Get-Content $ws -Raw) -replace '(?m)^storeDir:.*$', "storeDir: $defaultStore" | Set-Content $ws
        }
        Write-Ok '已将 pnpm 存储目录重写为本机默认位置'

        # --- 还原 vendor（link: 本地插件源码）并重写链接路径 ---
        $pkgPath = Join-Path $webDir 'package.json'
        $pkg = Get-Content $pkgPath -Raw | ConvertFrom-Json
        foreach ($vl in @($mf.vendorLinks)) {
            $dst = Join-Path $webDir ($vl.rel -replace '/', '\')
            if (Test-Path (Join-Path $expand $vl.rel)) {
                Copy-Item (Join-Path $expand $vl.rel) -Destination $dst -Recurse -Force
                $link = 'link:' + (Join-Path $webDir ($vl.rel -replace '/', '\')).Replace('\', '/')
                $pkg.dependencies.PSObject.Properties[$vl.dep].Value = $link
                Write-Ok "已还原本地插件 $($vl.dep) -> $link"
            }
        }
        $pkg | ConvertTo-Json -Depth 8 | Set-Content $pkgPath -Encoding UTF8

        # --- 还原用户层 patch / marketplace / skills / presets / settings / 数据 ---
        if (Test-Path (Join-Path $expand 'home-cordis.patch.yml')) {
            Copy-Item (Join-Path $expand 'home-cordis.patch.yml') -Destination (Join-Path $newHome 'cordis.patch.yml') -Force
        }
        if (Test-Path (Join-Path $expand 'marketplace')) {
            New-Item -ItemType Directory -Force -Path (Join-Path $newHome 'marketplace') | Out-Null
            Copy-Item (Join-Path $expand 'marketplace\*') -Destination (Join-Path $newHome 'marketplace') -Recurse -Force
            # 重写 installed.json 中指向旧机器的绝对路径（JSON 内为双反斜杠转义形式）
            $mi = Join-Path $newHome 'marketplace\installed.json'
            if ((Test-Path $mi) -and $mf.dshHome -and $mf.dshHome -ne $newHome) {
                $txt = Get-Content $mi -Raw
                $oldEsc = $mf.dshHome.Replace('\', '\\')
                $newEsc = $newHome.Replace('\', '\\')
                $txt2 = $txt.Replace($oldEsc, $newEsc).Replace($mf.dshHome, $newHome)
                if ($txt2 -ne $txt) {
                    Set-Content $mi $txt2 -Encoding UTF8
                    Write-Ok '已重写 marketplace/installed.json 中的机器路径'
                }
            }
        }
        foreach ($d in @('skills', '.agent-presets')) {
            $s = Join-Path $expand $d
            if (Test-Path $s) {
                $dst = Join-Path $newHome $d
                if (Test-Path $dst) { Remove-Item $dst -Recurse -Force }
                Copy-Item $s -Destination $dst -Recurse -Force
            }
        }
        if (Test-Path (Join-Path $expand 'settings.yaml')) {
            Copy-Item (Join-Path $expand 'settings.yaml') -Destination (Join-Path $newHome 'settings.yaml') -Force
        }
        if ($mf.pluginDataIncluded) {
            foreach ($d in @('dsh-ssh.json', 'dsh-imagegen')) {
                $s = Join-Path $expand $d
                if (Test-Path $s) { Copy-Item $s -Destination (Join-Path $newHome $d) -Recurse -Force }
            }
        }
        Write-Ok '已还原 patch / marketplace / skills / agent-presets / settings'

        # --- 安装依赖 ---
        if (!$SkipInstall) {
            Write-Step '开始安装插件依赖（pnpm install）……'
            $installed = $false
            # 优先用 dsh CLI 转发 pnpm（自动初始化 profile）
            try {
                $before = $LASTEXITCODE
                & cmd /c "dsh plugin --profile $($mf.profiles[0]) install" 2>&1 | ForEach-Object { Write-Host $_ }
                if ($LASTEXITCODE -eq 0) { $installed = $true }
            } catch { Write-Warn "dsh CLI 不可用: $($_.Exception.Message)" }
            if (!$installed) {
                try {
                    Push-Location $webDir
                    & pnpm install 2>&1 | ForEach-Object { Write-Host $_ }
                    if ($LASTEXITCODE -eq 0) { $installed = $true }
                    Pop-Location
                } catch { Write-Warn "pnpm 不可用: $($_.Exception.Message)" }
            }
            if (!$installed) {
                Write-Warn '依赖安装未成功。请确认已安装 pnpm（npm i -g pnpm），然后在 profile 目录手动执行 pnpm install，再重新运行本脚本（可加 -SkipInstall 跳过重装）。'
            }
        }

        # --- 还原手工放置的插件（在 install 之后拷贝，避免被清理） ---
        $extrasSrc = Join-Path $expand 'vendor\extras'
        if (Test-Path $extrasSrc) {
            New-Item -ItemType Directory -Force -Path (Join-Path $webDir 'node_modules') | Out-Null
            foreach ($d in @(Get-ChildItem $extrasSrc -Directory)) {
                Copy-Item $d.FullName -Destination (Join-Path $webDir "node_modules\$($d.Name)") -Recurse -Force
                Write-Ok "已还原手工插件: $($d.Name)"
            }
        }

        Write-Ok '导入完成！请重启 dsh（dsh web）后检查：侧边栏插件、设置 → 插件、梁神模式预设、skills。'
    } finally {
        Remove-Item $expand -Recurse -Force -ErrorAction SilentlyContinue
    }
}

if ($Import) { Import-Main } else { Export-Main }
