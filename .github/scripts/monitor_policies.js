#!/usr/bin/env node
'use strict';
// 政策库半自动监控：深链存活+废止字样检查 / expires 到期提醒 / 区局新公告发现
// 运行：node .github/scripts/monitor_policies.js   （可选 LIMIT=8 只检查前 N 条深链）
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync, execFile, execFileSync } = require('child_process');

// 政府站点部分 SSL 网关与 Node TLS 栈不兼容(ERR_SSL_BAD_ECPOINT)，改用 curl 做检查
const CURL = (() => {
  for (const c of ['curl', 'curl.exe']) {
    try { execFileSync(c, ['--version'], { stdio: 'ignore' }); return c; } catch (e) {}
  }
  return 'curl';
})();

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const POLICIES_PATH = path.join(REPO_ROOT, 'policies.json');
const STATE_PATH = path.join(REPO_ROOT, 'monitor_state.json');

const NOW = new Date();
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const FETCH_TIMEOUT = 12000;
const CONCURRENCY = 8;
const NEAR_DAYS = 90;
const LIMIT = process.env.LIMIT ? parseInt(process.env.LIMIT, 10) : Infinity;

const NOTICE_FEEDS = [
  { key: 'gxj', name: '市工业和信息化局', url: 'https://gxj.sz.gov.cn/gkmlpt/index' },
  { key: 'hrss', name: '市人力资源和社会保障局', url: 'http://hrss.sz.gov.cn/tzgg/' },
  { key: 'stic', name: '市科技创新局', url: 'https://stic.sz.gov.cn/gkmlpt/index' },
  { key: 'amr', name: '市市场监督管理局', url: 'http://amr.sz.gov.cn/' },
  { key: 'ns', name: '南山区', url: 'https://www.szns.gov.cn/xxgk/qzfxxgkml/tzgg/' },
  { key: 'ba', name: '宝安区', url: 'https://www.baoan.gov.cn/bafgj/gkmlpt/index' },
  { key: 'gm', name: '光明区', url: 'https://www.szgm.gov.cn/gkmlpt/index' },
  { key: 'lg', name: '龙岗区', url: 'https://www.lg.gov.cn/gkmlpt/index' },
  { key: 'lhq', name: '龙华区', url: 'https://www.szlhq.gov.cn/gkmlpt/index' },
  { key: 'ps', name: '坪山区', url: 'https://www.szpsq.gov.cn/gkmlpt/index' },
];

// 仅匹配"本条政策自身被终止/已废止"的强语境，避免"原X号文废止""专利失效"等正常表述误报
// 说明：政府政策页常写"原XX规定同时废止"套话，纯正则无法可靠区分"本条废止"与"旧规废止"，
// 为避免误报刷屏，已移除正文"废止字样"检测。政策失效的可靠信号改用：HTTP 深链失效(404) + expires 过期。

function loadJSON(p, fallback) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return fallback; } }
function saveJSON(p, obj) { fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8'); }
function fmt(d) { return d.toISOString().slice(0, 10); }

function parseDate(s) {
  if (!s) return null;
  const m = s.match(/(\d{4})[-年.](\d{1,2})[-月.](\d{1,2})/);
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return new Date(y, mo - 1, d);
}

function fetchPage(url) {
  return new Promise((resolve) => {
    const tmp = path.join(os.tmpdir(), 'mon_' + Math.random().toString(36).slice(2) + '.html');
    const args = ['-L', '-A', UA, '-s', '--max-time', String(Math.floor(FETCH_TIMEOUT / 1000)),
      '-o', tmp, '-w', '%{http_code}', url];
    execFile(CURL, args, (err, stdout) => {
      const code = parseInt((stdout || '').trim(), 10) || 0;
      let text = '';
      try { text = fs.readFileSync(tmp, 'utf8'); } catch (e) {}
      try { fs.unlinkSync(tmp); } catch (e) {}
      if (err && !code) { resolve({ status: 0, error: 'CURL_ERR', text }); return; }
      resolve({ status: code, text });
    });
  });
}

async function pool(items, worker, size) {
  const out = new Array(items.length);
  let i = 0;
  async function next() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await worker(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, () => next()));
  return out;
}

function extractNotices(html, baseUrl) {
  const results = [];
  const re = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const href = m[1];
    const raw = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (raw.length < 4) continue;
    const seg = html.slice(Math.max(0, m.index - 140), m.index + m[0].length + 140);
    const d = parseDate(seg);
    if (!d) continue;
    let url = baseUrl;
    try { url = new URL(href, baseUrl).href; } catch (e) {}
    results.push({ date: d, title: raw.slice(0, 80), url });
  }
  return results;
}

function hasGh() { try { execSync('gh --version', { stdio: 'ignore' }); return true; } catch (e) { return false; } }

