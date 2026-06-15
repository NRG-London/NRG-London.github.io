<#
  fetch-thumbnails.ps1 - download + resize Substack post cover images once,
  then commit them. Run locally on Windows before committing/pushing when a new
  newsletter has been published. Idempotent: existing thumbnails are skipped.

  Each newsletter's cover (the RSS <enclosure>) is downloaded, resized to
  <=720px wide (JPEG), and saved to static/images/thumbs/nl-<slug>.jpg.
  The Hugo build references these committed files; nothing is fetched at
  build/deploy time.

  Usage:  ./scripts/fetch-thumbnails.ps1
#>

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Add-Type -AssemblyName System.Drawing

$root     = Split-Path $PSScriptRoot -Parent
$thumbDir = Join-Path $root 'static\images\thumbs'
$maxWidth = 720

# Read the feed URL from hugo.toml (substackRSS = "...")
$hugoToml = Get-Content (Join-Path $root 'hugo.toml') -Raw
if ($hugoToml -notmatch '(?m)^\s*substackRSS\s*=\s*"([^"]+)"') {
  throw "Could not find substackRSS in hugo.toml"
}
$feedUrl = $Matches[1]

if (-not (Test-Path $thumbDir)) { New-Item -ItemType Directory -Path $thumbDir -Force | Out-Null }

Write-Host "Fetching feed: $feedUrl"
$client = New-Object System.Net.WebClient
$client.Headers.Add('User-Agent', 'Mozilla/5.0 (neilgarratt.com thumbnail fetcher)')
[xml]$rss = $client.DownloadString($feedUrl)

$downloaded = 0; $skipped = 0; $failed = 0
foreach ($item in $rss.rss.channel.item) {
  $link = "$($item.link)".Trim()
  $slug = ($link -split '\?')[0].TrimEnd('/').Split('/')[-1]
  if ([string]::IsNullOrWhiteSpace($slug)) { continue }
  $dest = Join-Path $thumbDir "nl-$slug.jpg"
  if (Test-Path $dest) { $skipped++; continue }

  $imgUrl = "$($item.enclosure.url)".Trim()
  if ([string]::IsNullOrWhiteSpace($imgUrl)) {
    Write-Warning "No enclosure image for '$slug' - skipping"
    $failed++; continue
  }

  try {
    $bytes = $client.DownloadData($imgUrl)
    $ms  = New-Object System.IO.MemoryStream(,$bytes)
    $src = [System.Drawing.Image]::FromStream($ms)

    $ratio = [Math]::Min(1.0, $maxWidth / $src.Width)
    $w = [int]($src.Width * $ratio); $h = [int]($src.Height * $ratio)
    $dst = New-Object System.Drawing.Bitmap($w, $h)
    $g = [System.Drawing.Graphics]::FromImage($dst)
    $g.InterpolationMode  = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode      = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.PixelOffsetMode    = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.DrawImage($src, 0, 0, $w, $h)
    $dst.Save($dest, [System.Drawing.Imaging.ImageFormat]::Jpeg)

    $g.Dispose(); $dst.Dispose(); $src.Dispose(); $ms.Dispose()
    Write-Host ("  + nl-{0}.jpg  {1}x{2}" -f $slug, $w, $h)
    $downloaded++
  }
  catch {
    Write-Warning "Failed for '$slug': $($_.Exception.Message)"
    $failed++
  }
}

Write-Host ""
Write-Host "Done. Downloaded: $downloaded  Skipped (existing): $skipped  Failed: $failed"
Write-Host "Review and commit new files under static/images/thumbs/."
