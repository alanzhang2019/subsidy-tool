'use strict';
// 申报日历：从 policies.json 解析申报窗口/截止日，渲染月历 + 常驻列表 + 详情弹窗

const CAT_COLORS = {
  '数字化': '#2f80ed', '研发': '#27ae60', '高企': '#16a085', '专精特新': '#8e44ad',
  '知识产权': '#d35400', '人才': '#e84393', '跨境电商': '#0984e3', '技改': '#e67e22',
  '其他': '#7f8c8d', '房租': '#b8860b', '稳岗就业': '#00b894', '贷款贴息': '#fd79a8',
  '税惠': '#7c3aed', '半导体': '#e74c3c', '项目申报': '#c8102e'
};
function colorFor(cat) {
  if (CAT_COLORS[cat]) return CAT_COLORS[cat];
  let h = 0; for (let i = 0; i < cat.length; i++) h = (h * 31 + cat.charCodeAt(i)) % 360;
  return `hsl(${h},55%,48%)`;
}

const NOW = new Date();
const TODAY = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate());
let policies = [];
let viewYear = NOW.getFullYear(), viewMonth = NOW.getMonth();
const WD = ['一', '二', '三', '四', '五', '六', '日'];

const $ = (id) => document.getElementById(id);

function parseExpires(s) {
  if (!s) return null;
  const m = s.match(/(\d{4})[-年.](\d{1,2})[-月.](\d{1,2})/);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3]);
}

// 从 deadline 文本抽取具体月份/日期（用于落格）
function extractDateHints(text, year) {
  if (!text) return [];
  const hints = [];
  let m;
  // YYYY.M 或 YYYY.M-M2（区间，两月都标）
  const reYear = /(\d{4})\.(\d{1,2})(?:-(\d{1,2}))?/g;
  while ((m = reYear.exec(text))) {
    const y = +m[1], mo = +m[2];
    hints.push(new Date(y, mo - 1, 15));
    if (m[3]) hints.push(new Date(y, (+m[3]) - 1, 15));
  }
  // M月D日（具体日）
  const reMD = /(\d{1,2})月(\d{1,2})日/g;
  while ((m = reMD.exec(text))) hints.push(new Date(year, +m[1] - 1, +m[2]));
  // 单 M月 或 M月-M月 区间（后面不是数字，避免与"月日"重复）
  const reM = /(\d{1,2})月(?![\d])/g;
  while ((m = reM.exec(text))) hints.push(new Date(year, +m[1] - 1, 15));
  return hints;
}

function isOpen(p) {
  if (p.expires) {
    const d = parseExpires(p.expires);
    if (d && d < TODAY) return false;
  }
  return true;
}

function filterPolicies() {
  const fd = $('fDistrict').value, fc = $('fCategory').value, fo = $('fOpen').checked;
  return policies.filter(p => {
    if (fd) {
      const sc = p.scope;
      const ok = sc && (sc.type === 'citywide' || (sc.districts && (sc.districts.includes(fd) || sc.districts.includes('全市'))));
      if (!ok) return false;
    }
    if (fc && p.category !== fc) return false;
    if (fo && !isOpen(p)) return false;
    return true;
  });
}

// 返回 {events:[{date,kind,policy}], recurring:[policy]}
function buildEvents(list) {
  const events = [], recurring = [];
  for (const p of list) {
    const evs = [];
    if (p.expires) {
      const d = parseExpires(p.expires);
      if (d) evs.push({ date: d, kind: 'deadline' });
    }
    if (evs.length === 0 && p.deadline) {
      const hints = extractDateHints(p.deadline, viewYear);
      hints.forEach(d => evs.push({ date: d, kind: 'window' }));
    }
    if (evs.length) events.push(...evs.map(e => ({ ...e, policy: p })));
    else recurring.push(p);
  }
  return { events, recurring };
}

