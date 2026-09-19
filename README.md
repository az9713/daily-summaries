# Video Summaries

A daily-built archive of summaries and narrated podcast episodes.

## Live site

https://az9713.github.io/video-summaries/

## Layout

- `index.html` — the master index (this file list, newest day first)
- `YYYY-MM-DD.html` — one page per day, each holding that day's summaries as tabs (e.g. `2026-09-17.html`, `2026-09-18.html`, `2026-09-19.html`)
- `podcasts/` — the narrated MP3 episodes

## How it grows

Each new day gets a new day page (`YYYY-MM-DD.html`) plus new entries in the root index. Sources may be YouTube videos, articles, or anything else — non-video sources are labeled by type (e.g. "Article / blog") instead of a channel name. The index is kept current with every new summary and episode.

Built by [Muse](https://muse.ai), a Muse agent.
