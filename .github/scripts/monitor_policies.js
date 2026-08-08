#!/usr/bin/env node
'use strict';
// 政策库全自动监控：深链存活 + expires 到期 + 区局新公告发现
// 与"半自动"的区别：发现问题后【自动落地】，不再开 issue 等人工复核。
//   - 深链 404/410 且连续两次巡检确认 → 自动归档(移出活动库，写入 policies_archived.json)
//   - expires 已过期 → 自动归档
//   - 区局新公告(关键词命中) → 自动写入 policies_draft.json（needsReview 草稿，不进入匹配，待人工转正）
// 安全护栏：① 死链需"两次确认"才归档，避免临時 5xx/超时误杀；② 新政策只进草稿，绝不污染活动匹配库。
// 运行：node .github/scripts/monitor_policies.js   （可选 LIMIT=8 只检查前 N 条深链）
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, execFileSync } = require('child_process');

// 政府站点部分 SSL 网关与 Node TLS 栈不兼容(ERR_SSL_BAD_ECPOINT)，改用 curl 做 HTTP 检查
const CURL = (() => {
  for (const c of ['curl', 'curl.exe']) {
    try { execFileSync(c, ['--version'], { stdio: 'ignore' }); return c; } catch (e) {}
  }
  return 'curl';
})();

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const POLICIES_PATH = path.join(REPO_ROOT, 'policies.json');
const ARCHIVED_PATH = path.join(REPO_ROOT, 'policies_archived.json');
const DRAFT_PATH = path.join(REPO_ROOT, 'policies_draft.json');
const STATE_PATH = path.join(REPO_ROOT, 'monitor_state.json');
const CHANGELOG_PATH = path.join(REPO_ROOT, 'monitor_changelog.md');

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

const KW = /(补贴|奖励|资助|扶持|措施|办法|申报|细则|政策|贴息|退税|优惠|专项资金|高质量发展|产业)/;

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