function renderWeekdays() {
  const wd = $('weekdays'); wd.innerHTML = '';
  WD.forEach(d => { const c = document.createElement('div'); c.className = 'cal-weekday'; c.textContent = d; wd.appendChild(c); });
}

function renderCalendar() {
  const list = filterPolicies();
  const { events } = buildEvents(list);
  $('monthLabel').textContent = `${viewYear}年${viewMonth + 1}月`;
  const grid = $('grid'); grid.innerHTML = '';

  const first = new Date(viewYear, viewMonth, 1);
  let lead = (first.getDay() + 6) % 7; // Monday-first
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const prevDays = new Date(viewYear, viewMonth, 0).getDate();

  // 上月底补格
  for (let i = lead - 1; i >= 0; i--) {
    grid.appendChild(cell(prevDays - i, true, null));
  }
  // 当月
  for (let d = 1; d <= daysInMonth; d++) {
    const date = new Date(viewYear, viewMonth, d);
    const dayEvents = events.filter(e => e.date.getFullYear() === viewYear && e.date.getMonth() === viewMonth && e.date.getDate() === d);
    grid.appendChild(cell(d, false, dayEvents));
  }
  // 下月补格（凑满 6 行 = 42）
  const total = lead + daysInMonth;
  const trail = (7 - (total % 7)) % 7;
  for (let d = 1; d <= trail; d++) grid.appendChild(cell(d, true, null));
}

function cell(dayNum, out, dayEvents) {
  const c = document.createElement('div');
  c.className = 'cal-cell' + (out ? ' out' : '');
  if (!out) {
    const date = new Date(viewYear, viewMonth, dayNum);
    if (date.getTime() === TODAY.getTime()) c.classList.add('today');
  }
  const dn = document.createElement('div'); dn.className = 'dnum'; dn.textContent = dayNum; c.appendChild(dn);
  const chips = document.createElement('div'); chips.className = 'chips';
  if (dayEvents && dayEvents.length) {
    dayEvents.slice(0, 4).forEach(ev => {
      const chip = document.createElement('div');
      chip.className = 'cal-chip' + (ev.kind === 'deadline' ? ' deadline' : '');
      chip.style.background = colorFor(ev.policy.category);
      chip.textContent = ev.policy.name;
      chip.title = `${ev.policy.name}（${ev.kind === 'deadline' ? '截止日' : '受理窗口'}）`;
      chip.onclick = () => openModal(ev.policy);
      chips.appendChild(chip);
    });
    if (dayEvents.length > 4) {
      const more = document.createElement('div'); more.className = 'cal-chip';
      more.style.background = '#999'; more.textContent = `还有 ${dayEvents.length - 4} 条…`;
      chips.appendChild(more);
    }
  }
  c.appendChild(chips);
  return c;
}

function renderSidebar(list) {
  // legend
  const cats = [...new Set(list.map(p => p.category))];
  const lg = $('legend'); lg.innerHTML = '';
  cats.forEach(cat => {
    const el = document.createElement('span'); el.className = 'lg';
    el.innerHTML = `<span class="dot" style="background:${colorFor(cat)}"></span>${cat}`;
    lg.appendChild(el);
  });
  // recurring list
  const { recurring } = buildEvents(list);
  const al = $('alwaysList'); al.innerHTML = '';
  if (!recurring.length) { al.innerHTML = '<div class="empty-cal">无</div>'; return; }
  recurring.forEach(p => {
    const el = document.createElement('div'); el.className = 'always';
    el.innerHTML = `<span class="c" style="background:${colorFor(p.category)}">${p.category}</span>${p.name}`;
    el.onclick = () => openModal(p);
    al.appendChild(el);
  });
}

function formatAmount(a) {
  if (!a || !a.mode) return '以官方指南为准';
  const cap = a.cap ? `（封顶 ${a.cap}）` : '';
  if (a.mode === 'fixed') return `${a.value || ''} ${cap}`.trim();
  if (a.mode === 'percent') return `基数×${a.rate || ''}% ${cap}`.trim();
  if (a.mode === 'tiered') return `阶梯计发 ${cap}`.trim();
  if (a.mode === 'byTier') return `按档计发 ${cap}`.trim();
  return JSON.stringify(a);
}

