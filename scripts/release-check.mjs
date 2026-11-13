#!/usr/bin/env node
/**
 * 发版验收：一条命令替代「多次 curl + 十几条 git 命令」。
 *
 *   node scripts/release-check.mjs            # 校验 package.json 版本对应 tag
 *   node scripts/release-check.mjs v0.18.3    # 指定 tag
 *
 * 校验项：
 *   1. 本地 HEAD == origin/main == tag 指向的提交
 *   2. Build Check（main）与 Release Obsidian Plugin（该 tag）均 success
 *   3. Release 三资产 uploaded，且大小与本地产物一致（忽略 CRLF/LF 差异）
 *
 * 可选：export GITHUB_TOKEN=... 提高 API 配额（未登录 60 次/小时）。
 * 退出码 0 表示全部就绪；1 表示有未通过项。
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN = process.env.GITHUB_TOKEN || "";
const POLL_MS = Number(process.env.RC_POLL_MS || 8000);
const TIMEOUT_MS = Number(process.env.RC_TIMEOUT_MS || 300000);

const sh = (cmd) =>
  execSync(cmd, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const log = (s) => process.stdout.write(`${s}\n`);
const ok = (s) => `\x1b[32m✓\x1b[0m ${s}`;
const bad = (s) => `\x1b[31m✗\x1b[0m ${s}`;

// ---- 基础信息 ----
const repo = (() => {
  const url = sh("git remote get-url origin").replace(/\.git$/, "");
  const m = url.match(/github\.com[:/]([^/]+\/[^/]+)$/);
  if (!m) throw new Error(`无法从 origin 解析 GitHub 仓库: ${url}`);
  return m[1];
})();

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
const tag = process.argv[2] || `v${manifest.version}`;

const api = async (p) => {
  const res = await fetch(`https://api.github.com/repos/${repo}${p}`, {
    headers: {
      Accept: "application/vnd.github+json",
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
    },
  });
  if (res.status === 404) return null;
  if (res.status === 403) throw new Error("GitHub API 触发限流，请设置 GITHUB_TOKEN 后重试");
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${p}`);
  return res.json();
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 1. 引用一致性 ----
const head = sh("git rev-parse HEAD");
let origin = "";
try {
  origin = sh("git rev-parse origin/main");
} catch {
  log(bad("本地没有 origin/main 引用，先 git fetch"));
  process.exit(1);
}
const tagSha = (() => {
  try {
    return sh(`git rev-list -n1 ${tag}`);
  } catch {
    return "";
  }
})();
const short = (s) => s.slice(0, 7);
const refsOk = head === origin && head === tagSha;
log(`${tag}  ${refsOk ? "全部就绪" : "存在问题"}`);
log(
  `  refs   ${refsOk ? ok(`HEAD=origin=tag ${short(head)}`) : bad(`HEAD=${short(head)} origin=${short(origin)} tag=${tagSha ? short(tagSha) : "缺失"}`)}` +
    (manifest.version === tag.replace(/^v/, "") ? "" : ` ${bad(`manifest 版本 ${manifest.version} 与 tag 不符`)}`),
);

// tag 都没有就不用等 CI 了，直接给结论，避免空转到超时
if (!tagSha) {
  log(`  CI     ${bad("tag 不存在，跳过")}`);
  log(`  资产   ${bad("tag 不存在，跳过")}`);
  process.exit(1);
}

// ---- 2. CI ----
async function waitRun(pred) {
  const start = Date.now();
  const deadline = start + TIMEOUT_MS;
  const graceMs = 90000; // 90 秒内还找不到运行记录，就当它不存在，不要空转到超时
  let last = null;
  while (Date.now() < deadline) {
    const data = await api("/actions/runs?per_page=30");
    const run = (data?.workflow_runs || []).find(pred);
    if (run) {
      last = run;
      if (run.status === "completed") return run;
    } else if (Date.now() - start > graceMs) {
      return null;
    }
    await sleep(POLL_MS);
  }
  return last;
}

const build = await waitRun(
  (r) => r.name === "Build Check" && r.head_branch === "main" && r.head_sha === head,
  "Build Check",
);
const release = await waitRun(
  (r) => r.name === "Release Obsidian Plugin" && r.head_branch === tag,
  "Release",
);
const ciLine = [build, release]
  .map((r, i) => {
    const name = i === 0 ? "Build Check" : "Release";
    if (!r) return bad(`${name} 未找到运行记录`);
    return r.conclusion === "success" ? `${name} success` : bad(`${name} ${r.conclusion || r.status}`);
  })
  .join(" · ");
const ciOk = build?.conclusion === "success" && release?.conclusion === "success";
log(`  CI     ${ciOk ? ok(ciLine) : bad(ciLine)}`);

// ---- 3. Release 资产 ----
const rel = await api(`/releases/tags/${tag}`);
if (!rel) {
  log(`  资产   ${bad("Release 不存在")}`);
  process.exit(1);
}
// CI 用 LF 检出的产物，本地工作区可能是 CRLF，按 LF 归一化后再比
const localSize = (f) => {
  const buf = fs.readFileSync(path.join(ROOT, f));
  const text = buf.toString("utf8");
  return Buffer.byteLength(text.replace(/\r\n/g, "\n"), "utf8");
};
const want = ["main.js", "manifest.json", "styles.css"];
const lines = want.map((name) => {
  const a = (rel.assets || []).find((x) => x.name === name);
  if (!a) return bad(`${name} 缺失`);
  if (a.state !== "uploaded") return bad(`${name} ${a.state}`);
  const local = localSize(name);
  if (a.size !== local) return bad(`${name} 大小不符 远端 ${a.size} / 本地 ${local}`);
  return `${name} ${a.size.toLocaleString()}`;
});
const assetsOk = lines.every((l) => !l.startsWith("\x1b[31m"));
log(`  资产   ${assetsOk ? ok(lines.join("  ")) : bad(lines.join("  "))}`);
log(`  发布   ${rel.draft ? "仍是 draft" : rel.prerelease ? "标记为 prerelease" : "published"}  ${rel.published_at || ""}`);

process.exit(refsOk && ciOk && assetsOk && !rel.draft ? 0 : 1);
