# TFK Studio: automated kids' video channel

Fully cloud-run pipeline that writes, renders, reviews and publishes short educational videos
(9:16) to **YouTube Shorts, Facebook Reels, Instagram Reels and Telegram**. Nothing runs on a personal computer.

```
Cloudflare cron --> Worker --> Gemini / Workers AI writes the script
                          \--> pushes the Kaggle notebook (one-run token injected)
Kaggle: Kokoro voice + Workers AI images + ffmpeg --> uploads the MP4 to the Worker
Worker --> Telegram review (Approve / Reject) --> publish to the 4 platforms
Dashboard (GitHub Pages) --> talks to the Worker API: create, upload, insights, alerts, settings
```

## Parts
| Folder | What it is |
|---|---|
| `worker/` | Cloudflare Worker (TypeScript): schedule, script writer, publishers, review bot, dashboard API |
| `kaggle/render.py` | Renderer script; the Worker pushes it to Kaggle on every run |
| `dashboard/` | Static dashboard (one HTML file, no build). Published by GitHub Pages |
| `tools/` | One-time helpers: `yt_auth.py` (YouTube sign-in), `meta_auth.py` (Facebook/Instagram token) |
| `.github/workflows/` | Auto-deploy the Worker and the dashboard on every push to `main` |

## Dashboard pages
1. **Studio**: create a video (live progress panel), upload your own video to all platforms, video list, views/likes/comments, insights and recommendations.
2. **Alerts**: actions needed by priority, plus the full notification and error log.
3. **Settings**: change client IDs, tokens and keys; test each connection. Changes apply within about a minute.

Sign in with the Worker's admin token (`JOB_TOKEN`). It is kept only in your browser.

## Automatic deployment (set up once)
Add two repository secrets (Settings > Secrets and variables > Actions):
- `CLOUDFLARE_API_TOKEN`: create at dash.cloudflare.com/profile/api-tokens with the "Edit Cloudflare Workers" template
- `CLOUDFLARE_ACCOUNT_ID`: shown on the Workers overview page

Enable Pages: Settings > Pages > Source: **GitHub Actions**. After that, every push to `main` redeploys both the Worker and the dashboard.

## Runtime secrets
Set on the dashboard Settings page (stored in Cloudflare KV, overrides deployed values), or with `npx wrangler secret put NAME`:
`JOB_TOKEN`, `GEMINI_API_KEY`, `KAGGLE_KEY`, `TG_BOT_TOKEN`, `META_TOKEN`, `YT_CLIENT_ID`, `YT_CLIENT_SECRET`, `YT_REFRESH_TOKEN`.
IDs (`TG_CHAT_ID`, `TG_ADMIN_ID`, `FB_PAGE_ID`, `IG_USER_ID`, `KAGGLE_USERNAME`) can be set there too.
Never commit secrets. This repository contains none.

## Recovery
- Locked out after a bad token change: `cd worker && npx wrangler kv key delete cfg --binding KV --remote` removes every value saved on the Settings page, falling back to the deployed secrets.
- YouTube stopped working: run `python3 tools/yt_auth.py` from `worker/`, or paste a new refresh token on the Settings page.
- Kaggle renders stuck: Alerts page > Retry render. Kaggle does not need any saved secret; each run gets a one-run token from the Worker.

## Known limits
- Cloudflare KV caches reads at the edge, so settings take up to about a minute to apply everywhere.
- Free-tier KV allows about 1,000 list operations per day: avoid leaving the dashboard open in many tabs.
- YouTube uploads from unaudited API projects are private until Google audits the project.
- Uploaded videos are limited to 20 MB (Telegram's limit when fetching by URL).
