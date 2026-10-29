#!/usr/bin/env node
/**
 * Renders the playbook/ markdown into a tree of pages under build/site, each with its own clean
 * URL (a permalink):
 *   playbook                          -> /playbook            (index)
 *   playbook/<category>               -> /playbook/<category> (README + situation links)
 *   playbook/<category>/<situation>   -> permalink per situation
 * Called by build-site.sh. Build-time only — `marked` is a devDependency, never shipped anywhere.
 * Inter-file .md links are rewritten to these absolute URLs; the palette matches doax.io.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "marked";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PLAYBOOK = join(ROOT, "playbook");
const OUT = join(ROOT, "infra/terraform/build/site");
const GITHUB = "https://github.com/sugeul/doax/blob/main";

marked.setOptions({ gfm: true });

// Explicit order; each category lists its situation files (README is the category page).
const CATEGORIES = [
    { id: "localapps", situations: ["overnight-digest-in-the-terminal", "a-static-browser-dashboard"] },
    { id: "serverapps-for-cowork", situations: ["the-factory-team-dashboard", "a-shared-client-space", "recruiters-share-resources-not-leads"] },
    { id: "serverapps-monitor-telemetries", situations: ["the-factory-sensed-directory", "an-overnight-briefing-for-companions"] },
];

const read = (cat, name) => readFileSync(join(PLAYBOOK, cat, `${name}.md`), "utf8");
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
const titleOf = (md) => { const m = md.match(/^#\s+(.+)$/m); return m ? m[1].trim() : ""; };
const blurbOf = (md) => { const body = md.replace(/^#\s+.+$/m, "").trim(); const p = body.split(/\n\s*\n/)[0] || ""; return p.replace(/\s+/g, " ").trim(); };

/** Rewrite inter-doc .md links (relative to a file in `cat`) to absolute /playbook URLs. */
function rewriteLinks(md, cat) {
    return md
        .replace(/\]\((?:\.\.\/)+demo\/scenario\.md[^)]*\)/g, `](${GITHUB}/demo/scenario.md)`)
        .replace(/\]\(\.\/README\.md\)/g, `](/playbook/${cat})`)
        .replace(/\]\(\.\.\/([a-z-]+)\/(?:README\.md)?\)/g, (_m, c) => `](/playbook/${c})`)
        .replace(/\]\(\.\/([a-z0-9-]+)\.md\)/g, (_m, f) => `](/playbook/${cat}/${f})`)
        .replace(/\]\(\.\.\/([a-z-]+)\/([a-z0-9-]+)\.md\)/g, (_m, c, f) => `](/playbook/${c}/${f})`);
}

const render = (md, cat) => marked.parse(rewriteLinks(md, cat));

const STYLE = `*{box-sizing:border-box}
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;line-height:1.6;
background:radial-gradient(120% 90% at 70% 0%,#0a1426 0%,#05080f 48%,#03050b 100%) fixed;color:#eaf1fb}
a{color:#37e6d0;text-decoration:none}a:hover{text-decoration:underline}
header.nav{position:sticky;top:0;z-index:5;backdrop-filter:blur(8px);background:rgba(5,8,15,.72);border-bottom:1px solid #182438}
.nav-in{max-width:900px;margin:0 auto;display:flex;align-items:center;gap:14px;height:60px;padding:0 20px}
.brand{display:flex;align-items:center;gap:9px;font-weight:700;color:#eaf1fb}
.ring{width:17px;height:17px;border-radius:50%;background:conic-gradient(from 210deg,#37e6d0,#4f8dff,#37e6d0);
mask:radial-gradient(circle at 50% 50%,transparent 52%,#000 54%);-webkit-mask:radial-gradient(circle at 50% 50%,transparent 52%,#000 54%)}
.brand small{color:#5c7097;font-weight:600;font-size:12px}
@media (max-width:640px){.brand small{display:none}}
.nav-in .sp{margin-left:auto}.nav-in a.ghost{color:#91a4c2;font-size:14px}
.wrap{max-width:900px;margin:0 auto;padding:0 20px}
.crumb{font-size:13px;color:#5c7097;padding:22px 0 0}.crumb a{color:#91a4c2}
.hero{padding:34px 0 6px}.hero h1{font-size:32px;margin:0 0 10px;letter-spacing:-.02em}
.hero p{color:#91a4c2;font-size:16px;max-width:72ch;margin:0}
main{padding:14px 0 70px}
main h1{font-size:28px;letter-spacing:-.02em;margin:18px 0 8px}
h1,h2,h3,h4{line-height:1.3}p,li{color:#c3d1e6}strong{color:#eaf1fb}
code{font:12.5px ui-monospace,SFMono-Regular,Menlo,monospace;background:#0f1828;border:1px solid #182438;border-radius:6px;padding:1.5px 6px;color:#9fe9dd}
pre{background:#0f1828;border:1px solid #182438;border-radius:10px;padding:13px 15px;overflow-x:auto}pre code{background:none;border:0;padding:0}
blockquote{margin:12px 0;padding:8px 16px;border-left:3px solid #37e6d0;background:#0d1522;color:#aebfd8;border-radius:0 8px 8px 0}
table{border-collapse:collapse;width:100%;margin:12px 0;font-size:13.5px;display:block;overflow-x:auto}
th,td{border:1px solid #1d2b43;padding:8px 11px;text-align:left;vertical-align:top}th{background:#0f1828;color:#cfe0f5}
hr{border:0;border-top:1px solid #182438;margin:22px 0}
.cards{display:grid;gap:16px;margin:16px 0 36px}
.card{background:#0b1220;border:1px solid #182438;border-radius:14px;padding:18px 20px}
.card:hover{border-color:#2b6b63}
.card h3{margin:0 0 6px;font-size:18px}.card h3 a{color:#9fe9dd}
.card p{margin:0;color:#91a4c2;font-size:13.5px}
.card .sit{margin:12px 0 0;padding:0;list-style:none;font-size:13.5px}.card .sit li{margin:5px 0;padding-left:14px;position:relative}
.card .sit li:before{content:"›";position:absolute;left:0;color:#5c7097}
footer{border-top:1px solid #182438;color:#5c7097;font-size:13px;padding:22px 0 60px}`;

