# Codec Compatibility

Reel serves media files with correct MIME types and lets the browser handle
decoding. This means playback support depends entirely on the browser and
operating system — Reel does not transcode.

If a file fails to play, the player shows a codec error toast with the
specific `MediaError` code. The most common cause is a container/codec
combination the browser doesn't support natively.

## Containers and Codecs

### Video

| Container | Extension | MIME Type | Chrome/Edge | Firefox | Safari | Notes |
|-----------|-----------|-----------|-------------|---------|--------|-------|
| MP4 (H.264/AAC) | .mp4, .m4v | video/mp4 | Yes | Yes | Yes | Universal. The safe default for everything. |
| MP4 (H.265/HEVC) | .mp4, .m4v | video/mp4 | Partial | No | Yes (macOS/iOS) | Chrome supports HEVC on hardware-capable systems (Windows with HEVC Video Extensions, macOS with T2+). Firefox has no HEVC support. |
| WebM (VP8/VP9) | .webm | video/webm | Yes | Yes | Safari 16.4+ | VP9 is well-supported. Older Safari versions fail. |
| WebM (AV1) | .webm | video/webm | Yes (90+) | Yes (98+) | Safari 17+ | Requires recent browser versions. Hardware decode availability varies. |
| Matroska | .mkv | video/x-matroska | No | No | No | No browser supports MKV natively. Re-mux to MP4 with `ffmpeg -i input.mkv -c copy output.mp4` (if the codecs inside are H.264/AAC, this is lossless and instant). |
| AVI | .avi | video/x-msvideo | No | No | No | Legacy container. Re-encode to MP4. |
| QuickTime | .mov | video/quicktime | Partial | Partial | Yes | Safari plays MOV natively. Chrome/Firefox support depends on the codec inside (H.264 usually works). |

### Audio

| Format | Extension | MIME Type | Chrome/Edge | Firefox | Safari | Notes |
|--------|-----------|-----------|-------------|---------|--------|-------|
| MP3 | .mp3 | audio/mpeg | Yes | Yes | Yes | Universal. |
| AAC (in M4A) | .m4a | audio/mp4 | Yes | Yes | Yes | Universal. Preferred over raw AAC. |
| WAV | .wav | audio/wav | Yes | Yes | Yes | Uncompressed. Large files stream fine over LAN. |
| FLAC | .flac | audio/flac | Yes (56+) | Yes (51+) | Safari 11+ | Well-supported in modern browsers. |
| Ogg Vorbis | .ogg | audio/ogg | Yes | Yes | Safari 15.4+ | Older Safari versions fail. |
| Opus | .opus | audio/opus | Yes | Yes | Safari 15.4+ | Excellent codec. Same Safari caveat as Ogg. |
| Raw AAC | .aac | audio/aac | Yes | Yes | Yes | Works but M4A container is more reliable. |
| WMA | .wma | audio/x-ms-wma | No | No | No | Microsoft proprietary. No browser supports it. Convert to MP3 or FLAC. |

## Practical Recommendations

**For maximum compatibility**, encode or re-mux to these formats:

- **Video:** MP4 container with H.264 video + AAC audio. Every browser plays this. For 4K content where H.264 is insufficient, VP9 in WebM is the next-best option across Chrome and Firefox (Safari support is recent).

- **Audio:** MP3 for lossy, FLAC for lossless. Both are universally supported. M4A (AAC) is also universal and offers better quality-per-bitrate than MP3.

**yt-dlp format selection** to avoid codec issues:

```bash
# Force H.264 + AAC in MP4 — avoids AV1/VP9 captures that may not play
yt-dlp -f "bestvideo[vcodec^=avc1]+bestaudio[acodec^=mp4a]/best[vcodec^=avc1]" \
  --merge-output-format mp4 URL
```

Use explicit codec filtering (`vcodec^=avc1`, `acodec^=mp4a`) rather than
extension-based filtering to reliably avoid AV1 captures.

**Re-muxing MKV to MP4** (when the codecs inside are already compatible):

```bash
# Lossless, instant — just changes the container
ffmpeg -i input.mkv -c copy output.mp4
```

This works when the MKV contains H.264/H.265 video and AAC/MP3 audio. If it
contains VP9 or other codecs, you'll need to re-encode to H.264 or use WebM.

## Hardware Acceleration

Browser video decoding uses hardware acceleration when available. If playback
of supported formats is stuttering or failing on capable hardware:

**Firefox (Linux):** VA-API must be active for hardware-decoded 1080p H.264.
Enable `media.hardware-video-decoding.force-enabled` in `about:config`. On
distributions like CachyOS, the NVDEC VA-API driver is present by default.

**Chrome (Linux):** Hardware acceleration may need `--enable-features=VaapiVideoDecoder`
or `--enable-features=VaapiVideoDecodeLinuxGL` depending on the driver stack.
Check `chrome://gpu` for decode capability status.

**All browsers (Windows/macOS):** Hardware acceleration is typically enabled by
default and works without configuration for H.264. HEVC on Windows requires the
HEVC Video Extensions from the Microsoft Store (free with some device
manufacturers, otherwise paid).
