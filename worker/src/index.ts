// @ts-ignore bundled as text via wrangler [[rules]]
import RENDER_PY from "../../kaggle/render.py";

interface Env {
  KV: KVNamespace; AI: any;
  NICHE: string; KAGGLE_USERNAME: string; KAGGLE_KERNEL_SLUG: string; WORKER_URL: string;
  IG_USER_ID: string; FB_PAGE_ID: string; TG_CHAT_ID: string; TG_ADMIN_ID: string;
  GEMINI_API_KEY: string; KAGGLE_KEY: string; JOB_TOKEN: string; TG_BOT_TOKEN: string;
  META_TOKEN: string; YT_CLIENT_ID: string; YT_CLIENT_SECRET: string; YT_REFRESH_TOKEN: string;
}
type Job = { id: string; source?: string; events?: { t: number; m: string }[]; progress?: { step: string; done: number; total: number; t: number }; status: "writing" | "uploading" | "pending" | "rendering" | "review" | "publishing" | "rejected" | "published" | "failed"; title: string;
  createdAt?: number; claimedAt?: number; attempts?: number; caption: string; hashtags: string[]; hook?: string; gen?: string; words?: number; keywords?: string[]; yt_title?: string; yt_description?: string; scenes: { narration: string; visual_query: string }[]; results?: Record<string, string> };


// ---------- 0. Shared helpers: config overrides, job storage, events, log ----------
const CFG_KEYS = ["JOB_TOKEN", "GEMINI_API_KEY", "KAGGLE_KEY", "KAGGLE_USERNAME", "TG_BOT_TOKEN", "TG_CHAT_ID", "TG_ADMIN_ID", "META_TOKEN", "FB_PAGE_ID", "IG_USER_ID", "YT_CLIENT_ID", "YT_CLIENT_SECRET", "YT_REFRESH_TOKEN", "AUTO_PUBLISH_HOURS", "NICHE"];
const SECRET_CFG = new Set(["JOB_TOKEN", "GEMINI_API_KEY", "KAGGLE_KEY", "TG_BOT_TOKEN", "META_TOKEN", "YT_CLIENT_SECRET", "YT_REFRESH_TOKEN"]);
async function applyCfg(env: Env): Promise<Env> {
  try {
    const o = JSON.parse((await env.KV.get("cfg", { cacheTtl: 30 })) || "{}") as Record<string, unknown>;
    const pick = Object.fromEntries(Object.entries(o).filter(([k, v]) => CFG_KEYS.includes(k) && typeof v === "string" && v !== ""));
    return { ...env, ...pick } as Env;
  } catch { return env; }
}
const saveJob = (env: Env, job: Job) => env.KV.put(`job:${job.id}`, JSON.stringify(job), { expirationTtl: 86400 * 14,
  metadata: { c: job.createdAt || Date.now(), s: job.status, t: String(job.title || "").slice(0, 60) } });
function ev(job: Job, m: string) { job.events = job.events || []; job.events.push({ t: Date.now(), m: m.slice(0, 300) }); if (job.events.length > 80) job.events.splice(0, job.events.length - 80); }
async function recentJobs(env: Env, n = 40): Promise<Job[]> {
  const keys = (await env.KV.list({ prefix: "job:" })).keys as { name: string; metadata?: any }[];
  const meta = keys.filter(k => k.metadata?.c).sort((a, b) => b.metadata.c - a.metadata.c).slice(0, n);
  const nometa = keys.filter(k => !k.metadata?.c).slice(0, 30);
  const load = async (k: { name: string }) => JSON.parse((await env.KV.get(k.name)) || "null") as Job | null;
  const old = (await Promise.all(nometa.map(load))).filter(Boolean) as Job[];
  for (const j of old) await saveJob(env, j); // one-time migration: attaches list metadata
  const rest = (await Promise.all(meta.map(load))).filter(Boolean) as Job[];
  return [...old, ...rest].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, n + old.length);
}
async function addLog(env: Env, level: string, text: string) {
  const log = JSON.parse((await env.KV.get("log")) || "[]") as any[];
  log.push({ t: Date.now(), level, text: text.slice(0, 700) });
  await env.KV.put("log", JSON.stringify(log.slice(-200)));
}

// ---------- 1. Script generation (Claude) ----------
const wc = (j: any) => (j.scenes || []).reduce((n: number, s: any) => n + String(s.narration || "").split(/\s+/).filter(Boolean).length, 0);
async function generateJob(env: Env, topic?: string): Promise<Job> {
  const used = JSON.parse((await env.KV.get("topics")) || "[]") as string[];
  const prompt = `Niche: ${env.NICHE}.${topic ? " The video must be about this specific topic: " + topic + "." : ""} Write a 35-45 second vertical-video explainer for children aged 5-9 (exactly 10 scenes, and each scene's narration is TWO full sentences of about 8 words each, around 13 words per scene and 125-135 words in total, so it fills 40 seconds when read aloud. Example narration (do not use quote marks inside narration text): Magnets have an invisible power called magnetism. It pulls some metal things closer, like a tiny hug!). Use simple words, a friendly cheerful narrator, wonder and curiosity. Strictly child-safe: no violence, fear, death, politics, brands or anything unsuitable.
Avoid these used topics: ${used.slice(-60).join("; ") || "none"}.
Start with a fun question or surprise; end with a tiny 'did you know' or a question for kids to ask a grown-up. Strong hook in the first sentence, 10 scenes, accurate facts only.
Titles must describe THIS video's actual content and curiosity gap (no clickbait lies, no emojis).
Return ONLY JSON: {"topic":"","title":"<=70 chars","hook":"2-4 word on-screen title for the first seconds, plain letters only, no emoji, no punctuation except ? or !","keywords":["up to 5 key words that appear in the narration, e.g. animal or science words"],"yt_title":"<=60 chars, specific to the content, curiosity-driven","yt_description":"2-3 friendly sentences summarising what the video teaches, for parents and kids","caption":"1-2 short sentences with one question for kids","hashtags":["4-6 relevant hashtags"],"scenes":[{"narration":"two sentences, 14-18 words","visual_query":"8-15 word description of one simple, cute, child-safe cartoon illustration for this scene, no text in the picture"}]}`;
  let j: any; let gen = "gemini";
  try {
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent", {
        method: "POST", headers: { "x-goog-api-key": env.GEMINI_API_KEY, "content-type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: "application/json", temperature: 0.9, thinkingConfig: { thinkingLevel: "low" } } }),
        signal: AbortSignal.timeout(45000),
      });
      if (!r.ok) throw new Error(`Gemini ${r.status}: ${await r.text()}`);
      const text = ((await r.json()) as any).candidates[0].content.parts[0].text as string;
      j = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
      if (!j.scenes?.length) throw new Error("no scenes");
      if (wc(j) < 110 && attempt < 3) throw new Error("script too short: " + wc(j) + " words");
      break;
    } catch (e: any) { if (attempt >= 3 || /Gemini 429/.test(String(e.message))) throw e; }
  }
  } catch (geminiErr) {
    // Fallback: free Workers AI model
    gen = "llama(" + String((geminiErr as any).message).slice(0, 60) + ")";
    for (let attempt = 1; ; attempt++) {
      try {
        const out = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", { messages: [{ role: "user", content: prompt }], max_tokens: 2800 });
        const text = String(out.choices?.[0]?.message?.content ?? out.response ?? "");
        j = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
        if (!j.scenes?.length) throw new Error("no scenes");
        if (wc(j) < 110 && attempt < 3) throw new Error("script too short: " + wc(j) + " words");
        break;
      } catch (e) { if (attempt >= 3) throw new Error(`Gemini failed (${String((geminiErr as any).message).slice(0, 120)}) and fallback failed: ${e}`); }
    }
  }
  used.push(j.topic); await env.KV.put("topics", JSON.stringify(used.slice(-200)));
  return { id: crypto.randomUUID().slice(0, 8), createdAt: Date.now(), attempts: 0, status: "pending", source: "auto", events: [{ t: Date.now(), m: `Script written (${wc(j)} words, ${(j.scenes || []).length} scenes, ${gen.slice(0, 20)})` }], gen, words: wc(j), title: j.title, hook: String(j.hook || "").slice(0, 40) || undefined, keywords: Array.isArray(j.keywords) ? j.keywords.map(String).slice(0, 8) : [], yt_title: j.yt_title, yt_description: j.yt_description, caption: j.caption, hashtags: j.hashtags, scenes: j.scenes };
}

