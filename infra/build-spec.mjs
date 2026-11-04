#!/usr/bin/env node
/**
 * Renders the specification (docs/spec/registry-v0.1.md) into one page served at /spec — the URL
 * every component advertises in its manifesto (`specification`, §10A; packages/protocol/src/manifesto.ts).
 * Called by build-site.sh. Build-time only — `marked` is a devDependency, never shipped anywhere.
 * The canonical spec lives in git; this is a rendered copy, so the page says so and links back.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "marked";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "docs/spec/registry-v0.1.md");
const OUT = join(ROOT, "infra/terraform/build/site");
const GITHUB = "https://github.com/sugeul/doax/blob/main/docs/spec/registry-v0.1.md";

marked.setOptions({ gfm: true });

const md = readFileSync(SRC, "utf8");
const title = (md.match(/^#\s+(.+)$/m)?.[1] ?? "Specification").trim();
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);

// marked emits bare <h1>..<h6>; add slug ids so sections are deep-linkable (/spec#8-2-resource-audit).
const body = marked.parse(md).replace(/<h([1-6])>([\s\S]*?)<\/h\1>/g, (_m, lvl, inner) => {
    const id = inner
        .replace(/<[^>]+>/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
    return `<h${lvl} id="${id}">${inner}</h${lvl}>`;
});

// Palette matches doax.io (same block as infra/build-playbook.mjs).
const STYLE = `*{box-sizing:border-box}
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;line-height:1.6;
background:radial-gradient(120% 90% at 70% 0%,#0a1426 0%,#05080f 48%,#03050b 100%) fixed;color:#eaf1fb}
a{color:#37e6d0;text-decoration:none}a:hover{text-decoration:underline}
header.nav{position:sticky;top:0;z-index:5;backdrop-filter:blur(8px);background:rgba(5,8,15,.72);border-bottom:1px solid #182438}
.nav-in{max-width:900px;margin:0 auto;display:flex;align-items:center;gap:14px;height:60px;padding:0 20px}
.brand{display:flex;align-items:center;gap:9px;font-weight:700;color:#eaf1fb}
.ring{width:17px;height:17px;border-radius:50%;background:conic-gradient(from 210deg,#37e6d0,#4f8dff,#37e6d0);
mask:radial-gradient(circle at 50% 50%,transparent 52%,#000 54%);-webkit-mask:radial-gradient(circle at 50% 50%,transparent 52%,#000 54%)}
.nav-in .sp{margin-left:auto}.nav-in a.ghost{color:#91a4c2;font-size:14px}
.wrap{max-width:900px;margin:0 auto;padding:0 20px}
.hero{padding:34px 0 6px}.hero h1{font-size:32px;margin:0 0 10px;letter-spacing:-.02em}
.hero p{color:#91a4c2;font-size:16px;max-width:72ch;margin:0}
.note{max-width:900px;margin:18px auto 0;padding:11px 16px;background:#0d1522;border:1px solid #182438;border-left:3px solid #37e6d0;
border-radius:0 8px 8px 0;color:#aebfd8;font-size:13.5px}
main{padding:14px 0 70px}
main h1{font-size:28px;letter-spacing:-.02em;margin:28px 0 8px}
h1,h2,h3,h4{line-height:1.3;scroll-margin-top:72px}h2{margin-top:30px}p,li{color:#c3d1e6}strong{color:#eaf1fb}
code{font:12.5px ui-monospace,SFMono-Regular,Menlo,monospace;background:#0f1828;border:1px solid #182438;border-radius:6px;padding:1.5px 6px;color:#9fe9dd}
pre{background:#0f1828;border:1px solid #182438;border-radius:10px;padding:13px 15px;overflow-x:auto}pre code{background:none;border:0;padding:0}
blockquote{margin:12px 0;padding:8px 16px;border-left:3px solid #37e6d0;background:#0d1522;color:#aebfd8;border-radius:0 8px 8px 0}
table{border-collapse:collapse;width:100%;margin:12px 0;font-size:13.5px;display:block;overflow-x:auto}
th,td{border:1px solid #1d2b43;padding:8px 11px;text-align:left;vertical-align:top}th{background:#0f1828;color:#cfe0f5}
hr{border:0;border-top:1px solid #182438;margin:22px 0}
footer{border-top:1px solid #182438;color:#5c7097;font-size:13px;padding:22px 0 60px}`;

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)} · doax</title>
<meta name="description" content="The doax Agent Interface Registry specification (v0.1) — what the system does and what it guarantees.">
<style>${STYLE}</style></head><body>
<header class="nav"><div class="nav-in">
<a class="brand" href="/"><span class="ring"></span> doax</a>
<span class="sp"></span><a class="ghost" href="/doax-manifesto">Manifesto</a>
<a class="ghost" href="/playbook">Playbooks</a>
<a class="ghost" href="/install">Install CLI</a>
</div></header>
<p class="note">This is a rendered copy of the specification. The canonical, versioned source lives in git: <a href="${GITHUB}" target="_blank" rel="noopener">docs/spec/registry-v0.1.md ↗</a>. Every doax component advertises this page as its <code>specification</code> URL (§10A).</p>
<main class="wrap">${body}</main>
<footer><div class="wrap">doax · <a href="/">home</a> · <a href="/doax-manifesto">manifesto</a> · <a href="/playbook">playbooks</a> · <a href="/install">install</a></div></footer>
</body></html>`;

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "spec.html"), html);
console.log(`spec page -> ${OUT}/spec.html (/spec)`);
