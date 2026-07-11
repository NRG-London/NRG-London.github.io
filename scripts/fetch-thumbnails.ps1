<#
  fetch-thumbnails.ps1 - download + resize cover/preview images once, then
  commit them. Run locally on Windows before committing/pushing. Idempotent:
  existing thumbnails are skipped.

  Two sources:
   1. Substack newsletters - every RSS <enclosure> cover image is saved to
      static/images/thumbs/nl-<post-slug>.jpg
   2. Library stubs - any content/library/*.md with a `thumbnail_url: "..."`
      front-matter line (e.g. a tweet's pbs.twimg.com image) is saved to
      static/images/thumbs/stub-<file-slug>.jpg

  Images are resized to <=720px wide (JPEG). The Hugo build references these
  committed files; nothing is fetched at build/deploy time.

  Usage:  ./scripts/fetch-thumbnails.ps1
#>

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Add-Type -AssemblyName System.Drawing

$root     = Split-Path $PSScriptRoot -Parent
$thumbDir = Join-Path $root 'static\images\thumbs'
$maxWidth = 720

if (-not (Test-Path $thumbDir)) { New-Item -ItemType Directory -Path $thumbDir -Force | Out-Null }

$ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
$client = New-Object System.Net.WebClient
$client.Headers.Add('User-Agent', $ua)
$client.Encoding = [System.Text.Encoding]::UTF8   # RSS is UTF-8 (fixes £, curly quotes, etc.)

# Download an image, downscale to <=maxWidth preserving aspect, save as JPEG.
function Save-Thumb([string]$url, [string]$dest) {
  $bytes = $client.DownloadData($url)
  $ms  = New-Object System.IO.MemoryStream(,$bytes)
  $src = [System.Drawing.Image]::FromStream($ms)
  $ratio = [Math]::Min(1.0, $maxWidth / $src.Width)
  $w = [int]($src.Width * $ratio); $h = [int]($src.Height * $ratio)
  $dst = New-Object System.Drawing.Bitmap($w, $h)
  $g = [System.Drawing.Graphics]::FromImage($dst)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.PixelOffsetMode   = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.DrawImage($src, 0, 0, $w, $h)
  $dst.Save($dest, [System.Drawing.Imaging.ImageFormat]::Jpeg)
  $g.Dispose(); $dst.Dispose(); $src.Dispose(); $ms.Dispose()
  return ("{0} x {1}" -f $w, $h)
}

$downloaded = 0; $skipped = 0; $failed = 0

# --- 1. Substack newsletters (RSS enclosure covers) ---
$hugoToml = Get-Content (Join-Path $root 'hugo.toml') -Raw
if ($hugoToml -match '(?m)^\s*substackRSS\s*=\s*"([^"]+)"') {
  $feedUrl = $Matches[1]
  Write-Host "Fetching feed: $feedUrl"
  [xml]$rss = $client.DownloadString($feedUrl)
  foreach ($item in $rss.rss.channel.item) {
    $link = "$($item.link)".Trim()
    $slug = ($link -split '\?')[0].TrimEnd('/').Split('/')[-1]
    if ([string]::IsNullOrWhiteSpace($slug)) { continue }
    $dest = Join-Path $thumbDir "nl-$slug.jpg"
    if (Test-Path $dest) { $skipped++; continue }
    $imgUrl = "$($item.enclosure.url)".Trim()
    if ([string]::IsNullOrWhiteSpace($imgUrl)) { Write-Warning "No enclosure for '$slug'"; $failed++; continue }
    try { $dim = Save-Thumb $imgUrl $dest; Write-Host ("  + nl-{0}.jpg  {1}" -f $slug, $dim); $downloaded++ }
    catch { Write-Warning "Failed newsletter '$slug': $($_.Exception.Message)"; $failed++ }
  }

  # Write the newsletter list to a committed data file. Substack returns 403 to
  # the CI build-time fetch, so the site reads data/substack.json rather than
  # fetching the RSS at build. This refreshes it from your (allowed) machine.
  $news = @()
  foreach ($item in $rss.rss.channel.item) {
    # title / description are CDATA-wrapped; use InnerText (not the XML shortcut)
    $titleNode = $item.SelectSingleNode('title')
    $descNode  = $item.SelectSingleNode('description')
    $title = if ($titleNode) { $titleNode.InnerText.Trim() } else { '' }
    $desc  = if ($descNode)  { $descNode.InnerText } else { '' }
    $desc = [regex]::Replace($desc, '<[^>]+>', ' ')
    $desc = [System.Net.WebUtility]::HtmlDecode($desc)
    $desc = ($desc -replace '\s+', ' ').Trim()
    if ($desc.Length -gt 140) { $desc = $desc.Substring(0, 140).TrimEnd() + [char]0x2026 }
    $dt = [datetime]::Parse("$($item.pubDate)", [System.Globalization.CultureInfo]::InvariantCulture).ToUniversalTime()
    $news += [ordered]@{
      title   = $title
      url     = "$($item.link)".Trim()
      summary = $desc
      date    = $dt.ToString("yyyy-MM-ddTHH:mm:ssZ")
    }
  }
  $dataDir = Join-Path $root 'data'
  if (-not (Test-Path $dataDir)) { New-Item -ItemType Directory -Force -Path $dataDir | Out-Null }
  $json = "[`n" + (($news | ForEach-Object { "  " + ($_ | ConvertTo-Json -Depth 3 -Compress) }) -join ",`n") + "`n]`n"
  [System.IO.File]::WriteAllText((Join-Path $dataDir 'substack.json'), $json, (New-Object System.Text.UTF8Encoding($false)))
  Write-Host ("Wrote data/substack.json ({0} posts)" -f $news.Count)
} else {
  Write-Warning "Could not find substackRSS in hugo.toml - skipping newsletters"
}

# --- 2. Library stubs: explicit thumbnail_url, or auto-resolved from an X/Twitter link ---
Get-ChildItem (Join-Path $root 'content\library') -Filter '*.md' | ForEach-Object {
  $raw  = Get-Content $_.FullName -Raw
  $slug = $_.BaseName
  $dest = Join-Path $thumbDir "stub-$slug.jpg"
  if (Test-Path $dest) { $skipped++; return }

  $imgUrl = $null
  if ($raw -match '(?m)^\s*thumbnail_url:\s*"([^"]+)"') {
    $imgUrl = $Matches[1].Trim()
  }
  elseif ($raw -match '(?m)^\s*external_url:\s*"[^"]*(?:twitter\.com|x\.com)/[^"/]+/status/(\d+)') {
    # X/Twitter: pull the media poster from the public syndication CDN (no auth).
    $tweetId = $Matches[1]
    try {
      $syn = Invoke-RestMethod "https://cdn.syndication.twimg.com/tweet-result?id=$tweetId&token=a" -UserAgent $ua -ErrorAction Stop
      if     ($syn.mediaDetails)                 { $imgUrl = $syn.mediaDetails[0].media_url_https }
      elseif ($syn.video -and $syn.video.poster) { $imgUrl = $syn.video.poster }
      elseif ($syn.photos)                       { $imgUrl = $syn.photos[0].url }
      if (-not $imgUrl) { Write-Warning "No media found in tweet for '$slug'" }
    }
    catch { Write-Warning "X syndication lookup failed for '$slug': $($_.Exception.Message)" }
  }

  if ([string]::IsNullOrWhiteSpace($imgUrl)) { return }
  try { $dim = Save-Thumb $imgUrl $dest; Write-Host ("  + stub-{0}.jpg  {1}" -f $slug, $dim); $downloaded++ }
  catch { Write-Warning "Failed stub '$slug': $($_.Exception.Message)"; $failed++ }
}

Write-Host ""
Write-Host "Done. Downloaded: $downloaded  Skipped (existing): $skipped  Failed: $failed"
Write-Host "Review and commit new files under static/images/thumbs/."