// ---------- 2. Trigger Kaggle kernel (re-push = new run) ----------
async function pushKaggle(env: Env) {
  const runTok = "rt_" + crypto.randomUUID().replace(/-/g, "");
  await env.KV.put(`run:${runTok}`, "1", { expirationTtl: 3 * 3600 });
  const r = await fetch("https://www.kaggle.com/api/v1/kernels/push", {
    method: "POST",
    headers: { Authorization: env.KAGGLE_KEY.startsWith("KGAT_") ? `Bearer ${env.KAGGLE_KEY}` : "Basic " + btoa(`${env.KAGGLE_USERNAME}:${env.KAGGLE_KEY}`), "content-type": "application/json" },
    body: JSON.stringify({
      slug: `${env.KAGGLE_USERNAME}/${env.KAGGLE_KERNEL_SLUG}`, newTitle: env.KAGGLE_KERNEL_SLUG,
      text: RENDER_PY.replace("__RUN_TOKEN__", runTok).replace("__WORKER_URL__", env.WORKER_URL), language: "python", kernelType: "script",
      isPrivate: true, enableGpu: false, enableInternet: true,
    }),
  });
  const body = await r.text();
  if (!r.ok || /"error"/.test(body) && !/"error":\s*""/.test(body)) throw new Error(`Kaggle push: ${body}`);
}

async function startPipeline(env: Env, stub?: Job, topic?: string) {
  const job = await generateJob(env, topic);
  if (stub) { job.id = stub.id; job.createdAt = stub.createdAt; job.events = [...(stub.events || []), ...(job.events || [])]; }
  ev(job, "Queued for rendering");
  await saveJob(env, job);
  await env.KV.put("queue:pending", job.id);
  try { await pushKaggle(env); ev(job, "Kaggle renderer started"); await saveJob(env, job); }
  catch (e: any) { ev(job, "Kaggle start failed: " + String(e.message).slice(0, 200)); job.status = "failed"; await saveJob(env, job); await notifyAdmin(env, `Could not start Kaggle for "${job.title}": ${String(e.message).slice(0, 300)}`, {}, "error"); throw e; }
  return job;
}

// ---------- 3. Publishing ----------
const tg = async (env: Env, method: string, body: object) =>
  fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function pubTelegram(env: Env, job: Job, url: string) {
  const r = await tg(env, "sendVideo", { chat_id: env.TG_CHAT_ID, video: url, caption: `${job.title}\n\n${job.caption}`.slice(0, 1024), supports_streaming: true });
  if (!r.ok) throw new Error(await r.text()); return "ok";
}
async function pubFacebook(env: Env, job: Job, url: string) {
  const r = await fetch(`https://graph.facebook.com/v21.0/${env.FB_PAGE_ID}/videos`, { method: "POST",
    body: new URLSearchParams({ file_url: url, title: job.title, description: `${job.caption}\n${job.hashtags.map(h => "#" + String(h).replace(/^#/, "")).join(" ")}`, access_token: env.META_TOKEN }) });
  const j = (await r.json()) as any; if (!r.ok) throw new Error(JSON.stringify(j)); return j.id;
}
async function pubInstagram(env: Env, job: Job, url: string) {
  const c = await (await fetch(`https://graph.facebook.com/v21.0/${env.IG_USER_ID}/media`, { method: "POST",
    body: new URLSearchParams({ media_type: "REELS", video_url: url, caption: `${job.caption}\n${job.hashtags.map(h => "#" + String(h).replace(/^#/, "")).join(" ")}`, access_token: env.META_TOKEN }) })).json() as any;
  if (!c.id) throw new Error(JSON.stringify(c));
  for (let i = 0; i < 8; i++) { // poll until container is processed
    await new Promise(r => setTimeout(r, 5000));
    const s = await (await fetch(`https://graph.facebook.com/v21.0/${c.id}?fields=status_code&access_token=${env.META_TOKEN}`)).json() as any;
    if (s.status_code === "FINISHED") break; if (s.status_code === "ERROR") throw new Error("IG processing error");
  }
  const p = await (await fetch(`https://graph.facebook.com/v21.0/${env.IG_USER_ID}/media_publish`, { method: "POST",
    body: new URLSearchParams({ creation_id: c.id, access_token: env.META_TOKEN }) })).json() as any;
  if (!p.id) throw new Error(JSON.stringify(p)); return p.id;
}
async function pubYouTube(env: Env, job: Job, _url: string) {
  const t = await (await fetch("https://oauth2.googleapis.com/token", { method: "POST",
    body: new URLSearchParams({ client_id: env.YT_CLIENT_ID, client_secret: env.YT_CLIENT_SECRET, refresh_token: env.YT_REFRESH_TOKEN, grant_type: "refresh_token" }) })).json() as any;
  const obj = await env.KV.get(`video:${job.id}`, "arrayBuffer"); if (!obj) throw new Error("video missing");
  const init = await fetch("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status", {
    method: "POST", headers: { Authorization: `Bearer ${t.access_token}`, "content-type": "application/json", "X-Upload-Content-Type": "video/mp4" },
    body: JSON.stringify({ snippet: { title: `${(job.yt_title || job.title).slice(0, 88)} #Shorts`.slice(0, 100), description: `${job.yt_description || job.caption}\n\n${job.caption}\n\n${job.hashtags.map(h => "#" + String(h).replace(/^#/, "")).join(" ")} #Shorts`, categoryId: "27" }, status: { privacyStatus: "public", selfDeclaredMadeForKids: true } }) });
  const loc = init.headers.get("location"); if (!loc) throw new Error(await init.text());
  const up = await fetch(loc, { method: "PUT", headers: { "content-type": "video/mp4", "content-length": String(obj.byteLength) }, body: obj });
  const j = (await up.json()) as any; if (!up.ok) throw new Error(JSON.stringify(j)); return j.id;
}

