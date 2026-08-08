// 浏览器端补贴匹配引擎（与 server.js / src/policies.js 行为一致，纯前端运行）
// 暴露为全局 window.SubsidyEngine，不依赖任何后端。
(function (global) {
  'use strict';

  // 计算金额
  function calcAmount(p, f) {
    const a = p.amount;
    if (!a) return 0;
    if (a.mode === 'fixed') return a.value || 0;
    if (a.mode === 'percent') {
      const base = Number(f[a.base]) || 0;
      return Math.min(base * a.rate, a.cap || Infinity);
    }
    if (a.mode === 'tiered') {
      const base = Number(f[a.base]) || 0;
      let amt = 0, prev = 0;
      for (const s of a.steps) {
        const upto = s.upto == null ? Infinity : s.upto;
        const seg = Math.min(base, upto) - prev;
        if (seg > 0) amt += seg * s.rate;
        prev = upto;
        if (base <= upto) break;
      }
      return a.cap ? Math.min(amt, a.cap) : amt;
    }
    if (a.mode === 'byTier') {
      return a.byTier[f[a.tierField || 'zxzz']] || 0;
    }
    return 0;
  }

  // 单条政策评估
  function evaluate(p, f) {
    // 区域范围
    if (p.scope && p.scope.type === 'district' && p.scope.districts && !p.scope.districts.includes(f.district)) {
      return { status: 'no', gaps: ['仅适用于 ' + (p.scope.districts || []).join('/')], amount: 0 };
    }
    // 行业
    if (p.applicableIndustries && p.applicableIndustries.length &&
        !p.applicableIndustries.includes(f.industry)) {
      return { status: 'no', gaps: ['行业不适用'], amount: 0 };
    }
    // 高企
    if (p.triggerNotHightech && f.hightech === '是') {
      return { status: 'no', gaps: [], amount: 0 };
    }
    if (p.needHightech && f.hightech !== '是') {
      return { status: 'no', gaps: ['需为国家高新技术企业'], amount: 0 };
    }
    // 专精特新层级
    if (p.needZxzz && p.needZxzz.length && !p.needZxzz.includes(f.zxzz)) {
      return { status: 'no', gaps: ['需为 ' + p.needZxzz.join('/') + ' 企业'], amount: 0 };
    }
    // 规模
    if (p.requireScale && p.requireScale.length && !p.requireScale.includes(f.scale)) {
      return { status: 'no', gaps: ['需为 ' + p.requireScale.join('/') + ' 企业'], amount: 0 };
    }
    // requireScaleOrHightech：规上 或 高企 满其一即可（缺 requireScale 时默认接受"规上"/"中小"）
    if (p.requireScaleOrHightech) {
      const scaleOk = (p.requireScale && p.requireScale.length)
        ? p.requireScale.includes(f.scale)
        : (f.scale === '规上' || f.scale === '中小');
      const hightechOk = f.hightech === '是';
      if (!scaleOk && !hightechOk) {
        return { status: 'no', gaps: ['需为规上企业或国家高新技术企业'], amount: 0 };
      }
    }
    // 投资/研发门槛（软缺口，可补）
    const gaps = [];
    if (p.minTechInvest && (Number(f.tech) || 0) < p.minTechInvest)
      gaps.push('技改/设备投资需 ≥ ' + p.minTechInvest + ' 万元');
    if (p.minDigiInvest && (Number(f.digi) || 0) < p.minDigiInvest)
      gaps.push('数字化投入需 ≥ ' + p.minDigiInvest + ' 万元');
    if (p.minRnd && (Number(f.rnd) || 0) < p.minRnd)
      gaps.push('研发投入需 ≥ ' + p.minRnd + ' 万元');
    // byTier 特殊：未达层级
    if (p.amount && p.amount.mode === 'byTier') {
      if (!p.amount.byTier[f[p.amount.tierField || 'zxzz']]) {
        if (f[p.amount.tierField || 'zxzz'] === '无')
          return { status: 'gap', gaps: [p.amount.tierHint || '建议申报对应层级'], amount: 0 };
        return { status: 'no', gaps: [], amount: 0 };
      }
    }
    if (gaps.length) return { status: 'gap', gaps, amount: 0 };
    return { status: 'ok', gaps: [], amount: calcAmount(p, f) };
  }

  // 全部匹配，并统一返回结构（含区域字符串、scope 对象，便于前端渲染复用）
  function matchAll(policies, f) {
    return (policies || []).map(function (p) {
      const r = evaluate(p, f);
      const scope = p.scope || { type: 'citywide' };
      return {
        id: p.id,
        name: p.name,
        category: p.category || '',
        scope: scope,
        summary: p.summary || '',
        source: p.source || '',
        sourceUrl: p.sourceUrl || '',
        estimated: !!p.estimated,
        district: scope.type === 'citywide' ? '全市' : (scope.districts || []).join('/'),
        status: r.status,
        gaps: r.gaps,
        amount: r.amount || 0
      };
    });
  }

  global.SubsidyEngine = { evaluate: evaluate, matchAll: matchAll, calcAmount: calcAmount };

  // 画像 <-> URL 安全编码
  function b64encode(str) {
    const b = btoa(encodeURIComponent(str).replace(/%([0-9A-F]{2})/g, function (_, h) {
      return String.fromCharCode('0x' + h);
    }));
    return b.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function b64decode(s) {
    let t = String(s).replace(/-/g, '+').replace(/_/g, '/');
    while (t.length % 4) t += '=';
    return decodeURIComponent(Array.prototype.map.call(atob(t), function (c) {
      return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
    }).join(''));
  }
  global.SubsidyCodec = {
    encodeProfile: function (profile) { return b64encode(JSON.stringify(profile)); },
    decodeProfile: function (code) { return JSON.parse(b64decode(code)); }
  };
})(window);
