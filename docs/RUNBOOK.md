# Disaster-Recovery Runbook — R2 Audio Pipeline

Operational guide for recovering the `az9713/daily-summaries` audio pipeline. Written for the repo owner picking this up months from now, with no devops background assumed. Keep to the commands and steps written here.

---

## 1. Overview

This repo publishes a daily archive of HTML summaries and their podcast audio at **https://az9713.github.io/daily-summaries/** (served by GitHub Pages from the `main` branch). Content — the daily HTML pages (with `../podcasts/<slug>.mp3` links) and the MP3 files — is generated and pushed automatically by the external **Muse** agent (muse.ai). Muse is upstream; it knows nothing about Cloudflare and is **not touched** by any recovery here. Everything in this runbook concerns what happens *after* Muse pushes.

The pipeline has **three "brain" components**, each independently reconstructable:

1. **The two workflow YAML files** in `.github/workflows/` — the automation logic.
2. **The two GitHub repo secrets** — the R2 credentials.
3. **The R2 bucket + its public URL + its access token** — where the audio actually lives.

If any one is lost, it can be rebuilt without the others.

---

## 2. Health check — is it working?

### The Actions tab is your dashboard

Open **https://github.com/az9713/daily-summaries/actions**.

| What you see | What it means |
| --- | --- |
| **Green** run after a Muse push | Healthy. |
| **Red** run | The janitor failed — open the run to read the error. |
| **No run** after Muse pushed | The workflow file is missing or disabled. |

### Turn on failure emails (do this once)

GitHub can email you only when a workflow fails:

1. Go to **https://github.com/settings/notifications** (your **personal** `github.com` account → Settings → Notifications).
2. Find the **Actions** section.
3. Enable **"Send notifications for failed workflows only."**

Note: this is your **personal account** notification settings, **not** the repo's Settings tab.

### Symptoms of a silent break

- New episodes' audio **404s** on the live site.
- `podcasts/*.mp3` files **reappear in the repo and stay there** (they should be stripped out automatically).

---

## 3. Normal operation (what happens on each Muse push)

1. **Muse pushes** new HTML + MP3s to `main`.
2. The **janitor** workflow (`offload-audio-to-r2.yml`) triggers on that push.
3. It **uploads** the new MP3s to R2 (via rclone) and **verifies** each one is present on R2.
4. It **rewrites** the audio links in the HTML — the `../podcasts/` links, the `github.io/daily-summaries/podcasts/` absolute links, and the JS `audio[src^=...]` selector — to point at the R2 public base URL.
5. It **strips** the MP3s from the repo (`git rm`).
6. It **commits back** the rewritten HTML using `GITHUB_TOKEN` (this does **not** re-trigger workflows, so there is no loop).
7. **GitHub Pages** serves the updated HTML.

Result: a browser loads the **HTML from Pages** and the **audio from R2**.

---

## 4. Routine procedures

### Full re-sync of all audio to R2

Use this when R2 and the repo have drifted (e.g. you suspect some files never made it).

1. Open the **Actions** tab.
2. Select the **"Upload podcasts to R2"** workflow (`upload-audio-to-r2.yml`).
3. Click **Run workflow** on `main`.

This re-syncs everything currently in `podcasts/` to R2.

### Rotate the R2 token

1. In **Cloudflare → R2**, create a new **Account API token**:
   - Permission: **Object Read & Write**
   - Scope: the **`daily-summaries-audio`** bucket
   - TTL: **Forever**
2. Update the repo secrets with the new token's S3 credential pair:
   - **`R2_ACCESS_KEY_ID`**
   - **`R2_SECRET_ACCESS_KEY`**
3. Once the new secrets are confirmed working (trigger a run or a Muse push), **delete the old token** in Cloudflare.

---

## 5. Safe history rewrite / scrubbing personal info

**IMPORTANT — the force-push footgun.**

### Why this is risky

