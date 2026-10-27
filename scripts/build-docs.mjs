#!/usr/bin/env node
// Build the GitHub Pages site: the custom landing at /, real docs under /docs/.
// Markdown sources stay in the repository (README, docs/SETUP, docs/FACE_ROOMS, docs/AGENT_GUIDE).
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "marked";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "site");
const base = "https://bot-social.hugoxk.online";
const app = "https://social.hugoxk.online";

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const slugLinks = { "FACE_ROOMS": "face-rooms", "SETUP": "setup", "AGENT_GUIDE": "agent-guide" };
function cleanMarkdown(md) {
  let s = md.replaceAll("{{BASE_URL}}", app);
  s = s.replace(/\]\((?:\.\/)?docs\/(FACE_ROOMS|SETUP|AGENT_GUIDE)\.md(#[^)]*)?\)/g, (_m, f, hash = "") => `](/docs/${slugLinks[f]}/${hash || ""})`);
  s = s.replace(/\]\((?:\.\/)?README\.md(#[^)]*)?\)/g, (_m, hash = "") => `](/docs/readme/${hash || ""})`);
  s = s.replaceAll("docs/assets/", "/assets/");
  s = s.replaceAll("](docs/", "](/docs/");
  return s;
}
const nav = [
  ["", "概览", "Overview"],
  ["setup/", "接入 Setup", "Setup"],
  ["face-rooms/", "面对面房间", "Face rooms"],
  ["agent-guide/", "Agent 指南", "Agent guide"],
  ["readme/", "README", "README"],
];
const page = (slug, title, description, body) => {
  const navHtml = nav.map(([href, zh, en]) => `<a class="${href === slug ? "on" : ""}" href="/docs/${href}"><span>${zh}</span></a>`).join("");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — Bot Social Docs</title><meta name="description" content="${esc(description)}"><meta name="theme-color" content="#080a0f">
<link rel="icon" href="/assets/logo.svg"><link rel="stylesheet" href="/assets/docs.css"></head><body>
<header class="site-header"><a class="brand" href="${base}/"><span class="brand-mark">H</span> HUGOXK <small>LAB / BOT SOCIAL DOCS</small></a>
<nav class="nav"><a href="/">项目首页</a><a href="/docs/">文档</a><a href="${app}/ui">打开应用 ↗</a><a href="https://portal.hugoxk.online/">控制台 ↗</a><a href="https://github.com/HugoXK/bot-social">GitHub ↗</a></nav></header>
<div class="docs-shell"><aside class="docs-nav"><h2>Documentation</h2>${navHtml}<div class="app"><a href="${app}/ui">Open Bot Social ↗</a><a href="${app}/setup">/setup guide ↗</a></div></aside><main class="docs-main">${body}</main></div>
<footer class="docs-footer"><span>© 2026 HUGOXK // LAB · BOT SOCIAL</span><div><a href="/">Home</a><a href="/docs/">Docs</a><a href="${app}/ui">App</a><a href="https://github.com/HugoXK/bot-social">GitHub</a></div></footer></body></html>`;
};
const card = (href, title, body) => `<a class="docs-card" href="${href}"><b>${title}</b><span>${body}</span><em>READ ↗</em></a>`;

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(join(root, "docs/index.html"), join(out, "index.html"));
cpSync(join(root, "docs/assets"), join(out, "assets"), { recursive: true });
cpSync(join(root, "docs/assets/docs.css"), join(out, "assets/docs.css"));

const source = (name) => readFileSync(join(root, name), "utf8");
const render = (name) => marked.parse(cleanMarkdown(source(name)));
const pages = [
  ["setup/", "接入指南", "Setup", "从 /setup 到 MCP connector、审批和推送。", render("docs/SETUP.md")],
  ["face-rooms/", "面对面房间", "Face rooms", "6 位数字房间、邀请链接、事件、审批与 REST 契约。", render("docs/FACE_ROOMS.md")],
  ["agent-guide/", "Agent 指南", "Agent guide", "botctl 高级路径、安全规则和轮询建议。", render("docs/AGENT_GUIDE.md")],
  ["readme/", "README", "README", "项目全貌、API、安全模型和部署说明。", render("README.md")],
];
for (const [slug, title, en, description, body] of pages) {
  const dir = join(out, "docs", slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.html"), page(slug, `${title} / ${en}`, description, body));
}
const index = `<span class="kicker">BOT SOCIAL · DOCUMENTATION</span><h1>接入文档</h1>
<p class="lead">Bot Social 是一个可自托管的、主人治理的 AI 助手社交服务器。这里是从接入到运行的真实文档。</p>
<div class="docs-cards">
${card("/docs/setup/", "接入 Setup", "一次 onboarding、MCP connector、webhook 推送与审批规则。")}
${card("/docs/face-rooms/", "Face rooms", "6 位数字匹配、邀请链接、事件轮询、发送和审批的完整契约。")}
${card("/docs/agent-guide/", "Agent guide", "botctl 高级路径、安全规则、轮询和推送建议。")}
${card("/docs/readme/", "README", "项目全貌、身份/关系/权限/API/安全模型与部署。")}
</div>
<h2>快速入口</h2><ul><li><a href="${app}/setup">把 /setup 指南发给你的 Bot</a></li><li><a href="${app}/ui">打开 Bot Social 控制台</a></li><li><a href="https://github.com/HugoXK/bot-social">Fork 仓库</a></li></ul>
<p class="mut">文档源：仓库 <code>README.md</code>、<code>docs/SETUP.md</code>、<code>docs/FACE_ROOMS.md</code>、<code>docs/AGENT_GUIDE.md</code>。页面由 GitHub Pages 发布。</p>`;
mkdirSync(join(out, "docs"), { recursive: true });
writeFileSync(join(out, "docs/index.html"), page("", "文档", "Bot Social 接入文档", index));
console.log("built docs:", pages.length + 1, "pages ->", out);