async function publishOne(env: Env, job: Job, platform: string) {
  const url = `${env.WORKER_URL}/v/${job.id}.mp4`;
  const fns: Record<string, () => Promise<string>> = {
    telegram: () => pubTelegram(env, job, url), youtube: () => pubYouTube(env, job, url),
    facebook: () => pubFacebook(env, job, url), instagram: () => pubInstagram(env, job, url) };
  job.results = job.results || {};
  try { job.results[platform] = "ok:" + await fns[platform](); } catch (e: any) { job.results[platform] = "ERR:" + String(e.message).slice(0, 300); }
  await saveJob(env, job);
  return job.results[platform];
}
const configured = (env: Env, p: string) => ({
  telegram: !!env.TG_CHAT_ID, youtube: !!(env.YT_CLIENT_ID && env.YT_CLIENT_SECRET && env.YT_REFRESH_TOKEN),
  facebook: !!(env.META_TOKEN && env.FB_PAGE_ID), instagram: !!(env.META_TOKEN && env.IG_USER_ID) } as Record<string, boolean>)[p];

async function notifyAdmin(env: Env, text: string, extra: object = {}, level?: string) {
  await addLog(env, level || (/FAILED|ERR:|failed|rejected/.test(text) ? "error" : /\u26a0/.test(text) ? "warn" : "info"), text).catch(() => {});
  if (!env.TG_ADMIN_ID) return;
  await tg(env, "sendMessage", { chat_id: env.TG_ADMIN_ID, text, ...extra });
}

async function sendForReview(env: Env, job: Job) {
  if (!env.TG_ADMIN_ID) throw new Error("TG_ADMIN_ID not set");
  job.status = "review"; ev(job, "Video ready; sent to you for review"); await saveJob(env, job);
  const r = await tg(env, "sendVideo", { chat_id: env.TG_ADMIN_ID, video: `${env.WORKER_URL}/v/${job.id}.mp4`, supports_streaming: true,
    caption: `REVIEW: ${job.title}\n\n${job.caption}\n${job.hashtags.join(" ")}`.slice(0, 1024),
    reply_markup: { inline_keyboard: [[{ text: "✅ Approve & publish", callback_data: `a:${job.id}` }, { text: "❌ Reject", callback_data: `r:${job.id}` }]] } });
  if (!r.ok) throw new Error(await r.text());
}

async function approveAndPublish(env: Env, job: Job, platforms?: string[]) {
  const list = platforms?.length ? platforms : ["telegram", "youtube", "facebook", "instagram"];
  job.status = "publishing"; ev(job, "Publishing to " + list.join(", ")); await saveJob(env, job);
  const skipped: string[] = [];
  for (const pf of list) {
    if (!configured(env, pf)) { skipped.push(pf); continue; }
    await publishOne(env, job, pf); ev(job, `${pf}: ${job.results?.[pf]}`); await saveJob(env, job);
  }
  job.status = "published"; ev(job, "Done"); await saveJob(env, job);
  const bad = Object.values(job.results || {}).some(v => String(v).startsWith("ERR"));
  await notifyAdmin(env, `Published "${job.title}"\n` + Object.entries(job.results || {}).map(([k, v]) => `${k}: ${v}`).join("\n") + (skipped.length ? `\nnot configured: ${skipped.join(", ")}` : ""), {}, bad ? "error" : "info");
}

async function handleTelegramUpdate(env: Env, upd: any) {
  const cb = upd.callback_query; if (!cb) return;
  if (String(cb.from?.id) !== String(env.TG_ADMIN_ID)) { await tg(env, "answerCallbackQuery", { callback_query_id: cb.id, text: "Not allowed" }); return; }
  const [act, id] = String(cb.data).split(":");
  const raw = await env.KV.get(`job:${id}`); const job = raw ? (JSON.parse(raw) as Job) : null;
  if (!job || job.status !== "review") { await tg(env, "answerCallbackQuery", { callback_query_id: cb.id, text: "Already handled or expired" }); return; }
  const clear = () => tg(env, "editMessageReplyMarkup", { chat_id: cb.message.chat.id, message_id: cb.message.message_id, reply_markup: { inline_keyboard: [] } });
  if (act === "r") {
    job.status = "rejected"; ev(job, "Rejected in Telegram"); await saveJob(env, job); await env.KV.delete(`video:${id}`);
    await tg(env, "answerCallbackQuery", { callback_query_id: cb.id, text: "Rejected" }); await clear(); return;
  }
  await tg(env, "answerCallbackQuery", { callback_query_id: cb.id, text: "Publishing..." }); await clear();
  await approveAndPublish(env, job);
}


// ---------- Auto-publish (opt-in: AUTO_PUBLISH_HOURS > 0) ----------
const PLATFORMS = ["telegram", "youtube", "facebook", "instagram"];
async function autoPublish(env: Env) {
  const hours = Number((env as any).AUTO_PUBLISH_HOURS ?? 0);
  for (const j of await recentJobs(env, 40)) {
    if (["writing", "pending", "rendering", "uploading"].includes(j.status) && Date.now() - (j.createdAt || 0) > 6 * 3600e3) { // janitor: expire jobs that never finished
      j.status = "failed"; ev(j, "Timed out after 6 hours"); await saveJob(env, j); continue;
    }
    if (j.status === "publishing" && Date.now() - ((j.events || []).slice(-1)[0]?.t || j.createdAt || 0) > 4 * 60e3) { // resume an interrupted publish
      const todo = PLATFORMS.filter(pf => configured(env, pf) && !String(j.results?.[pf] || "").startsWith("ok:"));
      await notifyAdmin(env, `Resuming interrupted publish of "${j.title}" (${todo.join(", ") || "nothing left"}).`);
      await approveAndPublish(env, j, todo.length ? todo : undefined); break;
    }
    if (!(hours > 0) || j.status !== "review" || Date.now() - (j.createdAt || 0) < hours * 3600e3) continue;
    await notifyAdmin(env, `Auto-publishing "${j.title}": no decision after ${hours}h.`);
    await approveAndPublish(env, j);
    break; // one per run keeps each run short
  }
}

