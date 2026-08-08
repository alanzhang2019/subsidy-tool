// 单文件版 UI 逻辑：工具视图（自测）+ 报告视图（hash 切换），均使用内联 POLICIES 与 engine
(function () {
  'use strict';
  const $ = id => document.getElementById(id);

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

  function renderTool(data, profile) {
    $('emptyState').style.display = 'none';
    $('summary').style.display = 'block';
    $('sumAmt').textContent = '¥' + data.total.toLocaleString() + ' 万';
    $('sumSub').textContent = `共匹配 ${data.okCount} 项可直接申报、${data.gapCount} 项需补条件（按封顶值测算，实际以审定为准）`;
    const cards = $('cards');
    cards.innerHTML = '';
    const order = { ok: 0, gap: 1, no: 2 };
    const sorted = [...data.results].sort((a, b) => order[a.status] - order[b.status]);
    sorted.forEach(r => {
      if (r.status === 'no') return;
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
    const code = window.SubsidyCodec.encodeProfile(profile);
    const base = location.href.split('#')[0];
    const shareUrl = `${base}#p=${code}`;
    $('share').classList.add('show');
    $('shareUrl').textContent = shareUrl;
    $('viewBtn').onclick = () => window.open(shareUrl, '_blank');
    $('pdfBtn').onclick = () => window.open(`${shareUrl}&print=1`, '_blank');
  }

  async function doMatch() {
    const btn = $('matchBtn');
    btn.disabled = true; btn.textContent = '匹配中…';
    try {
      const profile = readForm();
      const results = window.SubsidyEngine.matchAll(POLICIES, profile);
      const total = results.filter(r => r.status === 'ok').reduce((s, r) => s + (r.amount || 0), 0);
      const okCount = results.filter(r => r.status === 'ok').length;
      const gapCount = results.filter(r => r.status === 'gap').length;
      renderTool({ total, okCount, gapCount, results }, profile);
    } catch (e) {
      alert('匹配失败：' + e.message);
    } finally {
      btn.disabled = false; btn.textContent = '开始匹配补贴';
    }
  }

  function renderReport() {
    const hash = location.hash.startsWith('#') ? location.hash.slice(1) : location.hash;
    const params = new URLSearchParams(hash);
    const autoPrint = params.get('print') === '1';
    const pB64 = params.get('p');
    const content = $('content');
    if (!pB64) {
      content.innerHTML = '<div class="err"><div style="font-size:40px;opacity:.3">📭</div>缺少诊断参数（链接不完整）</div>';
      return;
    }
    let profile;
    try {
      profile = window.SubsidyCodec.decodeProfile(pB64);
    } catch (e) {
      content.innerHTML = '<div class="err"><div style="font-size:40px;opacity:.3">📭</div>诊断参数解析失败，请重新生成分享链接</div>';
      return;
    }
    const results = window.SubsidyEngine.matchAll(POLICIES, profile);
    const total = results.filter(r => r.status === 'ok').reduce((s, r) => s + (r.amount || 0), 0);
    const ok = results.filter(r => r.status === 'ok');
    const gap = results.filter(r => r.status === 'gap');
    const p = profile;
    const profileHtml = `
      <div class="kv">
        <div><b>所在区</b>${p.district}</div>
        <div><b>所属行业</b>${p.industry}</div>
        <div><b>企业规模</b>${p.scale}</div>
        <div><b>国家高企</b>${p.hightech}　<b>专精特新</b>${p.zxzz}</div>
        <div><b>营业收入</b>${p.revenue} 万元　<b>员工</b>${p.emp} 人</div>
        <div><b>研发投入</b>${p.rnd} 万元　<b>技改投资</b>${p.tech} 万元　<b>数字化投入</b>${p.digi} 万元</div>
      </div>`;
    const rowsHtml = [...ok, ...gap].map(r => {
      const st = r.status === 'ok' ? '<span class="st ok">✓ 符合</span>' : '<span class="st gap">△ 需补条件</span>';
      const amt = r.status === 'ok' ? `<div style="font-weight:700;color:var(--primary)">¥${r.amount} 万${r.estimated ? '（估）' : ''}</div>` : '<div style="color:var(--muted)">—</div>';
      const gaps = (r.gaps && r.gaps.length) ? `<div style="color:#b8860b;font-size:12px;margin-top:4px">待补：${r.gaps.join('；')}</div>` : '';
      const dist = r.scope ? (r.scope.type === 'citywide' ? '全市' : (r.scope.districts || []).join('/')) : '';
      return `<div class="r-row"><div class="l"><b>${r.name}</b><div class="s">${r.summary}</div><div class="s">来源：${r.sourceUrl ? `<a href="${r.sourceUrl}" target="_blank" rel="noopener">${r.source}</a>` : r.source}　|　区域：${dist}${r.estimated ? '　|　⚠️估算' : ''}${r.sourceUrl ? `　|　<a href="${r.sourceUrl}" target="_blank" rel="noopener" style="color:#c8102e">政策原文 ›</a>` : ''}</div>${gaps}</div><div class="r">${st}${amt}</div></div>`;
    }).join('');
    content.innerHTML = `
      <div class="report">
        <div class="r-head"><h1>深圳补贴匹配诊断报告</h1><div class="meta">生成时间 ${new Date().toLocaleString('zh-CN')}</div></div>
        <div class="r-sec"><h3>一、企业画像</h3>${profileHtml}</div>
        <div class="r-sec"><h3>二、预估可申报总额</h3><div class="total-big">¥${total} 万元</div><div style="font-size:12px;color:#888;margin-top:6px">按政策封顶值测算，实际以专项审计与评审为准；含 ${ok.length} 项可直接申报、${gap.length} 项需补条件。</div></div>
        <div class="r-sec"><h3>三、匹配政策明细</h3>${rowsHtml}</div>
        <div class="r-sec" style="font-size:12px;color:#999"><b>免责声明：</b>本报告由系统依据公开政策规则自动测算，金额与条件为简化模型，不构成申报承诺。真实申报须以官方最新指南、专项审计与专家评审结果为准；企业须确保数据真实合规（虚假材料将列入失信名单并追责）。本报告的测算数据仅在你的浏览器本地生成，未上传任何服务器。</div>
      </div>`;
    $('toolbar').style.display = 'flex';
    if (autoPrint) setTimeout(function () { window.print(); }, 300);
  }

  function route() {
    const h = location.hash || '';
    if (h.indexOf('p=') !== -1) {
      $('toolView').style.display = 'none';
      $('reportView').style.display = 'block';
      renderReport();
    } else {
      $('reportView').style.display = 'none';
      $('toolView').style.display = 'block';
    }
  }

  if ($('matchBtn')) $('matchBtn').addEventListener('click', doMatch);
  window.addEventListener('hashchange', route);
  route();
})();
