<#
.SYNOPSIS
  Compila e roda o plano.

.EXAMPLE
  .\run.ps1              # com o banco de demonstração (Docker) e o modo ao vivo, em http://127.0.0.1:7676
  .\run.ps1 -Static      # sem Docker: só a análise de planos colados
  .\run.ps1 -Db "postgres://usuario:senha@host:5432/banco"   # modo ao vivo no seu banco
  .\run.ps1 -Dev         # servidor + Vite com hot reload em http://localhost:5176
  .\run.ps1 -Test        # testes do motor (vitest), do servidor (Go) e checagem de tipos
  .\run.ps1 -Down        # para o banco de demonstração
#>
param(
    [switch]$Static,
    [string]$Db,
    [switch]$Dev,
    [switch]$Test,
    [switch]$Down,
    [switch]$NoBrowser,
    [int]$Port = 7676
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
Set-Location $root
$demoDb = 'postgres://plano:plano@127.0.0.1:54330/loja'

function Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Green }
function Need($cmd, $hint) {
    if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
        Write-Host "Faltando: $cmd. $hint" -ForegroundColor Red
        exit 1
    }
}
function DockerUp { docker info *> $null; return $LASTEXITCODE -eq 0 }

if ($Down) {
    docker compose down
    exit $LASTEXITCODE
}

Need go   'Instale Go 1.26+ em https://go.dev/dl/'
Need node 'Instale Node 22+ em https://nodejs.org/'

# --- Banco de demonstração ---------------------------------------------------
# Sem -Static e sem -Db, sobe a loja de exemplo no Docker. Se o Docker não
# estiver instalado, segue no modo estático em vez de falhar.
if (-not $Static -and -not $Db) {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        Write-Host 'Docker não encontrado: rodando sem o modo ao vivo (equivale a -Static).' -ForegroundColor Yellow
        $Static = $true
    } else {
        if (-not (DockerUp)) {
            $desktop = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
            if (Test-Path $desktop) {
                Step 'Iniciando o Docker Desktop (pode levar um minuto)'
                Start-Process $desktop
                for ($i = 0; $i -lt 90 -and -not (DockerUp); $i++) { Start-Sleep -Seconds 2 }
            }
        }
        if (DockerUp) {
            Step 'Banco de demonstração (na primeira vez, cria 3 milhões de linhas: ~1 minuto)'
            docker compose up -d --wait
            if ($LASTEXITCODE) { throw 'não foi possível subir o banco de demonstração' }
            $Db = $demoDb
        } else {
            Write-Host 'O Docker não ficou pronto: rodando sem o modo ao vivo.' -ForegroundColor Yellow
            $Static = $true
        }
    }
}

Push-Location ui
try {
    if (-not (Test-Path node_modules)) {
        Step 'Instalando dependências do frontend'
        npm install --no-audit --no-fund
        if ($LASTEXITCODE) { throw 'npm install falhou' }
    }
} finally { Pop-Location }

if ($Test) {
    Step 'Motor de análise (vitest)'
    Push-Location ui
    npm test
    $code = $LASTEXITCODE
    if (-not $code) { Step 'Checagem de tipos e build'; npm run build; $code = $LASTEXITCODE }
    Pop-Location
    if ($code) { exit $code }
    Step 'Servidor e modo ao vivo (Go)'
    go vet ./cmd/... ./internal/...
    if ($LASTEXITCODE) { exit $LASTEXITCODE }
    if ($Db) { $env:PLANO_DATABASE_URL = $Db }
    go test ./cmd/... ./internal/...
    exit $LASTEXITCODE
}

$serveArgs = @('-addr', "127.0.0.1:$Port")
if ($Db) { $serveArgs += @('-db', $Db) }

if ($Dev) {
    Step "Servidor em http://127.0.0.1:$Port (janela separada)"
    $backend = Start-Process -PassThru -FilePath go -ArgumentList (@('run', './cmd/plano') + $serveArgs) -WorkingDirectory $root
    try {
        Step 'Frontend com hot reload em http://localhost:5176'
        if (-not $NoBrowser) { Start-Process 'http://localhost:5176' }
        Push-Location ui
        npm run dev
    } finally {
        Pop-Location
        # go run cria um processo filho: derruba a árvore inteira.
        if ($backend -and -not $backend.HasExited) { taskkill /PID $backend.Id /T /F | Out-Null }
    }
    exit 0
}

Step 'Compilando o frontend'
Push-Location ui
try {
    npm run build
    if ($LASTEXITCODE) { throw 'build do frontend falhou' }
} finally { Pop-Location }

Step 'Compilando o binário (frontend embutido)'
New-Item -ItemType Directory -Force bin | Out-Null
go build -trimpath -ldflags '-s -w' -o bin/plano.exe ./cmd/plano
if ($LASTEXITCODE) { throw 'go build falhou' }

$url = "http://127.0.0.1:$Port"
$modo = if ($Db) { 'modo ao vivo ligado' } else { 'só análise de planos colados' }
Step "plano rodando em $url ($modo). Ctrl+C para parar."
if (-not $NoBrowser) {
    Start-Job -ScriptBlock {
        param($u)
        for ($i = 0; $i -lt 40; $i++) {
            try { Invoke-WebRequest "$u/api/info" -UseBasicParsing -TimeoutSec 1 | Out-Null; Start-Process $u; return } catch { Start-Sleep -Milliseconds 250 }
        }
    } -ArgumentList $url | Out-Null
}
& "$root\bin\plano.exe" @serveArgs