// ---------- Daily health check ----------
async function healthCheck(env: Env): Promise<{ text: string; issues: string[]; info: string[] }> {
  const now = Date.now(), H = 3600e3, issues: string[] = [], info: string[] = [];
  const jobs = await recentJobs(env, 60);
  const day = jobs.filter(j => now - (j.createdAt || 0) < 24 * H);
  const by: Record<string, number> = {}; for (const j of day) by[j.status] = (by[j.status] || 0) + 1;
  info.push(`Last 24h: ${day.length} video(s)` + (day.length ? " (" + Object.entries(by).map(([k, v]) => `${v} ${k}`).join(", ") + ")" : ""));
  if (!day.length) issues.push("No video was created in the last 24h (cron or script generation problem).");
  for (const j of day) {
    const age = now - (j.claimedAt || j.createdAt || 0);
    if (j.status === "failed") issues.push(`Failed: "${j.title}" (${j.id})`);
    else if (j.status === "pending" && now - (j.createdAt || 0) > 0.5 * H) issues.push(`Not picked up by Kaggle for 30+ min: "${j.title}" (${j.id})`);
    else if (j.status === "rendering" && age > 0.75 * H) issues.push(`Rendering for 45+ min (stuck?): "${j.title}" (${j.id})`);
    else if (j.status === "review" && now - (j.createdAt || 0) > 12 * H) issues.push(`Waiting for your approval 12h+: "${j.title}"`);
  }
  if (env.YT_REFRESH_TOKEN) {
    try {
      const t = await (await fetch("https://oauth2.googleapis.com/token", { method: "POST", body: new URLSearchParams({
        client_id: env.YT_CLIENT_ID, client_secret: env.YT_CLIENT_SECRET, refresh_token: env.YT_REFRESH_TOKEN, grant_type: "refresh_token" }) })).json() as any;
      if (!t.access_token) issues.push(`YouTube token rejected (${t.error || "unknown"}). Re-run tools/yt_auth.py.`);
      else info.push("YouTube token: valid");
    } catch (e) { issues.push(`YouTube check failed: ${e}`); }
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(env.YT_REFRESH_TOKEN)))).slice(0, 6).map(b => b.toString(16).padStart(2, "0")).join("");
    let rec = JSON.parse((await env.KV.get("yt:tok")) || "null") as { h: string; at: number } | null;
    if (!rec || rec.h !== hash) { rec = { h: hash, at: now }; await env.KV.put("yt:tok", JSON.stringify(rec)); }
    const maxDays = Number((env as any).YT_TOKEN_MAX_DAYS ?? 7), ageD = (now - rec.at) / (24 * H);
    if (maxDays > 0) {
      info.push(`YouTube token age: ${ageD.toFixed(1)}d of ${maxDays}d`);
      if (ageD >= maxDays - 2) issues.push(`YouTube token is ${ageD.toFixed(1)} days old and expires after ${maxDays} (Testing mode). Re-run tools/yt_auth.py, or publish the Google consent screen.`);
    }
  }
  if (env.META_TOKEN) {
    try {
      const m = await (await fetch(`https://graph.facebook.com/v21.0/me?access_token=${encodeURIComponent(env.META_TOKEN)}`)).json() as any;
      if (!m.id) issues.push(`Meta token rejected: ${String(m.error?.message || "unknown").slice(0, 120)}`); else info.push("Meta token: valid");
    } catch (e) { issues.push(`Meta check failed: ${e}`); }
  }
  const text = (issues.length ? "\u26a0\ufe0f Daily health check: attention needed\n\n" + issues.map(i => "- " + i).join("\n") + "\n\n" : "\u2705 Daily health check: all good\n\n") + info.join("\n");
  await env.KV.put("health:last", JSON.stringify({ t: now, issues, info }));
  await notifyAdmin(env, text, {}, issues.length ? "warn" : "info");
  return { text, issues, info };
}

// ---------- 4. Stats collection (reach / likes / comments) ----------
const enc = encodeURIComponent;
const idOf = (v?: string) => (v && String(v).startsWith("ok:") ? String(v).slice(3) : "");
async function ytAccess(env: Env): Promise<{ token?: string; scope?: string; error?: string }> {
  const t = await (await fetch("https://oauth2.googleapis.com/token", { method: "POST", body: new URLSearchParams({
    client_id: env.YT_CLIENT_ID, client_secret: env.YT_CLIENT_SECRET, refresh_token: env.YT_REFRESH_TOKEN, grant_type: "refresh_token" }) })).json() as any;
  return t.access_token ? { token: t.access_token, scope: t.scope } : { error: t.error || "unknown" };
}
async function collectStats(env: Env) {
  const out: any = { t: Date.now(), channel: {}, videos: {}, errors: {} };
  const gj = async (url: string, headers?: Record<string, string>) => (await fetch(url, { headers })).json() as Promise<any>;
  const G = "https://graph.facebook.com/v21.0";
  try { if (env.TG_BOT_TOKEN && env.TG_CHAT_ID) { const r = await (await tg(env, "getChatMemberCount", { chat_id: env.TG_CHAT_ID })).json() as any; if (r.ok) out.channel.telegram = { followers: r.result }; else out.errors.telegram = r.description; } } catch (e) { out.errors.telegram = String(e).slice(0, 150); }
  if (env.META_TOKEN && env.FB_PAGE_ID) try { const r = await gj(`${G}/${env.FB_PAGE_ID}?fields=followers_count,fan_count&access_token=${enc(env.META_TOKEN)}`); if (r.error) out.errors.facebook = r.error.message; else out.channel.facebook = { followers: r.followers_count ?? r.fan_count }; } catch (e) { out.errors.facebook = String(e).slice(0, 150); }
  if (env.META_TOKEN && env.IG_USER_ID) try { const r = await gj(`${G}/${env.IG_USER_ID}?fields=followers_count,media_count&access_token=${enc(env.META_TOKEN)}`); if (r.error) out.errors.instagram = r.error.message; else out.channel.instagram = { followers: r.followers_count, posts: r.media_count }; } catch (e) { out.errors.instagram = String(e).slice(0, 150); }
  const jobs = (await recentJobs(env, 40)).filter(j => j.status === "published" && Date.now() - (j.createdAt || 0) < 45 * 86400e3);
  const yt = env.YT_REFRESH_TOKEN && env.YT_CLIENT_ID ? await ytAccess(env) : null;
  if (yt?.token) {
    const H = { Authorization: `Bearer ${yt.token}` };
    try {
      const c = await gj("https://www.googleapis.com/youtube/v3/channels?part=statistics&mine=true", H);
      if (c.error) out.errors.youtube = c.error.code === 403 ? "Needs the youtube.readonly permission. Re-run tools/yt_auth.py." : c.error.message;
      else if (c.items?.[0]) out.channel.youtube = { followers: Number(c.items[0].statistics.subscriberCount), views: Number(c.items[0].statistics.viewCount), posts: Number(c.items[0].statistics.videoCount) };
      const ids = jobs.map(j => idOf(j.results?.youtube)).filter(Boolean).slice(0, 50);
      if (ids.length && !c.error) {
        const v = await gj(`https://www.googleapis.com/youtube/v3/videos?part=statistics,status&id=${ids.join(",")}`, H);
        for (const it of v.items || []) { const j = jobs.find(x => idOf(x.results?.youtube) === it.id); if (j) (out.videos[j.id] = out.videos[j.id] || {}).youtube = { views: Number(it.statistics.viewCount || 0), likes: Number(it.statistics.likeCount || 0), comments: Number(it.statistics.commentCount || 0), privacy: it.status?.privacyStatus }; }
      }
    } catch (e) { out.errors.youtube = String(e).slice(0, 150); }
  } else if (yt?.error) out.errors.youtube = "YouTube token rejected: " + yt.error;
  for (const j of jobs) {
    const rec = (out.videos[j.id] = out.videos[j.id] || {});
    const fb = idOf(j.results?.facebook), ig = idOf(j.results?.instagram);
    if (fb && env.META_TOKEN) try {
      const r = await gj(`${G}/${fb}?fields=likes.summary(true),comments.summary(true),permalink_url&access_token=${enc(env.META_TOKEN)}`);
      if (!r.error) rec.facebook = { likes: r.likes?.summary?.total_count ?? 0, comments: r.comments?.summary?.total_count ?? 0, link: r.permalink_url ? "https://facebook.com" + r.permalink_url : undefined };
      const v = await gj(`${G}/${fb}?fields=views&access_token=${enc(env.META_TOKEN)}`); if (!v.error && v.views != null) (rec.facebook = rec.facebook || {}).views = v.views;
    } catch { /* ignore */ }
    if (ig && env.META_TOKEN) try {
      const r = await gj(`${G}/${ig}?fields=like_count,comments_count,permalink&access_token=${enc(env.META_TOKEN)}`);
      if (!r.error) rec.instagram = { likes: r.like_count ?? 0, comments: r.comments_count ?? 0, link: r.permalink };
      const i = await gj(`${G}/${ig}/insights?metric=reach,views&access_token=${enc(env.META_TOKEN)}`);
      if (!i.error) for (const d of i.data || []) { rec.instagram = rec.instagram || {}; if (d.name === "reach") rec.instagram.reach = d.values?.[0]?.value; if (d.name === "views") rec.instagram.views = d.values?.[0]?.value; }
      else if (/permission|OAuth/i.test(i.error.message || "")) out.errors.instagram_insights = "Reach needs the instagram_manage_insights permission on the Meta token.";
    } catch { /* ignore */ }
  }
  await env.KV.put("stats", JSON.stringify(out));
  const tot = { views: 0, likes: 0, comments: 0 };
  for (const r of Object.values(out.videos) as any[]) for (const pl of Object.values(r) as any[]) { tot.views += pl.views || 0; tot.likes += pl.likes || 0; tot.comments += pl.comments || 0; }
  const hist = JSON.parse((await env.KV.get("stats:hist")) || "[]") as any[];
  hist.push({ t: out.t, ...tot, followers: Object.values(out.channel).reduce((n: number, c: any) => n + (c.followers || 0), 0) });
  await env.KV.put("stats:hist", JSON.stringify(hist.slice(-120)));
  return out;
}