function shell(title, crumbHtml, bodyHtml, { desc } = {}) {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)} · doax</title>
<meta name="description" content="${esc(desc ?? "Playbooks for building apps on the doax registry.")}">
<style>${STYLE}</style></head><body>
<header class="nav"><div class="nav-in">
<a class="brand" href="/"><span class="ring"></span> doax <small>Delegated Operation, Attested eXecution</small></a>
<span class="sp"></span><a class="ghost" href="/playbook">Playbooks</a>
<a class="ghost" href="/install">Install CLI</a>
<a class="ghost" href="https://registry.doax.io" target="_blank" rel="noopener">registry.doax.io ↗</a>
</div></header>
<div class="wrap">${crumbHtml}</div>
<div class="wrap">${bodyHtml}</div>
<footer><div class="wrap">doax · <a href="/">home</a> · <a href="/playbook">playbooks</a> · <a href="/install">install</a></div></footer>
</body></html>`;
}

const pages = {}; // key -> html

// --- index at /playbook ---
const cards = CATEGORIES.map(({ id, situations }) => {
    const readme = read(id, "README");
    const sits = situations.map((s) => `<li><a href="/playbook/${id}/${s}">${esc(titleOf(read(id, s)))}</a></li>`).join("");
    // div, not a nested <a>: the card holds its own situation links (anchors can't nest).
    return `<div class="card"><h3><a href="/playbook/${id}">${esc(titleOf(readme))}</a></h3><p>${marked.parseInline(blurbOf(readme))}</p><ul class="sit">${sits}</ul></div>`;
}).join("\n");
pages["playbook"] = shell(
    "Playbooks",
    "",
    `<div class="hero"><h1>Playbooks</h1><p>Shapes for building apps on the registry — each a set of concrete client situations. They differ on the one axis that matters: <strong>where the credential lives</strong> — on the device, split between a personal-read and an organization-effect plane, or in a read-only vault for unattended work.</p></div><div class="cards">${cards}</div>`,
    { desc: "Playbooks for building apps on the doax registry: local apps, server apps for cowork, and server apps that monitor telemetries." },
);

// --- category pages at /playbook/<id> and situation pages at /playbook/<id>/<sit> ---
for (const { id, situations } of CATEGORIES) {
    const readme = read(id, "README");
    const catTitle = titleOf(readme);
    const catCrumb = `<div class="crumb"><a href="/playbook">Playbooks</a> › ${esc(catTitle)}</div>`;
    pages[`playbook/${id}`] = shell(catTitle, catCrumb, `<main>${render(readme, id)}</main>`, { desc: blurbOf(readme) });

    for (const s of situations) {
        const md = read(id, s);
        const crumb = `<div class="crumb"><a href="/playbook">Playbooks</a> › <a href="/playbook/${id}">${esc(catTitle)}</a> › ${esc(titleOf(md))}</div>`;
        pages[`playbook/${id}/${s}`] = shell(titleOf(md), crumb, `<main>${render(md, id)}</main>`, { desc: blurbOf(md) });
    }
}

// Files are written WITH .html; the clean permalink (/playbook/<cat>/<sit>, no extension) resolves
// to them via the site-router CloudFront Function (infra/terraform/edge/site-router.js). Routing,
// not duplicated files — a user never needs to type the extension.
for (const [key, html] of Object.entries(pages)) {
    const path = join(OUT, `${key}.html`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, html);
}
console.log(`playbook pages -> ${OUT}/playbook*.html (${Object.keys(pages).length} permalinks)`);
for (const k of Object.keys(pages)) console.log(`  /${k}`);
