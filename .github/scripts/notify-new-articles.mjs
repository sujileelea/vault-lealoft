// Post a Slack notification when new articles are added to the vault.
// Runs in GitHub Actions on push to main. Detects ADDED markdown files under
// Articles/, derives each article's web URL (matching the site's slug logic),
// and posts a message to a Slack Incoming Webhook (secret SLACK_WEBHOOK_URL).
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import https from "node:https";

const webhook = process.env.SLACK_WEBHOOK_URL;
const base = (process.env.SITE_BASE || "https://lea-loft.sigongan.com").replace(/\/+$/, "");
const before = process.env.BEFORE_SHA || "";
const after = process.env.AFTER_SHA || "";

if (!webhook) {
  console.log("SLACK_WEBHOOK_URL secret is not set — skipping (add it in repo Settings → Secrets).");
  process.exit(0);
}

const ZERO = /^0+$/;
const git = (args) =>
  execSync(`git -c core.quotePath=false ${args}`, { encoding: "utf8" });

// --- find newly ADDED markdown files under Articles/ in this push ---
let added = [];
try {
  const range = before && !ZERO.test(before) ? `${before} ${after}` : `${after}^ ${after}`;
  added = git(`diff --diff-filter=A --name-only ${range} -- Articles/`).split("\n");
} catch (e) {
  console.log("range diff failed, trying HEAD commit:", e.message);
  try {
    added = git(`show --diff-filter=A --name-only --pretty=format: ${after} -- Articles/`).split("\n");
  } catch (e2) {
    console.log("could not determine added files:", e2.message);
  }
}
added = [...new Set(added.map((s) => s.trim()).filter((f) => /\.mdx?$/i.test(f)))];

if (added.length === 0) {
  console.log("No newly added articles in this push.");
  process.exit(0);
}

// --- derive title + slug (mirrors web/src/lib/articles.ts) ---
const stripOrder = (s) => s.replace(/^\s*\d+[.)]\s*/, "").trim();
const slugify = (stem) =>
  stripOrder(stem)
    .replace(/['"`‘’“”]/g, "")
    .replace(/\s+/g, "-")
    .replace(/[/\\?#%]/g, "")
    .toLowerCase()
    .normalize("NFC");

function parse(file) {
  let raw = "";
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    /* file may have been removed in a later commit of the same push */
  }
  const fm = {};
  let body = raw;
  const m = /^---\s*\n([\s\S]*?)\n---\s*\n?/.exec(raw);
  if (m) {
    body = raw.slice(m[0].length);
    for (const line of m[1].split("\n")) {
      const kv = /^([A-Za-z0-9_]+)\s*:\s*(.*)$/.exec(line);
      if (kv) fm[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, "");
    }
  }
  const stem = file.split("/").pop().replace(/\.mdx?$/i, "").normalize("NFC");
  const h1 = /^#\s+(.+)$/m.exec(body);
  const title = fm.title || (h1 ? h1[1].trim() : stripOrder(stem));
  const slug = (fm.slug || slugify(stem)).normalize("NFC");
  const category = file.split("/").slice(0, -1).pop() || "";
  return { title, slug, category };
}

const articles = added.map(parse);
const lines = articles.map((a) => {
  const url = `${base}/articles/${encodeURIComponent(a.slug)}`;
  return `• <${url}|${a.title}>${a.category ? `  _(${a.category})_` : ""}`;
});
const header =
  articles.length > 1
    ? `:sparkles: Lea-Loft에 새 글 ${articles.length}개가 올라왔어요!`
    : ":sparkles: Lea-Loft에 새 글이 올라왔어요!";

const payload = JSON.stringify({ text: `${header}\n${lines.join("\n")}` });

// --- post to Slack ---
const u = new URL(webhook);
const req = https.request(
  {
    hostname: u.hostname,
    path: u.pathname + u.search,
    method: "POST",
    headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
  },
  (res) => {
    let body = "";
    res.on("data", (d) => (body += d));
    res.on("end", () => {
      console.log(`Slack responded ${res.statusCode}: ${body}`);
      process.exit(res.statusCode && res.statusCode < 300 ? 0 : 1);
    });
  },
);
req.on("error", (e) => {
  console.error("Failed to POST to Slack:", e);
  process.exit(1);
});
req.write(payload);
req.end();