// ---------- 5. Dashboard API ----------
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS", "access-control-max-age": "86400" };
const jr = (o: any, status = 200) => Response.json(o, { status, headers: CORS });
const brief = (j: Job) => ({ id: j.id, title: j.title, status: j.status, source: j.source || "auto", createdAt: j.createdAt, words: j.words ?? wc(j), scenes: j.scenes?.length || 0, gen: j.gen, hook: j.hook, caption: j.caption, hashtags: j.hashtags, results: j.results || {}, progress: j.progress, events: (j.events || []).slice(-14) });

function computeAlerts(env: Env, jobs: Job[], health: any, stats: any, dismissed: string[]) {
  const A: any[] = [], now = Date.now();
  const add = (level: string, key: string, title: string, detail: string, action?: any) => { if (!dismissed.includes(key)) A.push({ level, key, title, detail, action }); };
  for (const j of jobs) {
    const last = (j.events || []).slice(-1)[0]?.m || "";
    if (j.status === "failed" && now - (j.createdAt || 0) < 48 * 3600e3) add("high", `failed:${j.id}`, `Render failed: ${j.title}`, last || "The video could not be produced.", { type: "requeue", jobId: j.id, label: "Retry render" });
    if (j.status === "pending" && now - (j.createdAt || 0) > 30 * 60e3 && now - (j.createdAt || 0) < 6 * 3600e3) add("high", `stuck:${j.id}`, `Not picked up by Kaggle: ${j.title}`, "Pending for more than 30 minutes. Kaggle may be blocked or out of quota.", { type: "requeue", jobId: j.id, label: "Retry render" });
    if (j.status === "rendering" && now - (j.claimedAt || j.createdAt || 0) > 45 * 60e3 && now - (j.createdAt || 0) < 6 * 3600e3) add("high", `slow:${j.id}`, `Render taking too long: ${j.title}`, "Rendering for 45+ minutes.", { type: "requeue", jobId: j.id, label: "Retry render" });
    if (j.status === "review") { const h = Number((env as any).AUTO_PUBLISH_HOURS || 0); add("medium", `review:${j.id}`, `Waiting for your decision: ${j.title}`, h > 0 ? `Will auto-publish ${h}h after creation unless you reject it.` : "Approve or reject it.", { type: "open", jobId: j.id, label: "Review" }); }
    for (const [pf, v] of Object.entries(j.results || {})) if (String(v).startsWith("ERR") && now - (j.createdAt || 0) < 72 * 3600e3) add("high", `puberr:${j.id}:${pf}`, `Publishing to ${pf} failed: ${j.title}`, String(v).slice(4, 260), { type: "retry-publish", jobId: j.id, platform: pf, label: "Retry " + pf });
  }
  if (jobs.length && !jobs.some(j => now - (j.createdAt || 0) < 24 * 3600e3)) add("high", "nojob24", "No video created in the last 24 hours", "The schedule or script generation may be failing. Check the log below.", { type: "run", label: "Create one now" });
  for (const pf of PLATFORMS) if (!configured(env, pf)) add("medium", `cfg:${pf}`, `${pf[0].toUpperCase() + pf.slice(1)} is not configured`, "Publishing there is skipped until credentials are added.", { type: "settings", label: "Open Settings" });
  if (!health || now - health.t > 30 * 3600e3) add("medium", "healthstale", "Daily health check has not run", "It should run every day at 03:30 UTC.", { type: "health", label: "Run it now" });
  for (const i of health?.issues || []) if (!/^Failed:|^Waiting for your approval|^Not picked up|^Rendering for/.test(i)) add(/rejected|invalid/i.test(i) ? "high" : "medium", "health:" + i.slice(0, 50), i, undefined);
  for (const [k, v] of Object.entries(stats?.errors || {})) add("low", `stats:${k}`, `Insights unavailable for ${k}`, String(v), { type: "settings", label: "Open Settings" });
  const rank: Record<string, number> = { high: 0, medium: 1, low: 2 };
  return A.sort((a, b) => rank[a.level] - rank[b.level]);
}

async function apiState(env: Env) {
  const jobs = await recentJobs(env, 40);
  const [stats, hist, health, log, dismissed, cfgRaw] = await Promise.all(["stats", "stats:hist", "health:last", "log", "dismissed", "cfg"].map(k => env.KV.get(k)));
  const st = stats ? JSON.parse(stats) : null, hl = health ? JSON.parse(health) : null;
  return {
    now: Date.now(), jobs: jobs.map(brief), stats: st, history: hist ? JSON.parse(hist) : [], health: hl,
    log: (log ? JSON.parse(log) : []).slice(-80).reverse(),
    alerts: computeAlerts(env, jobs, hl, st, dismissed ? JSON.parse(dismissed) : []),
    platforms: Object.fromEntries(PLATFORMS.map(p => [p, configured(env, p)])),
    settings: { autoPublishHours: Number((env as any).AUTO_PUBLISH_HOURS || 0), niche: env.NICHE, crons: { videos: "06:00, 12:00, 18:00 UTC", health: "03:30 UTC daily", stats: "every 6 hours", autopublish: "every 30 minutes" }, overridden: Object.keys(cfgRaw ? JSON.parse(cfgRaw) : {}) },
  };
}

