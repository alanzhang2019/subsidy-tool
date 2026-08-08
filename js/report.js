// 报告页（纯静态版）：从 URL hash 读取编码后的画像 -> 本地引擎匹配 -> 渲染报告
const $ = id => document.getElementById(id);

function expNote(ex){
  if(!ex) return '';
  const d = new Date(ex + 'T00:00:00'); const now = new Date();
  const days = (d - now) / 86400000;
  if(days < 0) return ' <span class="exp expired">⚠️ 政策已到期，待续期确认</span>';
  if(days < 90) return ' <span class="exp expiring">⏳ 即将到期（' + Math.ceil(days) + '天）</span>';
  return '';
}

const hash = location.hash.startsWith('#') ? location.hash.slice(1) : location.hash;
const params = new URLSearchParams(hash);
const autoPrint = params.get('print') === '1';

async function init() {
  const pB64 = params.get('p');
  if (!pB64) return showErr('缺少诊断参数（链接不完整）');
  let profile;
  try {
    profile = window.SubsidyCodec.decodeProfile(pB64);
  } catch (e) {
    return showErr('诊断参数解析失败，请重新生成分享链接');
  }
  try {
    const res = await fetch('policies.json', { cache: 'no-cache' });
    if (!res.ok) return showErr('政策库加载失败 (' + res.status + ')');
    const ps = await res.json();
    const results = window.SubsidyEngine.matchAll(ps, profile);
    const rec = {
      id: 'L' + Math.random().toString(36).slice(2, 10),
      profile: profile,
      results: results,
      createdAt: new Date().toISOString()
    };
    render(rec);
    $('toolbar').style.display = 'flex';
    if (autoPrint) {
      // 等渲染完成再触发打印对话框（用户可在其中"另存为 PDF"）
      setTimeout(function () { window.print(); }, 300);
    }
  } catch (e) {
    showErr('加载失败：' + e.message);
  }
}

function showErr(msg) {
  $('content').innerHTML = `<div class="err"><div style="font-size:40px;opacity:.3">📭</div><p>${msg}</p><a href="index.html" class="btn" style="margin-top:16px;display:inline-block;padding:12px 28px;font-size:15px">← 返回补贴自测</a></div>`;
}

function render(rec) {
  const p = rec.profile;
  const total = rec.results.filter(r => r.status === 'ok').reduce((s, r) => s + (r.amount || 0), 0);
  const ok = rec.results.filter(r => r.status === 'ok');
  const gap = rec.results.filter(r => r.status === 'gap');

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
    const amt = r.nonCash
      ? '<div style="font-weight:700;color:#7c3aed">税收优惠</div><div style="color:var(--muted);font-size:12px">非资金补贴</div>'
      : (r.status === 'ok' ? `<div style="font-weight:700;color:var(--primary)">¥${r.amount} 万${r.estimated ? '（估）' : ''}</div>` : '<div style="color:var(--muted)">—</div>');
    const gaps = (r.gaps && r.gaps.length) ? `<div style="color:#b8860b;font-size:12px;margin-top:4px">待补：${r.gaps.join('；')}</div>` : '';
    const dist = r.scope ? (r.scope.type === 'citywide' ? '全市' : (r.scope.districts || []).join('/')) : '';
    const win = (r.deadline || r.batch || r.expires) ? `<div style="color:#0f766e;font-size:12px;margin-top:4px">🗓 申报窗口：${r.deadline || '—'}　|　批次：${r.batch || '—'}${r.expires ? `　|　有效期至 ${r.expires}` : ''}</div>${r.expires ? expNote(r.expires) : ''}` : '';
    const taxNote = r.nonCash ? `<div style="color:#7c3aed;font-size:12px;margin-top:4px">💡 税收优惠（非直接资金补贴），不计入可申报金额</div>` : '';
    return `<div class="r-row${r.expires && new Date(r.expires + 'T00:00:00') < new Date() ? ' expired' : ''}">
      <div class="l"><b>${r.name}</b><div class="s">${r.summary}</div><div class="s">来源：${r.sourceUrl ? `<a href="${r.sourceUrl}" target="_blank" rel="noopener">${r.source}</a>` : r.source}　|　区域：${dist}${r.estimated ? '　|　⚠️估算' : ''}${r.sourceUrl ? `　|　<a href="${r.sourceUrl}" target="_blank" rel="noopener" style="color:#c8102e">政策原文 ›</a>` : ''}</div>${gaps}${win}${taxNote}</div>
      <div class="r">${st}${amt}</div>
    </div>`;
  }).join('');

  $('content').innerHTML = `
    <div class="report">
      <div class="r-head">
        <h1>深圳补贴匹配诊断报告</h1>
        <div class="meta">报告编号 ${rec.id}　|　生成时间 ${new Date(rec.createdAt).toLocaleString('zh-CN')}</div>
      </div>
      <div class="r-sec"><h3>一、企业画像</h3>${profileHtml}</div>
      <div class="r-sec"><h3>二、预估可申报总额</h3><div class="total-big">¥${total} 万元</div>
        <div style="font-size:12px;color:#888;margin-top:6px">按政策封顶值测算，实际以专项审计与评审为准；含 ${ok.length} 项可直接申报、${gap.length} 项需补条件。</div></div>
      <div class="r-sec"><h3>三、匹配政策明细</h3>${rowsHtml}</div>
      <div class="r-sec" style="font-size:12px;color:#999">
        <b>免责声明：</b>本报告由系统依据公开政策规则自动测算，金额与条件为简化模型，不构成申报承诺。真实申报须以官方最新指南、专项审计与专家评审结果为准；企业须确保数据真实合规（虚假材料将列入失信名单并追责）。本报告的测算数据仅在你的浏览器本地生成，未上传任何服务器。
      </div>
    </div>`;
}

init();
