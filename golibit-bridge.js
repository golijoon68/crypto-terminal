// ============================================================
// GoliBit v13 Frontend Bridge — اتصال موتور چندلایه و داشبورد یادگیری به Index.html
// ============================================================
import { DEFAULT_REGIME_WEIGHTS, DEFAULT_CONFIG, evaluateMarket } from './golibit-engine.js';
import { runWalkForwardBacktest } from './golibit-learning.js';

const LBANK_CFG = {
  ...DEFAULT_CONFIG,
  feeRoundTripPct: 0.12, // LBank Futures Taker 0.06% × 2
  slippagePct: 0.05,
};

const REGIME_FA = {
  TREND_UP: 'روند صعودی ▲',
  TREND_DOWN: 'روند نزولی ▼',
  RANGE: 'رنج / خنثی ↔',
  VOL_SQUEEZE: 'فشردگی نوسان (آماده شکست)',
  VOL_SHOCK: 'شوک نوسانی (پرریسک ⚠)',
  TRANSITION: 'تغییر احتمالی رژیم',
  UNKNOWN: 'نامشخص',
};

const LAYER_FA = {
  structure: 'ساختار بازار و فیبوناچی',
  smc: 'SMC (OB / FVG / Sweep)',
  priceAction: 'پرایس اکشن کندلی',
  momentum: 'مومنتوم (RSI/MACD/EMA)',
  volume: 'حجم، VWAP و جریان سفارش',
  derivatives: 'مشتقات (Funding/OI/L-S)',
  mtf: 'هماهنگی تایم‌فریم‌ها (MTF)',
  context: 'همبستگی BTC و سنتیمنت',
};

const $ = (id) => document.getElementById(id);
const fa = (n, d = 0) => (n == null || !Number.isFinite(Number(n)) ? '—' : Number(n).toLocaleString('fa-IR', { maximumFractionDigits: d }));
const usd = (n) => (n == null || !Number.isFinite(Number(n)) ? '—' : '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: Number(n) >= 1 ? 2 : 5 }));
const apiBase = () => ((typeof window.GL_API === 'string' && window.GL_API) || localStorage.getItem('proxy') || '').trim().replace(/\/+$/, '');
const BN = ['https://api.binance.com', 'https://data-api.binance.vision'];

async function bnJson(path) {
  for (const h of BN) {
    try {
      const r = await fetch(h + path);
      if (r.ok) return await r.json();
    } catch (_) {}
  }
  throw new Error('عدم دسترسی به داده کندل');
}

async function fetchClosedBars(sym, tf, limit = 200) {
  const d = await bnJson(`/api/v3/klines?symbol=${sym}&interval=${tf}&limit=${limit}`);
  return d.slice(0, -1).map((k) => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5], tb: +k[9] }));
}

let activeWeights = DEFAULT_REGIME_WEIGHTS;
let activeModelVer = 1;
let calBins = [];

async function syncCloudModel() {
  const api = apiBase();
  if (!api) return;
  try {
    const r = await (await fetch(api + '/engine/weights')).json();
    if (r && r.weights) {
      activeWeights = r.weights;
      activeModelVer = r.version_id || 1;
      calBins = Array.isArray(r.calibrationBins) ? r.calibrationBins : [];
    }
  } catch (_) {}
}

function calLookup(regime, score) {
  const b = calBins.find((x) => x.regime === regime && score >= x.score_low && score < x.score_high);
  return b ? { prob: b.empirical_prob, ciLow: b.ci_low, ciHigh: b.ci_high, n: b.sample_count } : null;
}

