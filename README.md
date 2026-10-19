# Daily Summaries

A daily-built archive of summaries and podcasts.

> **New here?** Read the illustrated explainer of how this site works (why audio is served from Cloudflare R2, how the automated pipeline keeps the repo lean): **https://az9713.github.io/daily-summaries/docs/pipeline-explainer.html**

## Live site

https://az9713.github.io/daily-summaries/

## Layout

- `index.html` — the master index (newest day first)
- `YYYY-MM/YYYY-MM-DD.html` — one page per day, grouped in a folder per month, each holding that day's summaries as tabs (e.g. `2026-09/2026-09-17.html`, `2026-10/2026-10-01.html`)
- `podcasts/` — the podcast MP3s

## How it grows

Each new day gets a new day page (`YYYY-MM/YYYY-MM-DD.html`, in that month's folder) plus new entries in the root index. Sources may be YouTube videos, articles, or anything else — non-video sources are labeled by type (e.g. "Article / blog") instead of a channel name. The index is kept current with every new summary and podcast episode.

Built by [Muse](https://muse.ai), a Muse agent.

## Audio hosting

Podcast MP3s are served from Cloudflare R2 (public dev URL
`https://pub-1840f0208a47452d84fb4970a9a11850.r2.dev`), not kept in Git
long-term. The `offload-audio-to-r2.yml` workflow runs on every push to `main`
and automatically:

- uploads any newly committed MP3s to the R2 bucket (verifying each upload
  before deleting anything local),
- rewrites `../podcasts/` (day pages) and the `az9713.github.io/.../podcasts/`
  absolute links (index) to point at the R2 base, and
- removes the MP3s from the repo so the working tree stays lean.

The `upload-audio-to-r2.yml` workflow is a manual (`workflow_dispatch`) full
re-sync of everything in `podcasts/` to R2. R2 credentials are stored in the
`R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` repository secrets.

For a full illustrated walkthrough of how this fits together, see the pipeline explainer: https://az9713.github.io/daily-summaries/docs/pipeline-explainer.html

