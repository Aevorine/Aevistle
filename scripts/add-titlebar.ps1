# Draw a Windows title bar above a captured page, in place.
#
# The page is captured through CDP's emulated viewport, which has no window
# frame — that is the whole reason it can be captured at an exact CSS size on a
# machine whose screen is smaller. The bar is chrome rather than content: every
# existing README image has one, and a picture of the app without it reads as a
# picture of a web page.
param(
  [Parameter(Mandatory = $true)][string]$Image,
  [Parameter(Mandatory = $true)][string]$Title,
  [string]$Icon = ''
)

Add-Type -AssemblyName System.Drawing

$src = [System.Drawing.Image]::FromFile($Image)
$w = $src.Width
$h = $src.Height

# The capture is 2x, so everything here is in double pixels.
$scale = 2
$barH = 38 * $scale

$out = New-Object System.Drawing.Bitmap($w, ($h + $barH))
$g = [System.Drawing.Graphics]::FromImage($out)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic

# Matches the app's light-theme window background (`--surface-2`), so the bar
# and the page under it read as one window rather than two stacked images.
$bg = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(243, 244, 246))
$g.FillRectangle($bg, 0, 0, $w, $barH)

if ($Icon -and (Test-Path $Icon)) {
  $ico = [System.Drawing.Image]::FromFile($Icon)
  $s = 18 * $scale
  $g.DrawImage($ico, (12 * $scale), [int](($barH - $s) / 2), $s, $s)
  $ico.Dispose()
}

$font = New-Object System.Drawing.Font('Segoe UI', (9 * $scale), [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$fg = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(32, 33, 36))
$fmt = New-Object System.Drawing.StringFormat
$fmt.LineAlignment = [System.Drawing.StringAlignment]::Center
$g.DrawString($Title, $font, $fg, (40 * $scale), [single]($barH / 2), $fmt)

# Minimise / maximise / close, drawn as the thin glyphs Windows 11 uses.
$pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(60, 62, 66), (1.2 * $scale))
$cy = [int]($barH / 2)
$right = $w - (22 * $scale)
$gap = 46 * $scale
$gl = 5 * $scale

$x = $right - (2 * $gap)
$g.DrawLine($pen, ($x - $gl), $cy, ($x + $gl), $cy)

$x = $right - $gap
$g.DrawRectangle($pen, ($x - $gl), ($cy - $gl), (2 * $gl), (2 * $gl))

$x = $right
$g.DrawLine($pen, ($x - $gl), ($cy - $gl), ($x + $gl), ($cy + $gl))
$g.DrawLine($pen, ($x + $gl), ($cy - $gl), ($x - $gl), ($cy + $gl))

$g.DrawImage($src, 0, $barH, $w, $h)

$g.Dispose()
$src.Dispose()

# Save through a temp file: the source is still locked by the Image handle at
# the moment the new bitmap wants the same path.
$tmp = "$Image.tmp.png"
$out.Save($tmp, [System.Drawing.Imaging.ImageFormat]::Png)
$out.Dispose()
Move-Item -Force $tmp $Image

"{0}x{1}" -f $w, ($h + $barH)