async function requeueJob(env: Env, id: string) {
  const job = JSON.parse((await env.KV.get(`job:${id}`)) || "null") as Job | null; if (!job) throw new Error("no job");
  job.status = "pending"; job.createdAt = Date.now(); job.attempts = 0; ev(job, "Retry requested"); await saveJob(env, job);
  await env.KV.put("queue:pending", job.id); await pushKaggle(env); return job;
}

async function testTarget(env: Env, target: string): Promise<{ ok: boolean; detail: string }> {
  try {
    if (target === "youtube") { const r = await ytAccess(env); return r.token ? { ok: true, detail: "Token valid. Permissions: " + String(r.scope || "").replace(/https:\/\/www\.googleapis\.com\/auth\//g, "").split(" ").join(", ") } : { ok: false, detail: "Rejected: " + r.error }; }
    if (target === "meta") { const m = await (await fetch(`https://graph.facebook.com/v21.0/me?access_token=${enc(env.META_TOKEN)}`)).json() as any; return m.id ? { ok: true, detail: "Valid for: " + m.name } : { ok: false, detail: String(m.error?.message || "rejected") }; }
    if (target === "telegram") { const m = await (await tg(env, "getMe", {})).json() as any; return m.ok ? { ok: true, detail: "Bot @" + m.result.username } : { ok: false, detail: String(m.description) }; }
    if (target === "gemini") { const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1", { headers: { "x-goog-api-key": env.GEMINI_API_KEY } }); return r.ok ? { ok: true, detail: "Key accepted" } : { ok: false, detail: "HTTP " + r.status }; }
    if (target === "kaggle") { const r = await fetch(`https://www.kaggle.com/api/v1/kernels/status?userName=${enc(env.KAGGLE_USERNAME)}&kernelSlug=${enc(env.KAGGLE_KERNEL_SLUG)}`, { headers: { Authorization: env.KAGGLE_KEY.startsWith("KGAT_") ? `Bearer ${env.KAGGLE_KEY}` : "Basic " + btoa(`${env.KAGGLE_USERNAME}:${env.KAGGLE_KEY}`) } }); const t = await r.text(); return r.ok ? { ok: true, detail: "Renderer status: " + t.slice(0, 120) } : { ok: false, detail: "HTTP " + r.status }; }
    return { ok: false, detail: "unknown target" };
  } catch (e: any) { return { ok: false, detail: String(e.message || e).slice(0, 200) }; }
}

const cfgItems = (env: any, raw: Record<string, string>) => CFG_KEYS.map(k => { const v = String(env[k] ?? ""); return { name: k, secret: SECRET_CFG.has(k), set: !!v, source: raw[k] ? "dashboard" : v ? "deployment" : "unset", display: !v ? "" : SECRET_CFG.has(k) ? "\u2022\u2022\u2022\u2022" + v.slice(-4) : v }; });
async function handleApi(req: Request, env: Env, ctx: ExecutionContext, u: URL, base: Env): Promise<Response> {
  const p = u.pathname.slice(5), m = req.method;
  if (p === "state" && m === "GET") return jr(await apiState(env));
  if (p === "run" && m === "POST") {
    const body = (await req.json().catch(() => ({}))) as any; const topic = String(body.topic || "").slice(0, 200) || undefined;
    const stub: Job = { id: crypto.randomUUID().slice(0, 8), createdAt: Date.now(), status: "writing", source: "auto", title: topic ? `Writing: ${topic}` : "Writing script...", caption: "", hashtags: [], scenes: [], events: [{ t: Date.now(), m: "Started from the dashboard" + (topic ? ` (topic: ${topic})` : "") }] };
    await saveJob(env, stub);
    ctx.waitUntil(startPipeline(env, stub, topic).catch(async e => { stub.status = "failed"; ev(stub, "Failed: " + String(e.message).slice(0, 250)); await saveJob(env, stub); await notifyAdmin(env, `⚠️ Could not create a video: ${String(e.message).slice(0, 300)}`, {}, "error"); }));
    return jr({ ok: true, id: stub.id });
  }
  let x: RegExpMatchArray | null;
  if ((x = p.match(/^job\/(\w+)$/)) && m === "GET") { const j = JSON.parse((await env.KV.get(`job:${x[1]}`)) || "null") as Job | null; return j ? jr({ ...j, video: !!(await env.KV.get(`video:${j.id}`, "arrayBuffer")) }) : jr({ error: "no job" }, 404); }
  if ((x = p.match(/^job\/(\w+)\/(approve|reject|requeue)$/)) && m === "POST") {
    const job = JSON.parse((await env.KV.get(`job:${x[1]}`)) || "null") as Job | null; if (!job) return jr({ error: "no job" }, 404);
    if (x[2] === "requeue") { try { await requeueJob(env, job.id); return jr({ ok: true }); } catch (e: any) { return jr({ ok: false, error: String(e.message).slice(0, 300) }, 500); } }
    if (job.status !== "review") return jr({ ok: false, error: "Only videos in review can be approved or rejected." }, 409);
    if (x[2] === "reject") { job.status = "rejected"; ev(job, "Rejected in the dashboard"); await saveJob(env, job); await env.KV.delete(`video:${job.id}`); return jr({ ok: true }); }
    const body = (await req.json().catch(() => ({}))) as any;
    const pr = approveAndPublish(env, job, Array.isArray(body.platforms) ? body.platforms.filter((q: string) => PLATFORMS.includes(q)) : undefined);
    ctx.waitUntil(pr.catch(async e => { await notifyAdmin(env, `⚠️ Publishing "${job.title}" failed: ${String(e.message).slice(0, 300)}`, {}, "error"); }));
    await Promise.race([pr.catch(() => {}), new Promise(r => setTimeout(r, 25000))]);
    return jr({ ok: true });
  }
  if ((x = p.match(/^job\/(\w+)\/publish\/(telegram|youtube|facebook|instagram)$/)) && m === "POST") {
    const job = JSON.parse((await env.KV.get(`job:${x[1]}`)) || "null") as Job | null; if (!job) return jr({ error: "no job" }, 404);
    const r = await publishOne(env, job, x[2]); ev(job, `${x[2]}: ${r}`); await saveJob(env, job); return jr({ ok: String(r).startsWith("ok:"), result: r });
  }
  if (p === "manual" && m === "POST") {
    const b = (await req.json()) as any; const title = String(b.title || "").trim().slice(0, 100); if (!title) return jr({ error: "title required" }, 400);
    const tags = String(b.hashtags || "").split(/[\s,]+/).filter(Boolean).slice(0, 15);
    const job: Job = { id: crypto.randomUUID().slice(0, 8), createdAt: Date.now(), status: "uploading", source: "manual", title, caption: String(b.caption || "").slice(0, 1500), hashtags: tags, yt_title: String(b.yt_title || "").slice(0, 100) || undefined, yt_description: String(b.yt_description || "").slice(0, 4000) || undefined, scenes: [], words: 0, events: [{ t: Date.now(), m: "Manual upload started" }] };
    await saveJob(env, job); return jr({ ok: true, id: job.id });
  }
  if ((x = p.match(/^manual\/(\w+)\/video$/)) && m === "PUT") {
    const job = JSON.parse((await env.KV.get(`job:${x[1]}`)) || "null") as Job | null; if (!job || job.source !== "manual") return jr({ error: "no job" }, 404);
    const buf = await req.arrayBuffer(); if (buf.byteLength > 20 * 1048576) return jr({ error: "Video is larger than 20 MB (Telegram's limit for URL uploads). Compress it first." }, 413);
    if (buf.byteLength < 1000) return jr({ error: "File looks empty." }, 400);
    await env.KV.put(`video:${job.id}`, buf, { expirationTtl: 86400 * 3 }); job.status = "review"; ev(job, `Video uploaded (${(buf.byteLength / 1048576).toFixed(1)} MB)`); await saveJob(env, job); return jr({ ok: true });
  }
  if ((x = p.match(/^manual\/(\w+)\/publish$/)) && m === "POST") {
    const job = JSON.parse((await env.KV.get(`job:${x[1]}`)) || "null") as Job | null; if (!job || job.source !== "manual" || job.status !== "review") return jr({ error: "Upload the video first." }, 409);
    const body = (await req.json().catch(() => ({}))) as any;
    const pr = approveAndPublish(env, job, Array.isArray(body.platforms) ? body.platforms.filter((q: string) => PLATFORMS.includes(q)) : undefined);
    ctx.waitUntil(pr.catch(async e => { await notifyAdmin(env, `⚠️ Publishing "${job.title}" failed: ${String(e.message).slice(0, 300)}`, {}, "error"); }));
    await Promise.race([pr.catch(() => {}), new Promise(r => setTimeout(r, 25000))]);
    return jr({ ok: true, id: job.id });
  }
  if (p === "config" && m === "GET") {
    const raw = JSON.parse((await env.KV.get("cfg", { cacheTtl: 30 })) || "{}") as Record<string, string>;
    return jr({ items: cfgItems(env, raw) });
  }
  if (p === "config" && m === "POST") {
    const b = (await req.json()) as { values: Record<string, string> };
    const raw = JSON.parse((await env.KV.get("cfg")) || "{}") as Record<string, string>, changed: string[] = [];
    for (const [k, v0] of Object.entries(b.values || {})) {
      if (!CFG_KEYS.includes(k)) return jr({ error: "unknown setting " + k }, 400);
      const v = String(v0).trim();
      if (k === "JOB_TOKEN" && v && !/^[A-Za-z0-9_-]{24,200}$/.test(v)) return jr({ error: "JOB_TOKEN must be 24-200 characters: letters, digits, _ or -." }, 400);
      if (v) raw[k] = v; else delete raw[k]; changed.push(k);
    }
    await env.KV.put("cfg", JSON.stringify(raw));
    const env2 = { ...env, ...raw } as Env; let webhook = "";
    if (changed.includes("JOB_TOKEN") || changed.includes("TG_BOT_TOKEN")) { try { webhook = await (await tg(env2, "setWebhook", { url: `${env2.WORKER_URL}/tg`, secret_token: env2.JOB_TOKEN, allowed_updates: ["callback_query"] })).text(); } catch (e) { webhook = String(e).slice(0, 100); } }
    await addLog(env, "info", "Settings changed: " + changed.join(", "));
    const after = { ...base, ...Object.fromEntries(Object.entries(raw).filter(([k, v]) => CFG_KEYS.includes(k) && v)) };
    return jr({ ok: true, changed, webhook: webhook ? webhook.slice(0, 120) : undefined, items: cfgItems(after, raw), note: "Active everywhere within about a minute." });
  }
  if ((x = p.match(/^test\/(youtube|meta|telegram|gemini|kaggle)$/)) && m === "POST") return jr(await testTarget(env, x[1]));
  if (p === "health" && m === "POST") { const h = await healthCheck(env); return jr({ ok: true, issues: h.issues, info: h.info }); }
  if (p === "stats/refresh" && m === "POST") { try { await collectStats(env); return jr({ ok: true }); } catch (e: any) { return jr({ ok: false, error: String(e.message).slice(0, 300) }, 500); } }
  if (p === "alerts/dismiss" && m === "POST") { const b = (await req.json()) as any; const d = JSON.parse((await env.KV.get("dismissed")) || "[]") as string[]; d.push(String(b.key)); await env.KV.put("dismissed", JSON.stringify(d.slice(-300))); return jr({ ok: true }); }
  if (p === "log/clear" && m === "POST") { await env.KV.put("log", "[]"); return jr({ ok: true }); }
  return jr({ error: "not found" }, 404);
}

// ---------- 6. HTTP (Kaggle <-> Worker, dashboard) + cron ----------
const RUN_PATHS = /^\/(job\/next|image|upload\/\w+|fail\/\w+|progress\/\w+|publish\/\w+\/review)$/;
async function authLevel(req: Request, env: Env, path: string): Promise<"admin" | "run" | null> {
  const b = (req.headers.get("authorization") || "").replace(/^Bearer /, "");
  if (env.JOB_TOKEN && b === env.JOB_TOKEN) return "admin";
  if (b.startsWith("rt_") && RUN_PATHS.test(path) && await env.KV.get(`run:${b}`)) return "run";
  return null;
}

export default {
  async scheduled(e: ScheduledEvent, env0: Env, ctx: ExecutionContext) {
    const env = await applyCfg(env0);
    const run = async () => {
      if (e.cron === "30 3 * * *") await healthCheck(env);
      else if (e.cron === "*/30 * * * *") await autoPublish(env);
      else if (e.cron === "15 */6 * * *") await collectStats(env);
      else await startPipeline(env);
    };
    ctx.waitUntil(run().catch(async err => { await notifyAdmin(env, `⚠️ Scheduled task failed (${e.cron}): ${String(err).slice(0, 400)}`, {}, "error").catch(() => {}); }));
  },
  async fetch(req: Request, env0: Env, ctx: ExecutionContext): Promise<Response> {
    const env = await applyCfg(env0);
    const u = new URL(req.url);
    if (req.method === "GET" && (u.pathname === "/" || u.pathname === "/privacy" || u.pathname === "/terms")) {
      const page = (title: string, body: string) => new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body style="font-family:system-ui,sans-serif;max-width:680px;margin:40px auto;padding:0 16px;line-height:1.55"><h1>${title}</h1>${body}`, { headers: { "content-type": "text/html; charset=utf-8" } });
      if (u.pathname === "/privacy") return page("TFK Toons4kids - Privacy Policy", "<p>TFK Toons4kids is a small educational cartoon channel for children. This app is used only by the channel owner to upload the channel's own videos to its own YouTube channel, Facebook Page, Instagram account and Telegram channel.</p><p><b>Data we access:</b> the app asks for permission only to upload videos to the owner's YouTube channel (the youtube.upload scope). It does not read, collect, store or share any personal data of viewers or any other users.</p><p><b>Credentials:</b> access tokens are stored as encrypted secrets in the owner's own Cloudflare account and are never shared with third parties.</p><p>Use of YouTube data is subject to the <a href=\"https://www.youtube.com/t/terms\">YouTube Terms of Service</a> and the <a href=\"https://policies.google.com/privacy\">Google Privacy Policy</a>. Videos are made for kids and are marked accordingly.</p><p>Questions: please contact us through the TFK Toons4kids channel.</p>");
      if (u.pathname === "/terms") return page("TFK Toons4kids - Terms of Service", "<p>This application is a private tool operated by the TFK Toons4kids channel owner to publish the channel's own educational videos. It is not offered to the public and has no user accounts. Content is provided as is, for children's education and entertainment.</p>");
      return page("TFK Toons4kids", "<p>Fun science, animals, space and nature facts for kids, in short videos.</p><p>This site belongs to the TFK Toons4kids channel. <a href=\"/privacy\">Privacy Policy</a> &middot; <a href=\"/terms\">Terms of Service</a></p>");
    }
    const v = u.pathname.match(/^\/v\/(\w+)\.mp4$/);
    if (v) { const b = await env.KV.get(`video:${v[1]}`, "arrayBuffer"); return b ? new Response(b, { headers: { "content-type": "video/mp4", "content-length": String(b.byteLength) } }) : new Response("gone", { status: 404 }); }
    if (u.pathname === "/tg" && req.method === "POST") {
      if (!env.JOB_TOKEN || req.headers.get("x-telegram-bot-api-secret-token") !== env.JOB_TOKEN) return new Response("forbidden", { status: 403 });
      try { await handleTelegramUpdate(env, await req.json()); } catch (e) { console.log("tg update error", String(e)); }
      return new Response("ok");
    }
    if (req.method === "OPTIONS" && u.pathname.startsWith("/api/")) return new Response(null, { status: 204, headers: CORS });
    const lvl = await authLevel(req, env, u.pathname);
    if (!lvl) return u.pathname.startsWith("/api/") ? jr({ error: "unauthorized" }, 401) : new Response("unauthorized", { status: 401 });
    if (u.pathname.startsWith("/api/")) {
      try { return await handleApi(req, env, ctx, u, env0); } catch (e: any) { return jr({ error: String(e.message || e).slice(0, 300) }, 500); }
    }
    if (u.pathname === "/test/telegram") { const r = await tg(env, "sendMessage", { chat_id: env.TG_CHAT_ID, text: "Setup test: the publisher bot is connected." }); return new Response(await r.text(), { status: r.status }); }
    if (u.pathname === "/image" && req.method === "POST") {
      const { prompt } = (await req.json()) as { prompt: string };
      const out = await env.AI.run("@cf/black-forest-labs/flux-1-schnell", { prompt: String(prompt).slice(0, 1000), steps: 4 });
      const bin = Uint8Array.from(atob(out.image), c => c.charCodeAt(0));
      return new Response(bin, { headers: { "content-type": "image/jpeg" } });
    }
    if (u.pathname === "/jobs") return Response.json((await recentJobs(env, 6)).map(j => ({ id: j.id, title: j.title, status: j.status, scenes: j.scenes?.length, words: j.words ?? wc(j), gen: j.gen })));
    if (u.pathname === "/health") return new Response((await healthCheck(env)).text);
    if (u.pathname === "/run" && req.method === "POST") try { return Response.json(await startPipeline(env)); } catch (e: any) { return new Response("pipeline error: " + String(e.message).slice(0, 800), { status: 500 }); }
    if (u.pathname === "/job/next") {
      let id = await env.KV.get("queue:pending");
      if (!id) { // reclaim a recently stalled job (render run died), at most once
        for (const j of await recentJobs(env, 20)) {
          if (j.status === "rendering" && j.createdAt && Date.now() - j.createdAt < 3 * 3600e3
              && Date.now() - (j.claimedAt || j.createdAt) > 10 * 60e3 && (j.attempts || 0) < 2) { id = j.id; break; }
        }
      }
      if (!id) return new Response("none", { status: 404 });
      const job = JSON.parse((await env.KV.get(`job:${id}`))!) as Job; job.status = "rendering"; job.claimedAt = Date.now(); job.attempts = (job.attempts || 0) + 1;
      ev(job, `Render started (attempt ${job.attempts})`);
      await saveJob(env, job); await env.KV.delete("queue:pending");
      return Response.json(job);
    }
    const rq = u.pathname.match(/^\/requeue\/(\w+)$/);
    if (rq && req.method === "POST") { try { await requeueJob(env, rq[1]); return new Response("requeued " + rq[1]); } catch (e: any) { return new Response("error: " + String(e.message).slice(0, 500), { status: 500 }); } }
    const pg = u.pathname.match(/^\/progress\/(\w+)$/);
    if (pg && req.method === "POST") {
      const job = JSON.parse((await env.KV.get(`job:${pg[1]}`)) || "null") as Job | null; if (!job) return new Response("no job", { status: 404 });
      const b = (await req.json()) as any; job.progress = { step: String(b.step || ""), done: Number(b.done) || 0, total: Number(b.total) || 0, t: Date.now() };
      if (b.msg) ev(job, String(b.msg)); await saveJob(env, job); return new Response("ok");
    }
    const m = u.pathname.match(/^\/upload\/(\w+)$/);
    if (m && req.method === "PUT") {
      if (!(await env.KV.get(`job:${m[1]}`))) return new Response("no job", { status: 404 });
      await env.KV.put(`video:${m[1]}`, await req.arrayBuffer(), { expirationTtl: 86400 * 3 });
      return new Response("ok");
    }
    if (u.pathname === "/setup/webhook" && req.method === "POST") {
      const r = await tg(env, "setWebhook", { url: `${env.WORKER_URL}/tg`, secret_token: env.JOB_TOKEN, allowed_updates: ["callback_query"], drop_pending_updates: true });
      return new Response(await r.text(), { status: r.status });
    }
    const f = u.pathname.match(/^\/fail\/(\w+)$/);
    if (f && req.method === "POST") {
      const raw = await env.KV.get(`job:${f[1]}`); if (!raw) return new Response("no job", { status: 404 });
      const job = JSON.parse(raw) as Job; job.status = "failed"; const err = (await req.text()).slice(0, 800); ev(job, "Render failed: " + err.split("\n").slice(-2).join(" ").slice(0, 200)); await saveJob(env, job);
      await notifyAdmin(env, `Render FAILED for "${job.title}" (${job.id}):\n${err}`, {}, "error"); return new Response("ok");
    }
    const p = u.pathname.match(/^\/publish\/(\w+)\/(telegram|youtube|facebook|instagram|summary|review)$/);
    if (p && req.method === "POST") {
      const job = JSON.parse((await env.KV.get(`job:${p[1]}`)) || "null") as Job; if (!job) return new Response("no job", { status: 404 });
      if (p[2] === "review") { await sendForReview(env, job); return new Response("ok"); }
      if (p[2] === "summary") return new Response("ok");
      return new Response(await publishOne(env, job, p[2]));
    }
    return new Response("not found", { status: 404 });
  },
};
