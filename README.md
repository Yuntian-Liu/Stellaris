# ✦ Stellaris

> Turning the voices in your videos into words you can read. Drop a Bilibili link — Stellaris pulls existing captions, or transcribes the audio itself when none exist.

A web app to extract subtitles from Bilibili videos. Give it a link (or upload a file), get back readable subtitles — `.srt` and `.txt`.

## How it works

1. **Fetch** — `yt-dlp` downloads the video and grabs existing captions when the platform has them.
2. **Transcribe** — when there are no captions, the audio is transcribed via cloud ASR.
3. **Deliver** — returns clean subtitles you can preview and download.

## Tech stack

- **Frontend** — React + Vite + Ant Design
- **Backend** — Python / FastAPI
- **Pipeline** — yt-dlp · FFmpeg · cloud ASR
- **Deploy** — lightweight server (low-RAM friendly)

## Status

🚧 In development.

## License

MIT
