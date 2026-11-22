#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
ffmpeg -v error -y -framerate 30 -i out/frames/f%05d.jpg -i out/audio.wav \
  -c:v libx264 -preset slow -crf 15 -pix_fmt yuv420p -color_primaries bt709 -color_trc bt709 -colorspace bt709 \
  -c:a aac -b:a 256k -shortest -movflags +faststart out/telepathy-launch.mp4
ffprobe -v error -show_entries format=duration,size:stream=codec_name,width,height,r_frame_rate -of compact out/telepathy-launch.mp4