async function main() {
  const policies = loadJSON(POLICIES_PATH, []);
  const archived = loadJSON(ARCHIVED_PATH, []);
  let drafts = loadJSON(DRAFT_PATH, []);
  if (!Array.isArray(drafts)) drafts = [];
  const state = loadJSON(STATE_PATH, { feeds: {}, dead: {}, lastRun: null });
  if (!state.feeds) state.feeds = {};
  if (!state.dead) state.dead = {};

  const report = {
    archivedDead: [], archivedExpired: [], deadFirstStrike: [], deadSuspect: [],
    expiring: [], newNotices: [], changelog: [],
  };

  // ---- 1) 深链健康检查 ----
  const targets = policies.filter(p => p.sourceUrl).slice(0, LIMIT);
  console.error(`检查深链：${targets.length}/${policies.filter(p => p.sourceUrl).length} 条（LIMIT=${LIMIT === Infinity ? '全量' : LIMIT}）`);
  const checks = await pool(targets, async (p) => ({ p, ...(await fetchPage(p.sourceUrl)) }), CONCURRENCY);
  const toArchive = new Map(); // id -> { policy, reason }

  for (const c of checks) {
    const { p, status, error } = c;
    if (status === 404 || status === 410) {
      if (state.dead[p.id]) {
        // 第二次确认 → 归档
        toArchive.set(p.id, { policy: p, reason: `源链接失效(HTTP ${status})，连续两次巡检确认` });
        report.archivedDead.push({ id: p.id, name: p.name, status });
        report.changelog.push(`归档失效政策 [${p.id}] ${p.name}（HTTP ${status}）`);
      } else {
        state.dead[p.id] = fmt(NOW); // 首次发现，记观察期，本次不动
        report.deadFirstStrike.push({ id: p.id, name: p.name, status });
        console.error(`首次发现死链(观察期) [${p.id}] ${p.name} HTTP ${status}`);
      }
    } else if (status === 0 || status >= 400) {
      // 5xx/403/超时/连接失败：可能是临时故障，不归档，仅记录待确认
      report.deadSuspect.push({ id: p.id, name: p.name, status: status || error });
      console.error(`深链可疑(不动作) [${p.id}] ${p.name} ${status || error}`);
    } else {
      if (state.dead[p.id]) { delete state.dead[p.id]; } // 复活，清除观察期
    }
  }

  // ---- 2) expires 已过期 → 归档 ----
  for (const p of policies) {
    if (!p.expires) continue;
    const d = parseDate(p.expires);
    if (!d) continue;
    const days = Math.round((d - NOW) / 86400000);
    if (days < 0) {
      if (!toArchive.has(p.id)) {
        toArchive.set(p.id, { policy: p, reason: `expires 已过(${p.expires})，政策窗口结束` });
        report.archivedExpired.push({ id: p.id, name: p.name, expires: p.expires });
        report.changelog.push(`归档过期政策 [${p.id}] ${p.name}（${p.expires}）`);
      }
    } else if (days <= NEAR_DAYS) {
      report.expiring.push({ id: p.id, name: p.name, expires: p.expires, days });
    }
  }

  // ---- 3) 区局新公告 → 写入草稿(待人工转正) ----
  for (const feed of NOTICE_FEEDS) {
    const r = await fetchPage(feed.url);
    if (r.status === 0 || r.status >= 400) { console.error(`feed ${feed.key} 抓取失败 ${r.status || r.error}`); continue; }
    const notices = extractNotices(r.text, feed.url).sort((a, b) => b.date - a.date);
    if (!notices.length) continue;
    const latest = notices[0];
    const prev = state.feeds[feed.key] ? parseDate(state.feeds[feed.key].lastDate) : null;
    state.feeds[feed.key] = { lastDate: fmt(latest.date), lastTitle: latest.title, lastUrl: latest.url };
    if (prev && latest.date > prev && KW.test(latest.title)) {
      const draftId = `draft-${feed.key}-${fmt(latest.date)}`;
      if (!drafts.find(x => x.id === draftId)) {
        drafts.push({
          id: draftId, name: latest.title, category: '待分类(自动采集)',
          scope: feed.name, sourceUrl: latest.url,
          summary: '区局自动采集，待人工核实分类/金额/申报条件后转正',
          needsReview: true, estimated: true, collectedAt: NOW.toISOString(), collectedFrom: feed.name,
        });
        report.newNotices.push({ feed: feed.name, title: latest.title, date: fmt(latest.date), url: latest.url });
        report.changelog.push(`采集新政草稿 [${draftId}] ${feed.name}：${latest.title}`);
      }
    }
  }

  // ---- 4) 落地：归档 + 写草稿 + 写状态 ----
  let policiesChanged = false;
  if (toArchive.size) {
    for (const { policy, reason } of toArchive.values()) {
      archived.push({ ...policy, archivedAt: NOW.toISOString(), archiveReason: reason });
    }
    const removeIds = new Set(toArchive.keys());
    const next = policies.filter(p => !removeIds.has(p.id));
    if (next.length !== policies.length) { saveJSON(POLICIES_PATH, next); policiesChanged = true; }
    saveJSON(ARCHIVED_PATH, archived);
  }
  if (report.newNotices.length) saveJSON(DRAFT_PATH, drafts);

  state.lastRun = NOW.toISOString();
  saveJSON(STATE_PATH, state);

  // ---- 5) 变更日志(audit trail，替代原 issue) ----
  if (report.changelog.length) {
    const line = `\n## ${fmt(NOW)}\n\n` + report.changelog.map(c => `- ${c}`).join('\n') + '\n';
    try { fs.appendFileSync(CHANGELOG_PATH, line, 'utf8'); } catch (e) {}
  }

  // ---- 6) 汇总输出 ----
  const L = [];
  L.push(`# 🤖 政策库自动巡检报告 ${fmt(NOW)}`);
  L.push('');
  L.push(`> 全自动模式：发现问题已自动落地（归档失效/过期政策、采集新政草稿），无需人工复核。`);
  L.push('');
  L.push(`- 本次自动归档：${report.archivedDead.length + report.archivedExpired.length} 条`);
  L.push(`- 死链观察期(下次确认才归档)：${report.deadFirstStrike.length} 条`);
  L.push(`- 死链可疑(不动作)：${report.deadSuspect.length} 条`);
  L.push(`- 临期(<${NEAR_DAYS}天，仅提示)：${report.expiring.length} 条`);
  L.push(`- 新增新政草稿：${report.newNotices.length} 条`);
  L.push('');
  if (report.archivedDead.length) {
    L.push('## ❌ 自动归档：失效深链（连续两次确认）');
    report.archivedDead.forEach(x => L.push(`- [${x.id}] ${x.name}（HTTP ${x.status}）`));
    L.push('');
  }
  if (report.archivedExpired.length) {
    L.push('## 🕓 自动归档：已过期政策');
    report.archivedExpired.forEach(x => L.push(`- [${x.id}] ${x.name}（${x.expires}）`));
    L.push('');
  }
  if (report.deadFirstStrike.length) {
    L.push('## 👀 死链观察期（本次首现，下次巡检再确认才归档）');
    report.deadFirstStrike.forEach(x => L.push(`- [${x.id}] ${x.name}（HTTP ${x.status}）`));
    L.push('');
  }
  if (report.deadSuspect.length) {
    L.push('## ⚠️ 死链可疑（5xx/超时/连接失败，未动作）');
    report.deadSuspect.forEach(x => L.push(`- [${x.id}] ${x.name}（${x.status}）`));
    L.push('');
  }
  if (report.expiring.length) {
    L.push(`## ⏳ 临期提示(<${NEAR_DAYS}天，未动作)`);
    report.expiring.forEach(x => L.push(`- [${x.id}] ${x.name}（${x.expires}，剩 ${x.days} 天）`));
    L.push('');
  }
  if (report.newNotices.length) {
    L.push('## 🆕 新增新政草稿（已写入 policies_draft.json，待人工转正）');
    report.newNotices.forEach(x => L.push(`- 【${x.feed}】${x.title}（${x.date}）— ${x.url}`));
    L.push('');
  }
  if (report.changelog.length === 0) L.push('✅ 本次巡检无自动变更。');
  L.push('');

  const md = L.join('\n');
  console.log(md);
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, '\n' + md, 'utf8');
  }
  console.error(`policiesChanged=${policiesChanged}, draftsAdded=${report.newNotices.length}, archived=${toArchive.size}`);
}

main().catch(e => { console.error('监控脚本异常：', e); process.exit(1); });
