<# 
.SYNOPSIS
    Launch HAXORDASH dashboard — starts the server if needed, opens the browser.
#>

$ErrorActionPreference = 'Stop'

$projectDir = "C:\Users\iason\AppData\Roaming\npm\hackerdash"
$port = 3969
$url = "http://127.0.0.1:$port"

# Check if server is already responding
function Test-Server {
    try {
        $resp = Invoke-WebRequest -Uri "$url/health" -TimeoutSec 2 -UseBasicParsing -ErrorAction SilentlyContinue
        return $resp.StatusCode -eq 200
    } catch { return $false }
}

# Start server in background if not running
if (-not (Test-Server)) {
    Write-Host "Starting HAXORDASH on $url ..."
    $proc = Start-Process -FilePath "node" -ArgumentList "server.js" -WorkingDirectory $projectDir -WindowStyle Hidden -PassThru
    
    # Wait for server to come up (max 10s)
    $t0 = [DateTime]::Now
    while (-not (Test-Server)) {
        if (([DateTime]::Now - $t0).TotalSeconds -gt 10) {
            Write-Error "Server failed to start within 10 seconds"
            exit 1
        }
        Start-Sleep -Milliseconds 300
    }
    Write-Host "Server ready."
} else {
    Write-Host "HAXORDASH already running on $url"
}

# Open browser
Start-Process $url
Write-Host "Opened $url"