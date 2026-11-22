// Reference sync and review service for Cutir (phase 29). Optional: the app works fully without it.
//
//   node sync-server/server.mjs --add-user alice      prints an access token for alice
//   node sync-server/server.mjs                       listens on PORT (default 8787), data in ./sync-data
//
// Plain Node, no dependencies. Data is JSON files: <data>/users.json, <data>/<user>/<project>.json, <data>/reviews.json.
// Every project call needs "Authorization: Bearer <token>". Review pages and review comments need only the link's token.
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const safe = (s) => String(s).replace(/[^\w.-]/g, "_").slice(0, 80);
const readJson = (file, fallback) => {
  try {
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : fallback;
  } catch {
    return fallback;
  }
};
const writeJson = (file, value) => {
  writeFileSync(`${file}.tmp`, JSON.stringify(value));
  renameSync(`${file}.tmp`, file); // never leave half a file
};

export function addUser(dir, name) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "users.json");
  const users = readJson(file, {});
  const token = randomBytes(24).toString("hex");
  users[safe(name)] = { token };
  writeJson(file, users);
  return token;
}

const REVIEW_PAGE = (token, name, changes) => `<!doctype html><meta charset="utf-8"><title>Review: ${esc(name)}</title>
<style>body{font:15px system-ui;max-width:760px;margin:2rem auto;padding:0 1rem;color:#222}video{width:100%;background:#000}li{margin:.4rem 0}.done{opacity:.5;text-decoration:line-through}button,input,textarea{font:inherit}</style>
<h1>${esc(name)}</h1>
${changes.length ? `<h2>Changes in this version</h2><ul>${changes.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>` : ""}
<p><label>Open the video to review: <input type="file" id="f" accept="video/*,audio/*"></label></p><video id="v" controls></video>
<h2>Comments</h2><ul id="list"></ul>
<form id="form"><p><input id="who" placeholder="Your name" required> at <input id="t" size="9" value="0:00"> <button type="button" id="now">Use current time</button></p><p><textarea id="text" rows="3" style="width:100%" placeholder="What should change here?" required></textarea></p><button>Add comment</button></form>
<script>
const token=${JSON.stringify(token)},v=document.getElementById("v"),list=document.getElementById("list");
const fmt=s=>Math.floor(s/60)+":"+String(Math.floor(s%60)).padStart(2,"0"),parse=t=>t.split(":").reduce((a,x)=>a*60+Number(x),0)||0;
document.getElementById("f").onchange=e=>{v.src=URL.createObjectURL(e.target.files[0])};
document.getElementById("now").onclick=()=>{document.getElementById("t").value=fmt(v.currentTime||0)};
async function load(){const r=await (await fetch("/review/"+token+"/comments")).json();list.innerHTML="";for(const c of r.comments.sort((a,b)=>a.time-b.time)){const li=document.createElement("li");li.className=c.resolved?"done":"";const a=document.createElement("a");a.href="#";a.textContent=fmt(c.time);a.onclick=ev=>{ev.preventDefault();v.currentTime=c.time};li.append(a," ",c.author+": "+c.text+(c.resolved?" (resolved)":""));list.append(li)}}
document.getElementById("form").onsubmit=async e=>{e.preventDefault();await fetch("/review/"+token+"/comments",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({author:who.value,time:parse(t.value),text:text.value})});text.value="";load()};
load();
</script>`;
function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

/** Make the request handler. `dir` holds all data. */
export function makeServer(dir) {
  mkdirSync(dir, { recursive: true });
  const reviewsFile = join(dir, "reviews.json");

  const projectFile = (user, pid) => {
    mkdirSync(join(dir, safe(user)), { recursive: true });
    return join(dir, safe(user), `${safe(pid)}.json`);
  };
  const load = (user, pid) => readJson(projectFile(user, pid), { ops: [], comments: [] });
  const save = (user, pid, data) => writeJson(projectFile(user, pid), data);

  return createServer(async (req, res) => {
    const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST, PATCH, OPTIONS" };
    const send = (code, body, type = "application/json") => {
      res.writeHead(code, { "content-type": type, ...cors });
      res.end(type === "application/json" ? JSON.stringify(body) : body);
    };
    if (req.method === "OPTIONS") return send(204, "", "text/plain");
    const url = new URL(req.url, "http://x");
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    let body = {};
    if (req.method === "POST" || req.method === "PATCH") {
      const chunks = [];
      let size = 0;
      for await (const c of req) {
        size += c.length;
        if (size > 20e6) return send(413, { error: "too large" });
        chunks.push(c);
      }
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      } catch {
        return send(400, { error: "bad json" });
      }
    }
    try {
      if (parts[0] === "health") return send(200, { ok: true });

      // ---- review links: no account, the token is the key ----
      if (parts[0] === "review" && parts[1]) {
        const rv = readJson(reviewsFile, {})[parts[1]];
        if (!rv) return send(404, { error: "no such review" });
        if (parts.length === 2 && req.method === "GET") return send(200, REVIEW_PAGE(parts[1], rv.name, rv.changes ?? []), "text/html; charset=utf-8");
        if (parts[2] === "comments") {
          const data = load(rv.user, rv.pid);
          if (req.method === "GET") return send(200, { comments: data.comments });
          if (req.method === "POST") {
            const c = { id: randomBytes(6).toString("hex"), time: Number(body.time) || 0, author: String(body.author || "Reviewer").slice(0, 60), text: String(body.text || "").slice(0, 2000), at: Date.now(), resolved: false };
            if (!c.text) return send(400, { error: "empty comment" });
            data.comments.push(c);
            save(rv.user, rv.pid, data);
            return send(200, c);
          }
        }
        return send(404, { error: "not found" });
      }

      // ---- everything else needs an account ----
      const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
      const users = readJson(join(dir, "users.json"), {});
      const user = Object.keys(users).find((u) => bearer && users[u].token === bearer);
      if (!user) return send(401, { error: "unauthorized" });

      if (parts[0] === "p" && parts[1]) {
        const pid = parts[1];
        const data = load(user, pid);
        if (parts[2] === "ops" && req.method === "GET") {
          const since = Number(url.searchParams.get("since")) || 0;
          return send(200, { entries: data.ops.filter((o) => o.seq > since), head: data.ops.length });
        }
        if (parts[2] === "ops" && req.method === "POST") {
          if (body.baseSeq !== data.ops.length) return send(409, { error: "stale", head: data.ops.length });
          if (!Array.isArray(body.patches)) return send(400, { error: "patches missing" });
          const entry = { seq: data.ops.length + 1, client: String(body.client || ""), at: Number(body.at) || Date.now(), baseSeq: body.baseSeq, patches: body.patches, label: body.label };
          data.ops.push(entry);
          save(user, pid, data);
          return send(200, { seq: entry.seq });
        }
        if (parts[2] === "comments" && req.method === "GET") return send(200, { comments: data.comments });
        if (parts[2] === "comments" && req.method === "POST") {
          const c = { id: randomBytes(6).toString("hex"), time: Number(body.time) || 0, author: String(body.author || user), text: String(body.text || "").slice(0, 2000), at: Date.now(), resolved: false };
          data.comments.push(c);
          save(user, pid, data);
          return send(200, c);
        }
        if (parts[2] === "comments" && parts[3] && req.method === "PATCH") {
          const c = data.comments.find((x) => x.id === parts[3]);
          if (!c) return send(404, { error: "no such comment" });
          c.resolved = !!body.resolved;
          c.resolvedBy = c.resolved ? String(body.by || user) : undefined;
          save(user, pid, data);
          return send(200, c);
        }
        if (parts[2] === "review" && req.method === "POST") {
          const reviews = readJson(reviewsFile, {});
          const token = randomBytes(16).toString("hex");
          reviews[token] = { user, pid, name: String(body.name || "Review").slice(0, 120), changes: Array.isArray(body.changes) ? body.changes.map(String).slice(0, 100) : [], at: Date.now() };
          writeJson(reviewsFile, reviews);
          const host = req.headers.host ?? "localhost";
          return send(200, { token, url: `http://${host}/review/${token}` });
        }
      }
      return send(404, { error: "not found" });
    } catch (e) {
      return send(500, { error: String(e?.message ?? e) });
    }
  });
}

if (/\/sync-server\/server\.mjs$/.test((process.argv[1] ?? "").split("\\").join("/"))) {
  const dir = process.env.SYNC_DATA ?? "sync-data";
  const i = process.argv.indexOf("--add-user");
  if (i > 0) {
    console.log(`Access token for ${process.argv[i + 1]}: ${addUser(dir, process.argv[i + 1] ?? "user")}`);
  } else {
    const port = Number(process.env.PORT) || 8787;
    makeServer(dir).listen(port, () => console.log(`Cutir sync service on http://localhost:${port} (data in ${dir})`));
  }
}
