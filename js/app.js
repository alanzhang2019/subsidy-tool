// 前端逻辑（纯静态版）：读取画像 -> 本地引擎匹配 -> 渲染 -> 生成可分享诊断书
const $ = id => document.getElementById(id);

let POLICIES = null;
async function loadPolicies() {
  if (!POLICIES) {
    const res = await fetch('policies.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error('政策库加载失败 (' + res.status + ')');
    POLICIES = await res.json();
  }
  return POLICIES;
}

function readForm() {
  return {
    district: $('district').value,
    industry: $('industry').value,
    scale: $('scale').value,
    hightech: $('hightech').value,
    zxzz: $('zxzz').value,
    revenue: Number($('revenue').value) || 0,
    emp: Number($('emp').value) || 0,
    rnd: Number($('rnd').value) || 0,
    tech: Number($('tech').value) || 0,
    digi: Number($('digi').value) || 0
  };
}

$('matchBtn').addEventListener('click', async () => {
  const btn = $('matchBtn');
  btn.disabled = true; btn.textContent = '匹配中…';
  try {
    const profile = readForm();
    const ps = await loadPolicies();
    const results = window.SubsidyEngine.matchAll(ps, profile);
    const total = results.filter(r => r.status === 'ok').reduce((s, r) => s + (r.amount || 0), 0);
    const okCount = results.filter(r => r.status === 'ok').length;
    const gapCount = results.filter(r => r.status === 'gap').length;
    render({ total, okCount, gapCount, results }, profile);
  } catch (e) {
    alert('匹配失败：' + e.message);
  } finally {
    btn.disabled = false; btn.textContent = '开始匹配补贴';
  }
});

function render(data, profile) {
  $('emptyState').style.display = 'none';
  $('summary').style.display = 'block';
  $('sumAmt').textContent = '¥' + data.total.toLocaleString() + ' 万';
  $('sumSub').textContent = `共匹配 ${data.okCount} 项可直接申报、${data.gapCount} 项需补条件（按封顶值测算，实际以审定为准）`;

  const cards = $('cards');
  cards.innerHTML = '';
  // 排序：符合 -> 需补 -> 不符合
  const order = { ok: 0, gap: 1, no: 2 };
  const sorted = [...data.results].sort((a, b) => order[a.status] - order[b.status]);
  sorted.forEach(r => {
    if (r.status === 'no') return; // 不符合的不展示，避免信息过载
    const card = document.createElement('div');
    card.className = `card ${r.status}`;
    const tagText = r.status === 'ok' ? '完全符合' : '需补条件';
    const amt = r.status === 'ok' ? `预估 ${r.amount} 万元` : '—';
    card.innerHTML = `
      <div class="head"><div class="name">${r.name}</div><div class="tag ${r.status}">${tagText}</div></div>
      <div class="amt">${amt}</div>
      <div class="desc">${r.summary}</div>
      ${r.estimated ? '<div class="est">⚠️ 估算值，以官方最新指南为准</div>' : ''}
      ${r.gaps && r.gaps.length ? `<div class="gap">待补：${r.gaps.join('；')}</div>` : ''}
      <div class="src">来源：${r.sourceUrl ? `<a href="${r.sourceUrl}" target="_blank" rel="noopener">${r.source}</a>` : r.source}　|　适用区域：${r.district}${r.sourceUrl ? `　|　<a href="${r.sourceUrl}" target="_blank" rel="noopener" style="color:#c8102e">政策原文 ›</a>` : ''}</div>`;
    cards.appendChild(card);
  });

  // 分享 / 报告（画像编码进 URL hash，无需后端存储）
  const code = window.SubsidyCodec.encodeProfile(profile);
  const shareUrl = `${location.origin}${location.pathname.replace(/index\.html$/, '')}report.html#p=${code}`;
  $('share').classList.add('show');
  $('shareUrl').textContent = shareUrl;
  $('viewBtn').onclick = () => window.open(shareUrl, '_blank');
  $('pdfBtn').onclick = () => window.open(`${shareUrl}&print=1`, '_blank');
}