/* ---------- ۱. کارت سیگنال چندلایه کوانت در تب «سیگنال» ---------- */
function mountQuantCard() {
  const sigTab = $('tp-sig');
  if (!sigTab || $('quantCard')) return;
  const card = document.createElement('div');
  card.className = 'card scan';
  card.id = 'quantCard';
  card.innerHTML = `
    <div class="ph">
      <h3><span class="pulse"></span>موتور چندلایه کوانت v14 (کارمزد LBank)</h3>
      <span id="qBadge" class="badge neutral">آماده تحلیل</span>
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">
      <select id="qSym" style="flex:1;min-width:120px">
        <option value="BTCUSDT">BTCUSDT</option><option value="ETHUSDT">ETHUSDT</option>
        <option value="SOLUSDT">SOLUSDT</option><option value="SUIUSDT">SUIUSDT</option>
        <option value="ADAUSDT">ADAUSDT</option><option value="NEARUSDT">NEARUSDT</option>
        <option value="XRPUSDT">XRPUSDT</option><option value="LINKUSDT">LINKUSDT</option>
        <option value="BNBUSDT">BNBUSDT</option><option value="AVAXUSDT">AVAXUSDT</option>
      </select>
      <select id="qTf">
        <option value="15m">15m (نوسان‌گیری)</option>
        <option value="30m">30m</option>
        <option value="1h">1h (سوئینگ)</option>
        <option value="5m">5m (سریع)</option>
      </select>
      <button id="qRunBtn" class="btnx">تحلیل چندلایه</button>
    </div>
    <div id="qBody"><div class="sub">برای تحلیل هم‌زمان ساختار، SMC/ICT، تایم‌فریم‌ها، مشتقات و گیت ریسک دکمه بالا را بزن.</div></div>
  `;
  sigTab.appendChild(card); // v14: اسکالپ و اسکنر بالا، موتور کوانت زیر آن‌ها
  $('qRunBtn').addEventListener('click', runQuantSingle);
}