function renderMarkdown(report) {
  const L = [];
  L.push(`# 🔍 政策库监控报告 ${fmt(NOW)}`);
  L.push('');
  L.push(`> 自动巡检结果。异常项请在复核后告知助手更新 \`policies.json\`（含深链 / 金额 / expires）。`);
  L.push('');
  L.push(`- 失效深链：${report.dead.length} 条`);
  L.push(`- 临期(<${NEAR_DAYS}天)：${report.expiring.length} 条`);
  L.push(`- 已过期仍展示(待续期确认)：${report.expiredPending.length} 条`);
  L.push(`- 区局疑似新政：${report.newNotices.length} 条`);
  L.push('');
  if (report.dead.length) {
    L.push('## ❌ 失效深链（需修复 sourceUrl）');
    report.dead.forEach(x => L.push(`- [${x.id}] ${x.name} — ${x.url} （HTTP ${x.status}）`));
    L.push('');
  }
  if (report.expiredPending.length) {
    L.push('## 🕓 已过期仍展示（待续期/下架确认）');
    report.expiredPending.forEach(x => L.push(`- [${x.id}] ${x.name} — 到期 ${x.expires}（已 ${Math.abs(x.days)} 天）`));
    L.push('');
  }
  if (report.expiring.length) {
    L.push(`## ⏳ 临期(<${NEAR_DAYS}天)`);
    report.expiring.forEach(x => L.push(`- [${x.id}] ${x.name} — ${x.expires}（剩 ${x.days} 天）`));
    L.push('');
  }
  if (report.newNotices.length) {
    L.push('## 🆕 区局疑似新政（待复核）');
    report.newNotices.forEach(x => L.push(`- 【${x.feed}】${x.title}（${x.date}）— ${x.url}`));
    L.push('');
  }
  if (!report.dead.length && !report.repealed.length && !report.expiredPending.length && !report.expiring.length && !report.newNotices.length) {
    L.push('✅ 本次巡检无异常项。');
    L.push('');
  }
  return L.join('\n');
}

function handleIssue(report, md) {
  const has = report.dead.length || report.expiring.length || report.expiredPending.length || report.newNotices.length;
  if (!has) { console.log('\n✅ 无异常项，未创建 issue'); return; }
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  if (!repo || !token || !hasGh()) {
    console.log('\n(无 gh CLI / 无 token，跳过 issue 创建；报告已打印于上方)');
    return;
  }
  try {
    const num = execSync(`gh issue list --repo "${repo}" --label policy-monitor --state open --json number --jq '.[0].number'`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const body = `<!-- auto -->\n## 政策库监控报告 ${fmt(NOW)}\n\n${md}`;
    if (num) {
      execSync(`gh issue comment ${num} --repo "${repo}" --body ${JSON.stringify(body)}`, { stdio: 'ignore' });
      console.log('已评论到 issue #' + num);
    } else {
      const title = `政策库监控 ${fmt(NOW)}：${report.dead.length}失效/${report.repealed.length}废止/${report.expiring.length}临期/${report.newNotices.length}新政`;
      execSync(`gh issue create --repo "${repo}" --title ${JSON.stringify(title)} --label policy-monitor --body ${JSON.stringify(body)}`, { stdio: 'ignore' });
      console.log('已创建 issue：' + title);
    }
  } catch (e) {
    console.error('issue 操作失败(可忽略)：', e.message);
  }
}

async function main() {
  const policies = loadJSON(POLICIES_PATH, []);
  const state = loadJSON(STATE_PATH, { feeds: {}, lastRun: null });
  if (!state.feeds) state.feeds = {};

  const report = { dead: [], repealed: [], expiring: [], expiredPending: [], newNotices: [] };

  // 1) 深链健康检查
  const targets = policies.filter(p => p.sourceUrl).slice(0, LIMIT);
  console.error(`检查深链：${targets.length}/${policies.filter(p => p.sourceUrl).length} 条（LIMIT=${LIMIT === Infinity ? '全量' : LIMIT}）`);
  const checks = await pool(targets, async (p) => ({ p, ...(await fetchPage(p.sourceUrl)) }), CONCURRENCY);
  for (const c of checks) {
    const { p, status, text, error } = c;
    if (status === 0 || status >= 400) {
      report.dead.push({ id: p.id, name: p.name, url: p.sourceUrl, status: status || error });
      continue;
    }
  }

  // 2) expires 到期
  for (const p of policies) {
    if (!p.expires) continue;
    const d = parseDate(p.expires);
    if (!d) continue;
    const days = Math.round((d - NOW) / 86400000);
    if (days < 0) report.expiredPending.push({ id: p.id, name: p.name, expires: p.expires, days });
    else if (days <= NEAR_DAYS) report.expiring.push({ id: p.id, name: p.name, expires: p.expires, days });
  }

  // 3) 区局新公告发现
  for (const feed of NOTICE_FEEDS) {
    const r = await fetchPage(feed.url);
    if (r.status === 0 || r.status >= 400) { console.error(`feed ${feed.key} 抓取失败 ${r.status || r.error}`); continue; }
    const notices = extractNotices(r.text, feed.url).sort((a, b) => b.date - a.date);
    if (!notices.length) continue;
    const latest = notices[0];
    const prev = state.feeds[feed.key] ? parseDate(state.feeds[feed.key].lastDate) : null;
    state.feeds[feed.key] = { lastDate: fmt(latest.date), lastTitle: latest.title, lastUrl: latest.url };
    if (prev && latest.date > prev) {
      const KW = /(补贴|奖励|资助|扶持|措施|办法|申报|细则|政策|贴息|退税|优惠|专项资金|高质量发展|产业)/;
      if (KW.test(latest.title)) {
        report.newNotices.push({ feed: feed.name, title: latest.title, date: fmt(latest.date), url: latest.url });
      }
    }
  }

  state.lastRun = NOW.toISOString();
  saveJSON(STATE_PATH, state);

  const md = renderMarkdown(report);
  console.log(md);
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, '\n' + md, 'utf8');
  }
  handleIssue(report, md);
}

main().catch(e => { console.error('监控脚本异常：', e); process.exit(1); });