function scopeText(sc) {
  if (!sc) return '—';
  if (sc.type === 'citywide') return '深圳市（全市）';
  if (sc.districts && sc.districts.length) return sc.districts.join('、');
  return sc.type || '—';
}

function openModal(p) {
  const body = $('modalBody');
  const tags = [];
  tags.push(`<span class="tag ok" style="background:${colorFor(p.category)};color:#fff">${p.category}</span>`);
  if (p.nonCash) tags.push(`<span class="tag tax">税惠·非资金</span>`);
  if (p.expires) tags.push(`<span class="tag bad">截止 ${p.expires}</span>`);
  else if (isOpen(p)) tags.push(`<span class="tag ok">受理中</span>`);
  let rows = '';
  rows += `<div class="mrow"><b>适用区域</b><span>${scopeText(p.scope)}</span></div>`;
  if (p.amount) rows += `<div class="mrow"><b>预估金额</b><span class="amt">${formatAmount(p.amount)}</span></div>`;
  if (p.estimated) rows += `<div class="mrow"><b></b><span class="est-tag">金额为模型估算，以官方审计/评审为准</span></div>`;
  rows += `<div class="mrow"><b>申报窗口</b><span>${p.deadline || '以官方指南为准'}</span></div>`;
  if (p.batch) rows += `<div class="mrow"><b>批次</b><span>${p.batch}</span></div>`;
  rows += `<div class="mrow"><b>截止日</b><span>${p.expires || '常年/年度受理（以当年指南为准）'}</span></div>`;
  if (p.summary) rows += `<div class="mrow"><b>要点</b><span>${p.summary}</span></div>`;
  if (p.sourceUrl) rows += `<div class="mrow"><b>政策原文</b><span><a class="src" href="${p.sourceUrl}" target="_blank" rel="noopener">${p.sourceUrl}</a></span></div>`;
  body.innerHTML = `<div class="mtags">${tags.join('')}</div><h2>${p.name}</h2>${rows}`;
  $('mask').classList.add('show');
}
function closeModal() { $('mask').classList.remove('show'); }

async function init() {
  renderWeekdays();
  try {
    const res = await fetch('policies.json', { cache: 'no-cache' });
    policies = await res.json();
  } catch (e) {
    $('grid').innerHTML = '<div class="empty-cal">政策库加载失败，请确认 policies.json 可访问</div>';
    return;
  }
  // 区域选项
  const districts = ['福田', '南山', '龙岗', '宝安', '龙华', '罗湖', '光明', '坪山', '盐田', '大鹏'];
  const fd = $('fDistrict');
  districts.forEach(d => { const o = document.createElement('option'); o.value = d; o.textContent = d + '区'; fd.appendChild(o); });
  // 分类选项
  const cats = [...new Set(policies.map(p => p.category))];
  const fc = $('fCategory');
  cats.forEach(c => { const o = document.createElement('option'); o.value = c; o.textContent = c; fc.appendChild(o); });

  const rerender = () => { renderCalendar(); renderSidebar(filterPolicies()); };
  $('prevM').onclick = () => { viewMonth--; if (viewMonth < 0) { viewMonth = 11; viewYear--; } rerender(); };
  $('nextM').onclick = () => { viewMonth++; if (viewMonth > 11) { viewMonth = 0; viewYear++; } rerender(); };
  $('todayBtn').onclick = () => { viewYear = NOW.getFullYear(); viewMonth = NOW.getMonth(); rerender(); };
  fd.onchange = rerender; fc.onchange = rerender; $('fOpen').onchange = rerender;
  $('closeModal').onclick = closeModal;
  $('mask').onclick = (e) => { if (e.target === $('mask')) closeModal(); };

  rerender();
}
init();