async function runQuantSingle() {
  const sym = $('qSym').value, tf = $('qTf').value, body = $('qBody'), badge = $('qBadge');
  badge.className = 'badge neutral'; badge.textContent = 'در حال تحلیل...';
  body.innerHTML = '<div class="sub">دریافت کندل‌های چندتایم‌فریم، همبستگی BTC و داده مشتقات...</div>';
  try {
    await syncCloudModel();
    const t0 = performance.now();
    const needTfs = [...new Set([tf, '15m', '1h', '4h', '1d'])];
    const [tfRes, btcRes, piRes, lsRes] = await Promise.all([
      Promise.allSettled(needTfs.map(async (k) => [k, await fetchClosedBars(sym, k, k === '1d' ? 120 : 180)])),
      sym !== 'BTCUSDT' ? fetchClosedBars('BTCUSDT', tf, 120).catch(() => null) : Promise.resolve(null),
      fetch(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${sym}`).then((r) => r.json()).catch(() => null),
      fetch(`https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${sym}&period=1h&limit=1`).then((r) => r.json()).catch(() => null),
    ]);

    const timeframes = {};
    tfRes.forEach((x) => { if (x.status === 'fulfilled') timeframes[x.value[0]] = x.value[1]; });
    const deriv = {
      fundingRatePct: piRes && piRes.lastFundingRate != null ? +piRes.lastFundingRate * 100 : null,
      longShortRatio: lsRes && lsRes[0] ? +lsRes[0].longShortRatio : null,
    };

    const savedRc = (() => { try { return JSON.parse(localStorage.getItem('rc') || '{}'); } catch (_) { return {}; } })();
    const riskContext = {
      accountEquity: parseFloat(savedRc.rcCap) || 1000,
      riskPct: parseFloat(savedRc.rcRisk) || 1,
      openTrades: [],
      dailyLossR: 0,
      lossStreak: 0,
    };

    const res = evaluateMarket(
      { symbol: sym, primaryTf: tf, timeframes, derivatives: deriv, btcBars: btcRes, riskContext, nowTs: Date.now() },
      activeWeights,
      LBANK_CFG,
      calLookup
    );
    const ms = Math.round(performance.now() - t0);

    const isLong = res.signal === 'LONG', isShort = res.signal === 'SHORT';
    badge.className = 'badge ' + (isLong ? 'long' : isShort ? 'short' : 'neutral');
    badge.textContent = res.signal + ' · v' + activeModelVer + ' (' + ms + 'ms)';

    let html = `<div class="sig ${isLong ? 'long' : isShort ? 'short' : 'neutral'}">
      ${sym.replace('USDT', '')} · ${res.signal === 'NO_TRADE' ? 'NO TRADE (ورود ممنوع)' : res.signal} | امتیاز ${fa(res.confidenceScore)} از ۱۰۰
      <div class="sub" style="margin-top:4px;color:inherit">رژیم بازار: ${REGIME_FA[res.regime] || res.regime}</div>
    </div>`;

    if (res.signal !== 'NO_TRADE') {
      html += `
        <div class="kv"><span>محدوده ورود</span><b>${usd(res.entryZone.low)} تا ${usd(res.entryZone.high)}</b></div>
        <div class="kv"><span>حد ضرر ساختاری (SL)</span><b class="down">${usd(res.stopLoss)}</b></div>
        <div class="kv"><span>TP1 | TP2 | TP3</span><b class="up">${usd(res.tp1)} | ${usd(res.tp2)} | ${usd(res.tp3)}</b></div>
        <div class="kv"><span>RR خالص (پس از کارمزد LBank)</span><b>${fa(res.rr.tp1, 2)} | ${fa(res.rr.tp2, 2)} | ${fa(res.rr.tp3, 2)}</b></div>
        <div class="kv"><span>احتمال کالیبره‌شده تاریخی</span><b>${res.calibratedProb ? fa(res.calibratedProb.prob * 100, 0) + '٪ (نمونه ' + fa(res.calibratedProb.n) + ')' : 'در حال جمع‌آوری داده (≥۳۰ نمونه)'}</b></div>
        <div class="kv"><span>مدت اعتبار سیگنال</span><b>${fa(res.ttlMinutes)} دقیقه</b></div>
      `;
      if (res.positionSize) {
        html += `<div class="kv"><span>حجم پیشنهادی (${fa(res.positionSize.riskPctApplied, 2)}٪ ریسک)</span><b>${res.positionSize.quantity} واحد (${usd(res.positionSize.notionalUsd)})</b></div>`;
      }
    }

    if (res.reasonsFor.length) html += '<div class="note">دلایل موافق:</div>' + res.reasonsFor.map((t) => `<div class="chk g">✓ ${t}</div>`).join('');
    if (res.reasonsAgainst.length) html += '<div class="note">عوامل مخالف / دلیل عدم ورود:</div>' + res.reasonsAgainst.map((t) => `<div class="chk w">⚠ ${t}</div>`).join('');
    if (res.invalidationConditions && res.invalidationConditions.length) {
      html += '<div class="note">شرایط ابطال تحلیل:</div>' + res.invalidationConditions.map((t) => `<div class="chk">⛔ ${t}</div>`).join('');
    }
    if (res.gates && res.gates.length) {
      html += '<details class="mini"><summary>گیت‌های ایمنی و مدیریت ریسک (' + fa(res.gates.filter((g) => g.ok).length) + '/' + fa(res.gates.length) + ')</summary>' +
        res.gates.map((g) => `<div class="kv"><span>${g.ok ? '✓' : '✗'} ${g.name}</span><b class="${g.ok ? 'up' : 'down'}">${g.detail}</b></div>`).join('') + '</details>';
    }
    body.innerHTML = html;
  } catch (e) {
    badge.className = 'badge short'; badge.textContent = 'خطا';
    body.innerHTML = `<div class="chk w">⚠ خطا در دریافت داده: ${e.message || e}</div>`;
  }
}

/* ---------- ۲. داشبورد مدیریت موتور یادگیری + بک‌تست Walk-Forward در تب «تحلیل» ---------- */
function mountEngineDashboard() {
  const tools = $('tp-tools');
  if (!tools || $('engineDash')) return;
  const card = document.createElement('div');
  card.className = 'card';
  card.id = 'engineDash';
  card.style.marginTop = '12px';
  card.innerHTML = `
    <div class="ph">
      <h3>🧠 داشبورد مدیریت موتور هوشمند و یادگیری (v13)</h3>
      <span id="edBadge" class="badge neutral">در حال اتصال...</span>
    </div>
    <div id="edBody" class="gd"><div class="sub">در حال دریافت وضعیت زنده از Cloudflare D1...</div></div>
    <div class="btnrow" id="edActions">
      <button id="edRefresh" class="btnx">به‌روزرسانی آمار موتور</button>
      <button id="edWfBtn" class="btnx">اجرای بک‌تست Walk-Forward (OOS)</button>
    </div>
    <div id="edWfOut" style="margin-top:10px"></div>
  `;
  tools.appendChild(card);

  if (localStorage.getItem('gl_isadm') === '1') {
    const bLearn = document.createElement('button');
    bLearn.className = 'btnx'; bLearn.textContent = '🧠 اجرای چرخه یادگیری';
    bLearn.addEventListener('click', () => adminEngineOp('/engine/learn'));
    const bRoll = document.createElement('button');
    bRoll.className = 'btnx warn'; bRoll.textContent = '↩ Rollback به نسخه قبل';
    bRoll.addEventListener('click', () => { if (confirm('مدل به نسخه قبلی برگردد؟')) adminEngineOp('/engine/rollback'); });
    $('edActions').append(bLearn, bRoll);
  }

  $('edRefresh').addEventListener('click', loadEngineDashboard);
  $('edWfBtn').addEventListener('click', runLiveWalkForward);
  loadEngineDashboard();
}

async function adminEngineOp(path) {
  const api = apiBase();
  let k = sessionStorage.getItem('gl_adm') || '';
  if (!k) { k = prompt('رمز مدیر:') || ''; if (k) sessionStorage.setItem('gl_adm', k); }
  if (!api || !k) return;
  try {
    const r = await (await fetch(api + path, { headers: { 'X-Key': k } })).json();
    alert(JSON.stringify(r, null, 2).slice(0, 600));
    loadEngineDashboard();
  } catch (e) { alert('خطا در ارتباط با Worker'); }
}

async function loadEngineDashboard() {
  const body = $('edBody'), badge = $('edBadge'), api = apiBase();
  if (!api) { badge.textContent = 'آدرس Worker تنظیم نشده'; body.innerHTML = '<div class="sub">آدرس Worker را در تب پنل وارد کن.</div>'; return; }
  try {
    const t0 = performance.now();
    const d = await (await fetch(api + '/engine/status')).json();
    const pingMs = Math.round(performance.now() - t0);
    if (!d || d.error) throw new Error(d?.error || 'خطای سرور');

    const hs = d.health?.status || 'WARMING_UP';
    badge.className = 'badge ' + (hs === 'HEALTHY' ? 'long' : hs === 'DEGRADED' ? 'short' : 'neutral');
    badge.textContent = `مدل v${d.model?.version_id || 1} · ${hs} · ${pingMs}ms`;

    const m = d.overall || {};
    let html = `
      <div class="kv"><span>صرافی و مدل کارمزد</span><b>${d.exchange || 'LBank Futures'} (کارمزد ۰٫۱۲٪ + لغزش ۰٫۰۵٪)</b></div>
      <div class="kv"><span>دیتابیس یادگیری (D1)</span><b class="${d.db ? 'up' : 'down'}">${d.db ? 'متصل و فعال ✓' : 'متصل نیست (بایندینگ DB را اضافه کن)'}</b></div>
      <div class="kv"><span>سیگنال‌های بسته‌شده | باز</span><b>${fa(m.n)} | ${fa(d.openCount || 0)}</b></div>
      <div class="kv"><span>نرخ برد واقعی (Win Rate)</span><b>${fa(m.winRate, 1)}٪ (${fa(m.wins)} برد / ${fa(m.losses)} باخت)</b></div>
      <div class="kv"><span>Profit Factor | Expectancy</span><b class="${(m.expectancyR || 0) >= 0 ? 'up' : 'down'}">${fa(m.profitFactor, 2)} | ${(m.expectancyR >= 0 ? '+' : '') + fa(m.expectancyR, 3)} R</b></div>
      <div class="kv"><span>Sharpe | Sortino | Max DD</span><b>${fa(m.sharpe, 2)} | ${fa(m.sortino, 2)} | ${fa(m.maxDrawdownR, 2)} R</b></div>
    `;

    if (d.layerAttribution && d.layerAttribution.length) {
      html += '<h3>عملکرد لایه‌های تحلیلی (بهترین تا ضعیف‌ترین)</h3><table><tr><td><b>لایه</b></td><td><b>تعداد</b></td><td><b>نرخ برد</b></td><td><b>میانگین R</b></td></tr>';
      d.layerAttribution.forEach((x) => {
        const wr = x.n ? (x.w / x.n) * 100 : 0;
        html += `<tr><td>${LAYER_FA[x.layer_name] || x.layer_name}</td><td>${fa(x.n)}</td><td>${fa(wr, 0)}٪</td><td style="color:${x.avg_r >= 0 ? 'var(--up)' : 'var(--down)'}">${fa(x.avg_r, 2)}</td></tr>`;
      });
      html += '</table>';
    }

    if (d.regimeMetrics && Object.keys(d.regimeMetrics).length) {
      html += '<h3>عملکرد به تفکیک رژیم بازار</h3><table><tr><td><b>رژیم</b></td><td><b>معاملات</b></td><td><b>برد</b></td><td><b>Expectancy</b></td></tr>';
      Object.entries(d.regimeMetrics).forEach(([reg, rm]) => {
        html += `<tr><td>${REGIME_FA[reg] || reg}</td><td>${fa(rm.n)}</td><td>${fa(rm.winRate, 0)}٪</td><td style="color:${rm.expectancyR >= 0 ? 'var(--up)' : 'var(--down)'}">${fa(rm.expectancyR, 2)} R</td></tr>`;
      });
      html += '</table>';
    }

    if (d.model?.weights) {
      html += '<details class="mini"><summary>وزن فعلی لایه‌ها در رژیم‌های بازار (نسخه v' + d.model.version_id + ')</summary>';
      Object.entries(d.model.weights).forEach(([reg, wm]) => {
        const parts = Object.entries(wm).map(([k, v]) => `${k}:${v}`).join(' · ');
        html += `<div class="note"><b>${REGIME_FA[reg] || reg}:</b> ${parts}</div>`;
      });
      html += '</details>';
    }
    body.innerHTML = html;
  } catch (e) {
    badge.className = 'badge short'; badge.textContent = 'قطع';
    body.innerHTML = `<div class="chk w">⚠ داشبورد موتور پاسخ نداد: ${e.message || e}</div>`;
  }
}

async function runLiveWalkForward() {
  const out = $('edWfOut');
  const sym = ($('coin') && $('coin').value) || 'BTCUSDT';
  out.innerHTML = `<div class="sub">در حال دریافت تاریخچه ۱۰۰۰ کندلی برای ${sym} و اجرای Walk-Forward Out-of-Sample (با کارمزد LBank)...</div>`;
  try {
    const [m15, h1, h4, d1, btc15] = await Promise.all([
      fetchClosedBars(sym, '15m', 1000),
      fetchClosedBars(sym, '1h', 600),
      fetchClosedBars(sym, '4h', 300),
      fetchClosedBars(sym, '1d', 150),
      sym !== 'BTCUSDT' ? fetchClosedBars('BTCUSDT', '15m', 1000) : Promise.resolve(null),
    ]);
    const res = runWalkForwardBacktest({
      symbol: sym,
      primaryTf: '15m',
      allTimeframes: { '15m': m15, '1h': h1, '4h': h4, '1d': d1 },
      btcBars: btc15,
      config: LBANK_CFG,
      initialWeights: activeWeights,
      trainWindowBars: 280,
      testWindowBars: 140,
    });
    if (res.error) { out.innerHTML = `<div class="chk w">⚠ ${res.error}</div>`; return; }
    const o = res.overallOOS;
    let html = `
      <div class="note"><b>نتیجه تست خارج از نمونه (Walk-Forward OOS) روی ${sym} با کارمزد LBank:</b></div>
      <div class="kv"><span>تعداد معاملات OOS (برد / باخت)</span><b>${fa(o.n)} (${fa(o.wins)} / ${fa(o.losses)})</b></div>
      <div class="kv"><span>Win Rate | Profit Factor</span><b>${fa(o.winRate, 1)}٪ | ${fa(o.profitFactor, 2)}</b></div>
      <div class="kv"><span>Net R | Expectancy</span><b class="${o.netR >= 0 ? 'up' : 'down'}">${(o.netR >= 0 ? '+' : '') + fa(o.netR, 2)} R | ${fa(o.expectancyR, 3)} R</b></div>
      <div class="kv"><span>Max Drawdown | Sharpe | Sortino</span><b>${fa(o.maxDrawdownR, 2)} R | ${fa(o.sharpe, 2)} | ${fa(o.sortino, 2)}</b></div>
    `;
    const regs = Object.entries(res.regimeBreakdown || {});
    if (regs.length) {
      html += '<div class="note">تفکیک رژیم در Out-of-Sample: ' +
        regs.map(([r, m]) => `${REGIME_FA[r] || r}: ${fa(m.n)} معامله (${fa(m.netR, 1)}R)`).join(' | ') + '</div>';
    }
    out.innerHTML = html;
  } catch (e) {
    out.innerHTML = `<div class="chk w">⚠ خطا در Walk-Forward: ${e.message || e}</div>`;
  }
}

window.addEventListener('DOMContentLoaded', () => {
  mountQuantCard();
  mountEngineDashboard();
  syncCloudModel();
  setInterval(syncCloudModel, 300000);
});