Force-pushing from a **stale clone** silently erases any history that clone doesn't have — including the **workflow files** and the **janitor's auto-commits**. The pipeline keeps committing to `main` on its own, so a clone goes stale fast. A careless force-push can disable the whole pipeline without any error.

### Safe procedure

1. **Clone fresh and full** — `git clone` the current `main`, with **no `--depth`** (you need complete history for a rewrite).
2. **Push a backup branch** of current `main` first (e.g. `backup/pre-scrub-<date>`), so you can always get back.
3. Use **`git filter-repo`** with a **targeted path/pattern** — scrub only the specific personal info. **Never** a broad sweep.
4. **Before pushing**, verify:
   - `.github/workflows/offload-audio-to-r2.yml` still exists, and
   - `podcasts/` is still empty.
5. **Force-push `main` only.**

### Aftercare

- Old blobs **linger** until GitHub garbage-collects them. Open **PR refs can pin** them; **GitHub Support** can force a gc.
- If what you scrubbed was a **secret or credential**, **rotate it** — it may already be cached or forked.
- If the personal info was also inside an **R2 object**, **delete that object** from the bucket too.

Note: you can ask **Claude Code** to perform this safely — it's the same method used for the original audio purge.

---

## 6. Failure modes & recovery

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Janitor run is **RED** with an auth error (401/403/`InvalidAccessKeyId`/`SignatureDoesNotMatch`) | R2 token expired, rotated, or deleted | Mint a new R2 token and update the two repo secrets (`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`) — see §4. |
| **No janitor runs at all** when content was pushed | Workflow file missing, or Actions disabled for the repo | Restore `.github/workflows/offload-audio-to-r2.yml` (it's in Git history; can be regenerated) and ensure Actions is enabled: repo **Settings → Actions → General → allow actions**. |
| A **specific new episode's audio 404s** on the site | Its MP3 never reached R2 (a run failed or was skipped) | Run the **"Upload podcasts to R2"** workflow to re-sync, or re-push. Confirm the file appears in the R2 bucket. |
| **ALL audio 404s** with an R2 *"Object not found / enable Public Access"* page | The bucket's Public Development URL got disabled | Re-enable it: **R2 → bucket → Settings → Public Development URL → Enable**. |
| **MP3s piling up** in the repo / repo re-bloating | Janitor not running or failing | Check the Actions tab, fix the root cause above, then push any change (or run the manual workflow) to let it catch up. |
| Repo state **clobbered after a bad force-push** | Stale-clone force-push erased history | Restore from the `backup/...` branch if one was pushed, or from the local clone's reflog. Re-add the workflow files and re-run the janitor. |

---

## 7. Inventory — where everything lives

- **Workflow files** (`.github/workflows/`):
  - `offload-audio-to-r2.yml` — the janitor (runs on push to `main`).
  - `upload-audio-to-r2.yml` — manual full re-sync (`workflow_dispatch`).
- **GitHub repo secrets** (names only; stored in GitHub's encrypted vault, not in Git):
  - `R2_ACCESS_KEY_ID`
  - `R2_SECRET_ACCESS_KEY`
- **Cloudflare R2:**
  - Bucket name: **`daily-summaries-audio`**
  - Public base URL: **https://pub-1840f0208a47452d84fb4970a9a11850.r2.dev** (the R2 "Public Development URL" — rate-limited, non-production)
  - S3 endpoint: **`https://<account-id>.r2.cloudflarestorage.com`** (the account id is already in the workflow file)
- **GitHub Pages site:** https://az9713.github.io/daily-summaries/
- **Explainer page:** https://az9713.github.io/daily-summaries/docs/pipeline-explainer.html

---

## 8. Rebuild from scratch

If all else fails, the entire pipeline is reconstructable from the **explainer page** and **this runbook**: the two workflow files, the two secrets, and the R2 bucket + public URL + token are each independently rebuildable (see §1 and §7). You can ask **Claude Code** to rebuild the workflows and re-run the migration.
