// ============================================================
// GoliBit v14.5 Frontend Bridge — موتور خودکار کوانت (HUD دیجیتال) + مانیتور زنده یادگیری دوگانه
// ============================================================
import { DEFAULT_REGIME_WEIGHTS, DEFAULT_CONFIG, evaluateMarket } from './golibit-engine.js';
import { runWalkForwardBacktest } from './golibit-learning.js';

const LBANK_CFG = {
  ...DEFAULT_CONFIG,
  feeRoundTripPct: 0.12,
  slippagePct: 0.05,
};

const QUANT_DEFAULT_COINS = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT',
  'DOGEUSDT', 'AVAXUSDT', 'LINKUSDT', 'NEARUSDT', 'SUIUSDT', 'TRXUSDT',
  'LTCUSDT', 'INJUSDT', 'AAVEUSDT', 'ZECUSDT',
];

const REGIME_FA = {
  TREND_UP: 'روند صعودی ▲',
  TREND_DOWN: 'روند نزولی ▼',
  RANGE: 'رنج / خنثی ↔',
  VOL_SQUEEZE: 'فشردگی نوسان (آماده شکست)',
  VOL_SHOCK: 'شوک نوسانی (پرریسک ⚠)',
  TRANSITION: 'تغییر احتمالی رژیم',
  TREND: 'روندی (اسکالپ)',
  MIXED: 'مختلط (اسکالپ)',
  CHOP: 'نوسانی/رنج (اسکالپ)',
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
  flow: 'جریان سفارش زنده',
  price: 'ساختار و روند ۵m/۱h',
  book: 'عدم‌توازن دفتر سفارش',
  deriv: 'مشتقات/فاندینگ',
};

const DEC_FA = {
  PROMOTED: '✅ ارتقا یافت',
  KEPT: '⏸ بدون تغییر (Holdout)',
  SKIPPED: '⏳ جمع‌آوری نمونه',
  ROLLED_BACK: '↩ بازگشت ایمن',
  ERROR: '⚠ خطا',
};

const $ = (id) => document.getElementById(id);
const fa = (n, d = 0) => (n == null || !Number.isFinite(Number(n)) ? '—' : Number(n).toLocaleString('fa-IR', { maximumFractionDigits: d }));
const usd = (n) => (n == null || !Number.isFinite(Number(n)) ? '—' : '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: Number(n) >= 1 ? 2 : 5 }));
const fmtTime = (t) => (!t ? '—' : new Date(t).toLocaleString('fa-IR', { timeZone: 'Asia/Tehran', hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }));
const apiBase = () => ((typeof window.GL_API === 'string' && window.GL_API) || 'https://golbit-api.golijoon68.workers.dev').trim().replace(/\/+$/, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  const b = calBins.find((x) => x.regime === regime && score >= x.score_low && score < x.score_high) ||
    calBins.find((x) => x.regime === 'ALL' && score >= x.score_low && score < x.score_high);
  return b ? { prob: b.empirical_prob, ciLow: b.ci_low, ciHigh: b.ci_high, n: b.sample_count } : null;
}

/* ---------- قفل ایمنی بازگشایی آمریکا (±۵ دقیقه) و فیلتر شلوغی متعادل ---------- */
function isUsOpenLock(now = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
    }).formatToParts(now);
    const g = (t) => parts.find((p) => p.type === t)?.value;
    const wd = g('weekday');
    if (wd === 'Sat' || wd === 'Sun') return false;
    const mins = Number(g('hour')) * 60 + Number(g('minute'));
    return mins >= 565 && mins <= 575; // 09:25 تا 09:35 به وقت نیویورک
  } catch (_) {
    return false;
  }
}

function calcRollingVwap(bars) {
  if (!Array.isArray(bars) || !bars.length) return null;
  const slice = bars.slice(-48);
  let pv = 0, v = 0;
  for (const b of slice) {
    const tp = (b.h + b.l + b.c) / 3;
    const vol = Number(b.v) || 0;
    pv += tp * vol;
    v += vol;
  }
  return v > 0 ? pv / v : null;
}

function applyQuantGuards(rawRes, { deriv, btcLs, bars }) {
  const res = {
    ...rawRes,
    reasonsFor: [...(rawRes.reasonsFor || [])],
    reasonsAgainst: [...(rawRes.reasonsAgainst || [])],
    gates: [...(rawRes.gates || [])],
  };

  // ۱) قفل ایمنی ۵ دقیقه قبل و بعد از بازگشایی بورس آمریکا
  const usLocked = isUsOpenLock();
  res.gates.push({
    name: 'قفل بازگشایی آمریکا (±۵دقیقه)',
    ok: !usLocked,
    detail: usLocked ? 'فعال (09:25–09:35 NY)' : 'آزاد',
  });
  if (usLocked && res.signal !== 'NO_TRADE') {
    res.signal = 'NO_TRADE';
    res.reasonsAgainst.unshift('قفل ایمنی بازگشایی آمریکا (±۵ دقیقه) برای جلوگیری از نوسان شلاقی فعال است');
  }

  // ۲) فیلتر شلوغی متعادل (نسبت لانگ/شورت خود ارز + وتوی بیت‌کوین)
  const symLs = Number.isFinite(deriv?.longShortRatio) ? deriv.longShortRatio : null;
  const bLs = Number.isFinite(btcLs) ? btcLs : null;
  const fund = Number.isFinite(deriv?.fundingRatePct) ? deriv.fundingRatePct : null;
  const vwap = calcRollingVwap(bars);
  const lastC = Array.isArray(bars) && bars.length ? bars[bars.length - 1].c : null;
  const maxLs = Math.max(symLs || 0, bLs || 0);
  const minLs = Math.min(symLs || 99, bLs || 99);

  if (res.signal === 'LONG' && maxLs > 0) {
    const dangerConfirm = (fund != null && fund >= 0.03) || (vwap != null && lastC != null && lastC < vwap);
    if (maxLs > 2.7 && dangerConfirm) {
      res.signal = 'NO_TRADE';
      res.gates.push({ name: 'فیلتر شلوغی بازار (L/S)', ok: false, detail: `تله لانگ (L/S ${maxLs.toFixed(2)})` });
      res.reasonsAgainst.unshift(`جمعیت لانگ اشباع شده (L/S ${maxLs.toFixed(2)}) همراه با ریسک جاروی نقدینگی`);
    } else if (maxLs >= 2.3) {
      const pen = maxLs > 2.7 ? 6 : 5;
      res.confidenceScore = Math.max(0, Math.round(res.confidenceScore - pen));
      res.gates.push({ name: 'فیلتر شلوغی بازار (L/S)', ok: true, detail: `هشدار ملایم (${maxLs.toFixed(2)} | -${pen})` });
      res.reasonsAgainst.push(`جمعیت لانگ نسبتاً زیاد است (L/S ${maxLs.toFixed(2)} | جریمه -${pen} امتیاز)`);
      if (res.confidenceScore < (LBANK_CFG.minConfidence || 68)) res.signal = 'NO_TRADE';
    } else {
      res.gates.push({ name: 'فیلتر شلوغی بازار (L/S)', ok: true, detail: `سالم (${maxLs.toFixed(2)})` });
    }
  } else if (res.signal === 'SHORT' && minLs < 99) {
    const dangerConfirm = (fund != null && fund <= -0.03) || (vwap != null && lastC != null && lastC > vwap);
    if (minLs < 0.37 && dangerConfirm) {
      res.signal = 'NO_TRADE';
      res.gates.push({ name: 'فیلتر شلوغی بازار (L/S)', ok: false, detail: `تله شورت (L/S ${minLs.toFixed(2)})` });
      res.reasonsAgainst.unshift(`جمعیت شورت اشباع شده (L/S ${minLs.toFixed(2)}) همراه با ریسک اسکوئیز`);
    } else if (minLs <= 0.43) {
      const pen = minLs < 0.37 ? 6 : 5;
      res.confidenceScore = Math.max(0, Math.round(res.confidenceScore - pen));
      res.gates.push({ name: 'فیلتر شلوغی بازار (L/S)', ok: true, detail: `هشدار ملایم (${minLs.toFixed(2)} | -${pen})` });
      res.reasonsAgainst.push(`جمعیت شورت نسبتاً زیاد است (L/S ${minLs.toFixed(2)} | جریمه -${pen} امتیاز)`);
      if (res.confidenceScore < (LBANK_CFG.minConfidence || 68)) res.signal = 'NO_TRADE';
    } else {
      res.gates.push({ name: 'فیلتر شلوغی بازار (L/S)', ok: true, detail: `سالم (${minLs.toFixed(2)})` });
    }
  } else {
    const refLs = symLs || bLs;
    res.gates.push({ name: 'فیلتر شلوغی بازار (L/S)', ok: true, detail: refLs ? `L/S ${refLs.toFixed(2)}` : '—' });
  }

  return res;
}

/* ---------- ۱. نمایشگر دیجیتال خودکار کوانت (HUD) در تب «سیگنال» ---------- */
let qTf = '15m';
let qScanning = false;
let qResults = [];
let qSelectedSym = null;
let qLastSweepAt = 0;
let qNextSweepAt = 0;
let qBtcLs = null;
const qAlerted = {};
const Q_SWEEP_MS = 90000; // هر ۹۰ ثانیه یک دور کامل روی کل ۱۶ ارز

function injectQuantHudStyle() {
  if ($('qHudCss')) return;
  const st = document.createElement('style');
  st.id = 'qHudCss';
  st.textContent = `
    .qhud{background:radial-gradient(120% 90% at 100% 0%,rgba(56,189,248,.11),transparent 55%),linear-gradient(180deg,#080f1e,#0b1324);border:1px solid rgba(56,189,248,.28);border-radius:14px;padding:12px;margin-bottom:10px;box-shadow:inset 0 0 24px rgba(14,165,233,.06)}
    .qhud-top{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:10px}
    .qhud-pills{display:flex;gap:6px;align-items:center}
    .qtf-btn{background:rgba(15,23,42,.85);color:#94a3b8;border:1px solid rgba(148,163,184,.25);border-radius:8px;padding:4px 10px;font-size:11px;font-weight:700;cursor:pointer;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
    .qtf-btn.on{background:rgba(14,165,233,.2);color:#38bdf8;border-color:#38bdf8;box-shadow:0 0 10px rgba(56,189,248,.25)}
    .qhud-main{display:grid;grid-template-columns:1fr auto;gap:12px;align-items:center;padding:10px 12px;border-radius:12px;background:rgba(2,6,23,.65);border:1px solid rgba(148,163,184,.16)}
    .qhud-main.long{border-color:rgba(34,197,94,.55);box-shadow:0 0 18px rgba(34,197,94,.14)}
    .qhud-main.short{border-color:rgba(244,63,94,.55);box-shadow:0 0 18px rgba(244,63,94,.14)}
    .qhud-sym{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:20px;font-weight:800;letter-spacing:.6px;color:#f8fafc;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
    .qhud-state{font-size:11px;font-weight:800;padding:2px 8px;border-radius:99px;letter-spacing:.4px}
    .qhud-state.long{background:rgba(34,197,94,.18);color:#4ade80;border:1px solid rgba(34,197,94,.5)}
    .qhud-state.short{background:rgba(244,63,94,.18);color:#fb7185;border:1px solid rgba(244,63,94,.5)}
    .qhud-state.standby{background:rgba(245,158,11,.14);color:#fbbf24;border:1px solid rgba(245,158,11,.4)}
    .qhud-scorebox{text-align:center;min-width:86px;padding:6px 10px;border-radius:10px;background:rgba(15,23,42,.9);border:1px solid rgba(148,163,184,.18)}
    .qhud-num{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-variant-numeric:tabular-nums;font-size:28px;font-weight:900;line-height:1;letter-spacing:-.5px}
    .qhud-num.long{color:#4ade80;text-shadow:0 0 14px rgba(74,222,128,.45)}
    .qhud-num.short{color:#fb7185;text-shadow:0 0 14px rgba(251,113,133,.45)}
    .qhud-num.standby{color:#38bdf8;text-shadow:0 0 12px rgba(56,189,248,.35)}
    .qhud-segs{display:flex;gap:2px;margin-top:6px;justify-content:center}
    .qhud-segs i{display:block;width:6px;height:6px;border-radius:2px;background:rgba(148,163,184,.18)}
    .qhud-segs i.on.long{background:#4ade80;box-shadow:0 0 6px #4ade80}
    .qhud-segs i.on.short{background:#fb7185;box-shadow:0 0 6px #fb7185}
    .qhud-segs i.on.standby{background:#38bdf8;box-shadow:0 0 6px #38bdf8}
    .qhud-bar{height:4px;border-radius:99px;background:rgba(148,163,184,.14);overflow:hidden;margin:10px 0 8px}
    .qhud-bar>div{height:100%;background:linear-gradient(90deg,#0ea5e9,#38bdf8,#4ade80);transition:width .25s ease}
    .qhud-tel{display:flex;justify-content:space-between;align-items:center;gap:6px;flex-wrap:wrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-variant-numeric:tabular-nums;font-size:11px;color:#94a3b8}
    .qhud-leds{display:flex;flex-wrap:wrap;gap:5px;margin-top:8px}
    .qled{display:inline-flex;align-items:center;gap:4px;font-size:10.5px;padding:3px 7px;border-radius:7px;background:rgba(15,23,42,.8);border:1px solid rgba(148,163,184,.16);color:#cbd5e1}
    .qled b{width:6px;height:6px;border-radius:50%;display:inline-block}
    .qled.ok b{background:#4ade80;box-shadow:0 0 6px #4ade80}
    .qled.bad{border-color:rgba(244,63,94,.4);color:#fda4af}
    .qled.bad b{background:#fb7185;box-shadow:0 0 6px #fb7185}
    .qhud-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;margin-top:10px}
    .qhud-cell{background:rgba(15,23,42,.72);border:1px solid rgba(148,163,184,.14);border-radius:9px;padding:7px 9px}
    .qhud-cell span{display:block;font-size:10.5px;color:#94a3b8;margin-bottom:2px}
    .qhud-cell b{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-variant-numeric:tabular-nums;font-size:13px;color:#f8fafc}
    .qhud-tabs{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
    .qhud-tab{cursor:pointer;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;font-weight:700;padding:4px 8px;border-radius:8px;background:rgba(15,23,42,.85);border:1px solid rgba(148,163,184,.2);color:#cbd5e1}
    .qhud-tab.on{border-color:#38bdf8;color:#38bdf8;background:rgba(56,189,248,.12)}
    .qhud-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:5px;margin-top:6px}
    .qhud-row{display:flex;justify-content:space-between;align-items:center;padding:5px 8px;border-radius:8px;background:rgba(15,23,42,.6);border:1px solid rgba(148,163,184,.12);font-size:11px;cursor:pointer}
    .qhud-row:hover{border-color:#38bdf8}
  `;
  document.head.appendChild(st);
}

function getQuantCoinList() {
  try {
    const saved = JSON.parse(localStorage.getItem('sel_scan') || 'null');
    if (Array.isArray(saved) && saved.length >= 4) {
      return [...new Set([...saved, 'ZECUSDT'])].slice(0, 16);
    }
  } catch (_) {}
  return QUANT_DEFAULT_COINS;
}

function showQuantToast(sym, res) {
  const host = $('toasts');
  if (!host) return;
  const key = `${sym}_${res.signal}_${qTf}`;
  if (qAlerted[key] && Date.now() - qAlerted[key] < 1800000) return;
  qAlerted[key] = Date.now();
  const el = document.createElement('div');
  el.className = 'toast ' + (res.signal === 'LONG' ? 'long' : 'short');
  el.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
      <b>🧠 کوانت خودکار · ${sym.replace('USDT', '')} ${res.signal === 'LONG' ? '🟢 LONG' : '🔴 SHORT'} (${qTf})</b>
      <button type="button" style="min-width:36px;min-height:36px;border-radius:50%;border:1px solid rgba(255,255,255,.25);background:rgba(0,0,0,.35);color:#fff;font-size:15px;cursor:pointer">✕</button>
    </div>
    <div style="font-size:12px">امتیاز ${fa(res.confidenceScore)} | ورود: ${usd(res.entryZone?.low)}–${usd(res.entryZone?.high)}</div>
    <div style="font-size:12px">SL: ${usd(res.stopLoss)} | TP1: ${usd(res.tp1)} | RR: ${fa(res.rr?.tp1, 2)}</div>
  `;
  el.querySelector('button').addEventListener('click', (e) => { e.stopPropagation(); el.remove(); });
  host.prepend(el);
  setTimeout(() => { if (el.parentNode) el.remove(); }, 20000);
}

function mountQuantCard() {
  const sigTab = $('tp-sig');
  if (!sigTab || $('quantCard')) return;
  injectQuantHudStyle();
  const card = document.createElement('div');
  card.className = 'card scan';
  card.id = 'quantCard';
  card.innerHTML = `
    <div class="ph">
      <h3><span class="pulse"></span>موتور خودکار کوانت v14.5 · HUD</h3>
      <span id="qBadge" class="badge neutral">رادار آماده</span>
    </div>
    <div class="qhud">
      <div class="qhud-top">
        <div class="qhud-pills">
          <button type="button" class="qtf-btn on" data-qtf="15m">15m نوسان</button>
          <button type="button" class="qtf-btn" data-qtf="1h">1h سوئینگ</button>
          <button type="button" id="qRescanBtn" class="qtf-btn" title="اسکن فوری">↻</button>
        </div>
        <div id="qStatusLine" class="qhud-tel">در حال راه‌اندازی رادار ۱۶ ارز...</div>
      </div>
      <div id="qBody"><div class="sub">در حال اسکن خودکار ۱۶ ارز (از جمله ZEC) با فیلتر شلوغی و قفل بازگشایی آمریکا...</div></div>
      <div class="qhud-bar"><div id="qProgFill" style="width:0%"></div></div>
      <div class="qhud-tel">
        <span id="qLockStat">قفل آمریکا: بررسی...</span>
        <span id="qBtcLsStat">BTC L/S: —</span>
        <span id="qTimerStat">اسکن بعدی: —</span>
      </div>
    </div>
  `;
  sigTab.prepend(card);

  card.querySelectorAll('[data-qtf]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const next = btn.getAttribute('data-qtf');
      if (next === qTf) return;
      qTf = next;
      card.querySelectorAll('[data-qtf]').forEach((b) => b.classList.toggle('on', b.getAttribute('data-qtf') === qTf));
      qResults = [];
      qSelectedSym = null;
      runAutoQuantSweep(true);
    });
  });
  $('qRescanBtn').addEventListener('click', () => runAutoQuantSweep(true));

  // به‌روزرسانی ثانیه‌شمار دیجیتال و وضعیت قفل آمریکا
  setInterval(updateQuantTelemetryBar, 1000);
  runAutoQuantSweep(true);
}

function updateQuantTelemetryBar() {
  const lockEl = $('qLockStat');
  const timerEl = $('qTimerStat');
  const btcEl = $('qBtcLsStat');
  if (!lockEl || !timerEl) return;

  const locked = isUsOpenLock();
  lockEl.innerHTML = locked
    ? '<b style="color:#fb7185">🔒 قفل آمریکا فعال (±۵دقیقه)</b>'
    : '<span style="color:#4ade80">● بازگشایی آمریکا: آزاد</span>';
  if (btcEl) {
    btcEl.innerHTML = qBtcLs != null
      ? `BTC L/S: <b style="color:${qBtcLs >= 2.3 ? '#fbbf24' : '#cbd5e1'}">${qBtcLs.toFixed(2)}</b>`
      : 'BTC L/S: —';
  }

  if (qScanning) {
    timerEl.textContent = 'در حال اسکن زنده...';
    return;
  }
  const rem = Math.max(0, Math.ceil((qNextSweepAt - Date.now()) / 1000));
  const mm = String(Math.floor(rem / 60)).padStart(2, '0');
  const ss = String(rem % 60).padStart(2, '0');
  timerEl.textContent = `دور بعد: ${mm}:${ss}`;
  if (rem === 0 && !document.hidden && qNextSweepAt > 0) {
    runAutoQuantSweep(false);
  }
}

function renderQuantHud() {
  const body = $('qBody');
  const badge = $('qBadge');
  if (!body || !badge) return;

  if (!qResults.length) {
    body.innerHTML = '<div class="sub">در حال جمع‌آوری داده چندتایم‌فریم و مشتقات ۱۶ ارز...</div>';
    return;
  }

  const ranked = [...qResults].sort((a, b) => {
    const aAct = a.res.signal !== 'NO_TRADE' ? 1 : 0;
    const bAct = b.res.signal !== 'NO_TRADE' ? 1 : 0;
    if (aAct !== bAct) return bAct - aAct;
    return (b.res.confidenceScore || 0) - (a.res.confidenceScore || 0);
  });

  const activeList = ranked.filter((x) => x.res.signal !== 'NO_TRADE');
  const picked = ranked.find((x) => x.sym === qSelectedSym) || activeList[0] || ranked[0];
  const { sym, res, ms } = picked;
  const isLong = res.signal === 'LONG', isShort = res.signal === 'SHORT';
  const cls = isLong ? 'long' : isShort ? 'short' : 'standby';

  badge.className = 'badge ' + (isLong ? 'long' : isShort ? 'short' : 'neutral');
  badge.textContent = activeList.length
    ? `${fa(activeList.length)} سیگنال فعال · v${activeModelVer}`
    : `آماده‌باش (${fa(qResults.length)} ارز) · v${activeModelVer}`;

  const segsOn = Math.max(0, Math.min(10, Math.round((res.confidenceScore || 0) / 10)));
  const segHtml = Array.from({ length: 10 }, (_, i) => `<i class="${i < segsOn ? 'on ' + cls : ''}"></i>`).join('');

  let html = `
    <div class="qhud-main ${cls}">
      <div>
        <div class="qhud-sym">
          <span>${sym.replace('USDT', '')}/USDT</span>
          <span class="qhud-state ${cls}">${isLong ? 'LONG ▲' : isShort ? 'SHORT ▼' : 'STANDBY · رصد'}</span>
        </div>
        <div class="sub" style="margin-top:4px">${REGIME_FA[res.regime] || res.regime} · تایم ${qTf} · ${ms}ms</div>
      </div>
      <div class="qhud-scorebox">
        <div class="qhud-num ${cls}">${Math.round(res.confidenceScore || 0)}</div>
        <div class="qhud-segs">${segHtml}</div>
      </div>
    </div>
  `;

  if (activeList.length > 1) {
    html += '<div class="qhud-tabs">' + activeList.map((x) =>
      `<button type="button" class="qhud-tab ${x.sym === sym ? 'on' : ''}" data-qpick="${x.sym}">${x.sym.replace('USDT', '')} ${x.res.signal === 'LONG' ? '▲' : '▼'} ${Math.round(x.res.confidenceScore)}</button>`
    ).join('') + '</div>';
  }

  if (res.signal !== 'NO_TRADE') {
    html += `
      <div class="qhud-grid">
        <div class="qhud-cell"><span>محدوده ورود (Entry)</span><b>${usd(res.entryZone?.low)} – ${usd(res.entryZone?.high)}</b></div>
        <div class="qhud-cell"><span>حد ضرر ساختاری (SL)</span><b class="down">${usd(res.stopLoss)}</b></div>
        <div class="qhud-cell"><span>اهداف TP1 / TP2 / TP3</span><b class="up">${usd(res.tp1)} | ${usd(res.tp2)}</b></div>
        <div class="qhud-cell"><span>RR خالص (LBank) | اعتبار</span><b>${fa(res.rr?.tp1, 2)} / ${fa(res.rr?.tp2, 2)} · ${fa(res.ttlMinutes)}دق</b></div>
      </div>
    `;
    if (res.positionSize) {
      html += `<div class="kv" style="margin-top:6px"><span>حجم پیشنهادی (${fa(res.positionSize.riskPctApplied, 2)}٪ ریسک)</span><b>${res.positionSize.quantity} واحد (${usd(res.positionSize.notionalUsd)})</b></div>`;
    }
  }

  // تابلو LED گیت‌های ایمنی
  if (res.gates && res.gates.length) {
    html += '<div class="qhud-leds">' + res.gates.map((g) =>
      `<span class="qled ${g.ok ? 'ok' : 'bad'}" title="${g.detail}"><b></b>${g.name}</span>`
    ).join('') + '</div>';
  }

  if (res.reasonsFor?.length) {
    html += '<div class="note">دلایل موافق:</div>' + res.reasonsFor.slice(0, 4).map((t) => `<div class="chk g">✓ ${t}</div>`).join('');
  }
  if (res.reasonsAgainst?.length) {
    html += '<div class="note">عوامل مخالف / دلیل انتظار:</div>' + res.reasonsAgainst.slice(0, 4).map((t) => `<div class="chk w">⚠ ${t}</div>`).join('');
  }

  // لیست فشردهٔ کل ۱۶ ارز اسکن‌شده
  html += `<details class="mini" style="margin-top:8px"><summary>رادار کل ارزهای کوانت (${fa(ranked.length)} ارز · شامل ZEC)</summary><div class="qhud-list">` +
    ranked.map((x) => {
      const tag = x.res.signal === 'LONG' ? '🟢 LONG' : x.res.signal === 'SHORT' ? '🔴 SHORT' : '⏸';
      return `<div class="qhud-row" data-qpick="${x.sym}"><b>${x.sym.replace('USDT', '')}</b><span>${tag} · ${fa(Math.round(x.res.confidenceScore || 0))}</span></div>`;
    }).join('') + '</div></details>';

  body.innerHTML = html;
  body.querySelectorAll('[data-qpick]').forEach((el) => {
    el.addEventListener('click', () => {
      qSelectedSym = el.getAttribute('data-qpick');
      renderQuantHud();
    });
  });
}

async function runAutoQuantSweep(force = false) {
  if (qScanning) return;
  if (!force && document.hidden) return;
  qScanning = true;

  const coins = getQuantCoinList();
  const statusEl = $('qStatusLine');
  const fillEl = $('qProgFill');
  const savedRc = (() => { try { return JSON.parse(localStorage.getItem('rc') || '{}'); } catch (_) { return {}; } })();
  const riskContext = {
    accountEquity: parseFloat(savedRc.rcCap) || 1000,
    riskPct: parseFloat(savedRc.rcRisk) || 1,
    openTrades: [],
    dailyLossR: 0,
    lossStreak: 0,
  };

  try {
    await syncCloudModel();
    // دریافت یک‌باره داده BTC برای همبستگی و فیلتر شلوغی کل بازار
    const [btcBars, btcLsRaw] = await Promise.all([
      fetchClosedBars('BTCUSDT', qTf, 120).catch(() => null),
      fetch('https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=BTCUSDT&period=1h&limit=1')
        .then((r) => r.json()).catch(() => null),
    ]);
    qBtcLs = btcLsRaw && btcLsRaw[0] ? +btcLsRaw[0].longShortRatio : null;

    const fresh = [];
    const needTfs = [...new Set([qTf, '15m', '1h', '4h', '1d'])];

    for (let i = 0; i < coins.length; i++) {
      const sym = coins[i];
      if (statusEl) statusEl.textContent = `اسکن ${i + 1}/${coins.length}: ${sym.replace('USDT', '')}`;
      if (fillEl) fillEl.style.width = `${Math.round(((i + 1) / coins.length) * 100)}%`;

      try {
        const t0 = performance.now();
        const [tfRes, piRes, lsRes] = await Promise.all([
          Promise.allSettled(needTfs.map(async (k) => [k, await fetchClosedBars(sym, k, k === '1d' ? 120 : 180)])),
          fetch(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${sym}`).then((r) => r.json()).catch(() => null),
          fetch(`https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${sym}&period=1h&limit=1`).then((r) => r.json()).catch(() => null),
        ]);
        const timeframes = {};
        tfRes.forEach((x) => { if (x.status === 'fulfilled') timeframes[x.value[0]] = x.value[1]; });
        const deriv = {
          fundingRatePct: piRes && piRes.lastFundingRate != null ? +piRes.lastFundingRate * 100 : null,
          longShortRatio: lsRes && lsRes[0] ? +lsRes[0].longShortRatio : null,
        };
        const rawRes = evaluateMarket(
          { symbol: sym, primaryTf: qTf, timeframes, derivatives: deriv, btcBars: sym === 'BTCUSDT' ? null : btcBars, riskContext, nowTs: Date.now() },
          activeWeights,
          LBANK_CFG,
          calLookup
        );
        const res = applyQuantGuards(rawRes, { deriv, btcLs: qBtcLs, bars: timeframes[qTf] || timeframes['15m'] });
        const ms = Math.round(performance.now() - t0);
        fresh.push({ sym, res, ms });

        if (res.signal !== 'NO_TRADE') showQuantToast(sym, res);

        // به‌روزرسانی لحظه‌ای نمایشگر حین اسکن
        qResults = [...fresh];
        renderQuantHud();
      } catch (_) {}

      await sleep(180);
    }

    qLastSweepAt = Date.now();
    qNextSweepAt = qLastSweepAt + Q_SWEEP_MS;
    if (statusEl) statusEl.textContent = `آخرین اسکن کامل: ${fmtTime(qLastSweepAt)}`;
  } finally {
    qScanning = false;
    updateQuantTelemetryBar();
  }
}

/* ---------- ۲. داشبورد مدیریت موتور یادگیری زنده (اسکنر + اسکالپ) + Walk-Forward ---------- */
function mountEngineDashboard() {
  const tools = $('tp-tools');
  if (!tools || $('engineDash')) return;
  const card = document.createElement('div');
  card.className = 'card';
  card.id = 'engineDash';
  card.style.marginTop = '12px';
  card.innerHTML = `
    <div class="ph">
      <h3><span class="pulse"></span>داشبورد یادگیری پویای زنده (اسکنر + اسکالپ)</h3>
      <span id="edBadge" class="badge neutral">در حال اتصال...</span>
    </div>
    <div id="edBody" class="gd"><div class="sub">در حال دریافت وضعیت زنده از Cloudflare D1...</div></div>
    <div class="btnrow" id="edActions">
      <button id="edRefresh" class="btnx">به‌روزرسانی زنده</button>
      <button id="edWfBtn" class="btnx">اجرای بک‌تست Walk-Forward (OOS)</button>
    </div>
    <div id="edWfOut" style="margin-top:10px"></div>
  `;
  tools.appendChild(card);

  if (localStorage.getItem('gl_isadm') === '1') {
    const bLearn = document.createElement('button');
    bLearn.className = 'btnx';
    bLearn.textContent = '🧠 اجرای چرخه یادگیری (هر دو موتور)';
    bLearn.addEventListener('click', () => adminEngineOp('/engine/learn'));
    const bRoll = document.createElement('button');
    bRoll.className = 'btnx warn';
    bRoll.textContent = '↩ Rollback به نسخه قبل';
    bRoll.addEventListener('click', () => { if (confirm('مدل به نسخه قبلی برگردد؟')) adminEngineOp('/engine/rollback'); });
    const bSeed = document.createElement('button');
    bSeed.className = 'btnx';
    bSeed.textContent = '🌱 پر کردن تاریخچه (Seed)';
    bSeed.addEventListener('click', () => adminEngineOp('/engine/seed?syms=BTCUSDT,ETHUSDT,SOLUSDT,ZECUSDT'));
    $('edActions').append(bSeed, bLearn, bRoll);
  }
  $('edRefresh').addEventListener('click', loadEngineDashboard);
  $('edWfBtn').addEventListener('click', runLiveWalkForward);
  loadEngineDashboard();
  setInterval(() => { if (!document.hidden && $('tp-tools')?.classList.contains('on')) loadEngineDashboard(); }, 45000);
}

async function adminEngineOp(path) {
  const api = apiBase();
  let k = sessionStorage.getItem('gl_adm') || '';
  if (!k) { k = prompt('رمز مدیر:') || ''; if (k) sessionStorage.setItem('gl_adm', k); }
  if (!api || !k) return;
  try {
    const r = await (await fetch(api + path, { headers: { 'X-Key': k } })).json();
    alert(JSON.stringify(r, null, 2).slice(0, 700));
    loadEngineDashboard();
  } catch (e) { alert('خطا در ارتباط با Worker'); }
}

function summarizeSamples(rows, mode, target) {
  const list = (rows || []).filter((x) => x.mode === mode);
  let open = 0, closed = 0, realN = 0, shadowN = 0, wins = 0, losses = 0, timeouts = 0, sumR = 0;
  for (const x of list) {
    const n = Number(x.n) || 0;
    if (x.is_open) open += n;
    else {
      closed += n;
      wins += Number(x.w) || 0;
      losses += Number(x.l) || 0;
      timeouts += Number(x.t) || 0;
      sumR += (Number(x.avg_r) || 0) * n;
    }
    if (x.is_shadow) shadowN += n;
    else realN += n;
  }
  const pctDone = Math.min(100, Math.round((closed / target) * 100));
  const avgR = closed > 0 ? sumR / closed : 0;
  return { open, closed, realN, shadowN, wins, losses, timeouts, avgR, target, pctDone };
}

function renderProgressBlock(title, st, minScoreLabel) {
  return `
    <div style="margin:10px 0;padding:10px;border:1px solid var(--line);border-radius:10px;background:rgba(0,0,0,.2)">
      <div style="display:flex;justify-content:space-between;align-items:center;font-size:13px;margin-bottom:4px">
        <b>${title}</b>
        <span class="chip ${st.closed >= st.target ? 'up' : 'w'}">${fa(st.closed)} از ${fa(st.target)} نمونه بسته‌شده (${fa(st.pctDone)}٪)</span>
      </div>
      <div style="height:7px;border-radius:6px;background:rgba(255,255,255,.08);overflow:hidden;margin:6px 0">
        <div style="width:${st.pctDone}%;height:100%;background:linear-gradient(90deg,var(--accent),var(--up));transition:width .4s"></div>
      </div>
      <div class="kv"><span>نمونه باز | واقعی | سایه (Shadow)</span><b>${fa(st.open)} باز · ${fa(st.realN)} واقعی · ${fa(st.shadowN)} سایه</b></div>
      <div class="kv"><span>نتیجه نمونه‌های آموزشی (برد / باخت / منقضی)</span><b>${fa(st.wins)} / ${fa(st.losses)} / ${fa(st.timeouts)} | میانگین ${(st.avgR >= 0 ? '+' : '') + fa(st.avgR, 3)} R</b></div>
      <div class="kv"><span>آستانه امتیاز فعلی</span><b>${minScoreLabel}</b></div>
    </div>
  `;
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
    badge.textContent = `مدل v${d.model?.version_id || 1} (${d.version || 'v14.5'}) · ${pingMs}ms`;
    const targets = d.v14?.targets || { scan: 110, scalp: 75 };
    const scanSt = summarizeSamples(d.v14?.samples, 'scan', targets.scan);
    const scalpSt = summarizeSamples(d.v14?.samples, 'scalp', targets.scalp);
    const m = d.overall || {};
    const thr = d.model?.thresholds || {};
    const nextLearn = d.v14?.nextLearnAt ? fmtTime(d.v14.nextLearnAt) : 'هر ۶ ساعت';
    let html = `
      <div class="kv"><span>نسخه فعال مدل | صرافی</span><b>v${d.model?.version_id || 1} (${d.model?.notes || 'Baseline'}) · ${d.exchange || 'LBank Futures'}</b></div>
      <div class="kv"><span>وضعیت اتصال دیتابیس و فید زنده</span><b class="up">${d.db ? 'D1 متصل ✓' : 'قطع'} · ${d.feed?.klines || 'Hyperliquid'}</b></div>
      <div class="kv"><span>چرخه خودکار یادگیری بعدی</span><b>${nextLearn} (با اعتبارسنجی Holdout + Bootstrap)</b></div>
      ${renderProgressBlock('🎯 موتور اسکنر فرصت (15m / 1h / 4h)', scanSt, `حداقل امتیاز ${fa(thr.minConfidence || 68)} | TP1 = ${fa(thr.tp1Mult || 1.6, 2)}R`)}
      ${renderProgressBlock('⚡ موتور اسکالپ کوتاه‌مدت (1m / 5m)', scalpSt, `حداقل امتیاز ${fa(thr.scalpMinScore || 50)} (هشدار ≥ ۵۸)`)}
      <div class="kv"><span>سیگنال‌های رسمی بسته‌شده | باز</span><b>${fa(m.n)} (${fa(m.wins)} برد / ${fa(m.losses)} باخت) | ${fa(d.openCount || 0)} باز</b></div>
      <div class="kv"><span>Profit Factor | Expectancy | Max DD</span><b>${fa(m.profitFactor, 2)} | ${(m.expectancyR >= 0 ? '+' : '') + fa(m.expectancyR, 3)} R | ${fa(m.maxDrawdownR, 2)} R</b></div>
    `;
    if (d.v14?.runs && d.v14.runs.length) {
      html += '<h3>تاریخچه چرخه‌های یادگیری خودکار (اسکنر و اسکالپ)</h3><table><tr><td><b>زمان</b></td><td><b>موتور</b></td><td><b>نمونه</b></td><td><b>تصمیم</b></td><td><b>توضیح</b></td></tr>';
      d.v14.runs.forEach((r) => {
        const mLabel = r.mode === 'scalp' ? '⚡ اسکالپ' : '🎯 اسکنر';
        const dLabel = DEC_FA[r.decision] || r.decision;
        html += `<tr><td>${fmtTime(r.ran_at)}</td><td>${mLabel}</td><td>${fa(r.samples_used)} (${fa(r.shadow_used)} سایه)</td><td>${dLabel}</td><td>${r.reason || '—'}</td></tr>`;
      });
      html += '</table>';
    }
    if (d.v14?.thr && d.v14.thr.length) {
      html += '<h3>تغییرات اعمال‌شده روی آستانه‌ها</h3><table><tr><td><b>زمان</b></td><td><b>موتور</b></td><td><b>پارامتر</b></td><td><b>قدیم ← جدید</b></td></tr>';
      d.v14.thr.forEach((t) => {
        html += `<tr><td>${fmtTime(t.changed_at)}</td><td>${t.mode === 'scalp' ? 'اسکالپ' : 'اسکنر'}</td><td>${t.param_key}</td><td>${t.old_value} ← <b>${t.new_value}</b></td></tr>`;
      });
      html += '</table>';
    }
    if (d.layerAttribution && d.layerAttribution.length) {
      html += '<h3>عملکرد لایه‌های اسکنر (بهترین تا ضعیف‌ترین)</h3><table><tr><td><b>لایه</b></td><td><b>تعداد</b></td><td><b>نرخ برد</b></td><td><b>میانگین R</b></td></tr>';
      d.layerAttribution.forEach((x) => {
        const wr = x.n ? (x.w / x.n) * 100 : 0;
        html += `<tr><td>${LAYER_FA[x.layer_name] || x.layer_name}</td><td>${fa(x.n)}</td><td>${fa(wr, 0)}٪</td><td style="color:${x.avg_r >= 0 ? 'var(--up)' : 'var(--down)'}">${fa(x.avg_r, 2)}</td></tr>`;
      });
      html += '</table>';
    }
    if (d.model?.weights) {
      html += '<details class="mini"><summary>وزن فعلی لایه‌ها در هر دو موتور (نسخه v' + d.model.version_id + ')</summary>';
      Object.entries(d.model.weights).forEach(([reg, wm]) => {
        const parts = Object.entries(wm).map(([k, v]) => `${k}:${v}`).join(' · ');
        html += `<div class="note"><b>[اسکنر] ${REGIME_FA[reg] || reg}:</b> ${parts}</div>`;
      });
      if (d.model.scalpWeights) {
        Object.entries(d.model.scalpWeights).forEach(([reg, wm]) => {
          const parts = Object.entries(wm).map(([k, v]) => `${k}:${v}`).join(' · ');
          html += `<div class="note"><b>[اسکالپ] ${REGIME_FA[reg] || reg}:</b> ${parts}</div>`;
        });
      }
      html += '</details>';
    }
    body.innerHTML = html;
  } catch (e) {
    badge.className = 'badge short';
    badge.textContent = 'قطع';
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
      html += '<div class="note">تفکیک رژیم در Out-of-Sample: ' + regs.map(([r, m]) => `${REGIME_FA[r] || r}: ${fa(m.n)} معامله (${fa(m.netR, 1)}R)`).join(' | ') + '</div>';
    }
    out.innerHTML = html;
  } catch (e) {
    out.innerHTML = `<div class="chk w">⚠ خطا در Walk-Forward: ${e.message || e}</div>`;
  }
}

/* ---------- ۳. مرکز رویدادها، علت نبود سیگنال و ثبت خطاها (در تب پنل) ---------- */
const EV_KEY = 'gl_evlog_v1';
let evLogs = (() => { try { return JSON.parse(localStorage.getItem(EV_KEY) || '[]'); } catch (_) { return []; } })();
const evRecentMap = new Map();

function pushSysEvent(level, title, detail = '') {
  const dedupKey = `${level}|${title}|${detail}`;
  const now = Date.now();
  if (evRecentMap.has(dedupKey) && now - evRecentMap.get(dedupKey) < 900000) return; // جلوگیری از تکرار زیر ۱۵ دقیقه
  evRecentMap.set(dedupKey, now);
  evLogs.unshift({ t: now, level, title, detail: String(detail || '').slice(0, 220) });
  evLogs = evLogs.slice(0, 60);
  try { localStorage.setItem(EV_KEY, JSON.stringify(evLogs)); } catch (_) {}
  renderEventLogCard();
}

function getMarketSessionInfo(now = new Date()) {
  try {
    const ny = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
    }).formatToParts(now);
    const g = (arr, k) => arr.find((p) => p.type === k)?.value;
    const wd = g(ny, 'weekday'), h = Number(g(ny, 'hour')), m = Number(g(ny, 'minute'));
    const mins = h * 60 + m;

    const ir = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Tehran', hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
    }).formatToParts(now);
    const irMins = Number(g(ir, 'hour')) * 60 + Number(g(ir, 'minute'));

    const isWeekend = wd === 'Sat' || (wd === 'Sun' && h < 18) || (wd === 'Fri' && h >= 17);
    if (isWeekend) {
      return {
        chip: '🟡 تعطیلی آخر هفته',
        cls: 'w',
        text: 'بازارهای جهانی (بورس آمریکا، طلا و CME) تعطیل هستند (جمعه شب تا دوشنبه بامداد). نقدینگی پایین است و احتمال بازار رنج و نبود سیگنال بالاست.',
      };
    }
    if (isUsOpenLock(now)) {
      return {
        chip: '🔒 قفل بازگشایی آمریکا',
        cls: 'down',
        text: 'قفل ایمنی ۵ دقیقه قبل تا ۵ دقیقه بعد از بازگشایی بورس نیویورک (09:25 تا 09:35 NY) فعال است؛ صدور سیگنال جدید موقتاً متوقف شده.',
      };
    }
    if (irMins >= 200 && irMins <= 220) {
      return {
        chip: '🕒 بسته‌شدن کندل روزانه',
        cls: 'w',
        text: 'بازهٔ بسته شدن کندل روزانه و صفر شدن VWAP (۰۳:۲۰ تا ۰۳:۴۰ تهران)؛ احتمال نوسان کوتاه و اسپرد لحظه‌ای.',
      };
    }
    return {
      chip: '🟢 بازار جهانی باز',
      cls: 'up',
      text: 'بازارهای جهانی در روز کاری هستند و قفل زمانی فعال نیست.',
    };
  } catch (_) {
    return { chip: 'وضعیت نامشخص', cls: '', text: 'محاسبهٔ تقویم بازار ممکن نشد.' };
  }
}

function collectNoSignalReasons() {
  const lines = [];
  const ses = getMarketSessionInfo();
  lines.push({ level: ses.cls === 'down' ? 'err' : ses.cls === 'w' ? 'warn' : 'ok', text: ses.text });

  // قفل ریسک
  try {
    if (typeof riskState === 'function') {
      const rk = riskState();
      if (rk && rk.locked) lines.push({ level: 'err', text: 'قفل ریسک فعال است: ' + rk.reason });
    }
  } catch (_) {}

  // اتصال زنده وب‌سوکت
  const dot = $('dot');
  if (dot && !dot.classList.contains('on')) {
    lines.push({ level: 'err', text: 'اتصال لحظه‌ای WebSocket قطع است: ' + ($('status')?.textContent || 'قطع') });
  }

  // شلوغی بیت‌کوین
  if (qBtcLs != null && qBtcLs >= 2.3) {
    lines.push({ level: 'warn', text: `نسبت لانگ/شورت بیت‌کوین بالاست (${qBtcLs.toFixed(2)})؛ جریمه/فیلتر شلوغی فعال شده است.` });
  }

  // خلاصه علت نبود سیگنال در اسکنر
  try {
    if (typeof SC !== 'undefined' && SC) {
      if (SC.err) lines.push({ level: 'err', text: 'خطای اسکنر: ' + SC.err });
      else if (Array.isArray(SC.res) && SC.res.length) {
        const okN = SC.res.filter((x) => !x.reject && x.score >= SC.min).length;
        if (okN > 0) {
          lines.push({ level: 'ok', text: `اسکنر: ${fa(okN)} سیگنال معتبر فعال دارد.` });
        } else {
          const cnt = {};
          SC.res.forEach((x) => { const k = x.reject || 'امتیاز کمتر از حد نصاب'; cnt[k] = (cnt[k] || 0) + 1; });
          const top = Object.entries(cnt).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k, v]) => `${k} (${fa(v)} ارز)`).join(' · ');
          lines.push({ level: 'warn', text: 'اسکنر بدون سیگنال: ' + top });
        }
      }
    }
  } catch (_) {}

  // خلاصه علت نبود سیگنال در اسکالپ
  try {
    if (typeof SA !== 'undefined' && SA && SA.c) {
      const vals = Object.values(SA.c).map((x) => x.res).filter((r) => r && r.gate && r.gate.length);
      if (vals.length) {
        const okN = vals.filter((r) => r.ok).length;
        if (okN > 0) lines.push({ level: 'ok', text: `اسکالپ: ${fa(okN)} سیگنال فعال دارد.` });
        else {
          const cnt = {};
          vals.forEach((r) => {
            const bad = r.gate.find((g) => !g.ok);
            const k = bad ? bad.name.split('(')[0].trim() : (r.why || 'قدرت کم');
            cnt[k] = (cnt[k] || 0) + 1;
          });
          const top = Object.entries(cnt).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k, v]) => `${k} (${fa(v)} ارز)`).join(' · ');
          lines.push({ level: 'warn', text: 'اسکالپ بدون سیگنال: ' + top });
        }
      }
    }
  } catch (_) {}

  // خلاصه موتور خودکار کوانت
  if (qResults.length) {
    const act = qResults.filter((x) => x.res.signal !== 'NO_TRADE');
    if (act.length) {
      lines.push({ level: 'ok', text: `کوانت خودکار: ${fa(act.length)} سیگنال فعال (${act.map((x) => x.sym.replace('USDT', '')).join('، ')}).` });
    } else {
      const top = [...qResults].sort((a, b) => (b.res.confidenceScore || 0) - (a.res.confidenceScore || 0))[0];
      const why = top?.res?.reasonsAgainst?.[0] || 'شرایط کامل نیست';
      lines.push({ level: 'warn', text: `کوانت آماده‌باش (نزدیک‌ترین: ${top.sym.replace('USDT', '')} با امتیاز ${fa(Math.round(top.res.confidenceScore || 0))}) — ${why}` });
    }
  }

  // خطای منابع داده
  try {
    if (typeof FEED !== 'undefined' && FEED) {
      const badFeeds = Object.entries(FEED).filter(([, v]) => v && v.ok === false).map(([h]) => h);
      if (badFeeds.length) lines.push({ level: 'err', text: 'خطای دریافت داده از: ' + badFeeds.join('، ') });
    }
  } catch (_) {}

  const bootErr = $('boot-err')?.textContent?.trim();
  if (bootErr) lines.push({ level: 'err', text: 'خطای اسکریپت: ' + bootErr });

  return { ses, lines };
}

function renderEventLogCard() {
  const sumEl = $('evLiveSummary'), listEl = $('evLogList'), badge = $('evLogChip');
  if (!sumEl || !listEl) return;

  const { ses, lines } = collectNoSignalReasons();
  const errCount = evLogs.filter((x) => x.level === 'err' && Date.now() - x.t < 3600e3).length;
  if (badge) {
    badge.className = 'chip ' + (errCount > 0 ? 'down' : ses.cls);
    badge.textContent = errCount > 0 ? `🔴 ${fa(errCount)} خطا · ${ses.chip}` : ses.chip;
  }

  sumEl.innerHTML = lines.map((l) => {
    const ic = l.level === 'err' ? '🔴' : l.level === 'warn' ? '🟡' : '🟢';
    const cl = l.level === 'err' ? 'down' : l.level === 'warn' ? 'chk w' : 'chk g';
    return `<div class="${cl}" style="font-size:12px;line-height:1.8">${ic} ${l.text}</div>`;
  }).join('');

  if (!evLogs.length) {
    listEl.innerHTML = '<div class="sub">هنوز رویداد یا خطایی ثبت نشده است.</div>';
    return;
  }
  listEl.innerHTML = evLogs.slice(0, 35).map((e) => {
    const ic = e.level === 'err' ? '🔴' : e.level === 'warn' ? '🟡' : '🟢';
    return `<div style="border-bottom:1px dashed var(--line);padding:6px 0;font-size:12px;line-height:1.7">
      <div style="display:flex;justify-content:space-between;gap:8px"><b>${ic} ${e.title}</b><span class="sub" style="margin:0">${fmtTime(e.t)}</span></div>
      ${e.detail ? `<div style="color:var(--mute);margin-top:2px;word-break:break-word">${e.detail}</div>` : ''}
    </div>`;
  }).join('');
}

function mountEventLogCard() {
  const dash = $('tp-dash');
  if (!dash || $('evLogCard')) return;
  const c = document.createElement('div');
  c.className = 'card';
  c.id = 'evLogCard';
  c.style.marginBottom = '12px';
  c.innerHTML = `
    <div class="ph"><h3>📋 مرکز رویدادها، علت نبود سیگنال و لاگ خطا</h3><span id="evLogChip" class="chip">در حال بررسی...</span></div>
    <div style="padding:8px 10px;border-radius:10px;background:rgba(0,0,0,.22);border:1px solid var(--line);margin-bottom:8px">
      <div class="sub" style="margin:0 0 4px">وضعیت زندهٔ همین لحظه:</div>
      <div id="evLiveSummary"></div>
    </div>
    <div class="btnrow" style="margin:6px 0 8px">
      <button type="button" id="evRefBtn" class="btnx">به‌روزرسانی</button>
      <button type="button" id="evCopyBtn" class="btnx">کپی لاگ</button>
      <button type="button" id="evClrBtn" class="btnx warn">پاک کردن</button>
    </div>
    <div id="evLogList" style="max-height:260px;overflow-y:auto"></div>
  `;
  dash.prepend(c);

  $('evRefBtn').addEventListener('click', () => { auditSystemEvents(); renderEventLogCard(); });
  $('evClrBtn').addEventListener('click', () => { evLogs = []; evRecentMap.clear(); try { localStorage.removeItem(EV_KEY); } catch (_) {} renderEventLogCard(); });
  $('evCopyBtn').addEventListener('click', async () => {
    const { lines } = collectNoSignalReasons();
    const txt = '=== وضعیت زنده ===\n' + lines.map((l) => '- ' + l.text).join('\n') +
      '\n\n=== لاگ رویدادها ===\n' + evLogs.slice(0, 25).map((e) => `[${fmtTime(e.t)}] (${e.level}) ${e.title}: ${e.detail}`).join('\n');
    try { await navigator.clipboard.writeText(txt); alert('لاگ در کلیپ‌بورد کپی شد.'); } catch (_) { prompt('متن لاگ را کپی کن:', txt); }
  });

  // شنود خودکار خطاهای جاوااسکریپت و درخواست‌های ناموفق
  window.addEventListener('error', (e) => {
    pushSysEvent('err', 'خطای جاوااسکریپت', `${e.message || 'Unknown'} @خط ${e.lineno || '?'}`);
  });
  window.addEventListener('unhandledrejection', (e) => {
    const msg = e?.reason?.message || String(e?.reason || 'خطای نامشخص');
    pushSysEvent('err', 'خطای ناهمزمان (Promise)', msg);
  });

  auditSystemEvents();
  renderEventLogCard();
  setInterval(() => { if (!document.hidden) { auditSystemEvents(); renderEventLogCard(); } }, 30000);
}

function auditSystemEvents() {
  const { ses, lines } = collectNoSignalReasons();
  if (ses.cls === 'w' || ses.cls === 'down') pushSysEvent(ses.cls === 'down' ? 'err' : 'warn', ses.chip, ses.text);
  lines.filter((l) => l.level === 'err').forEach((l) => pushSysEvent('err', 'هشدار فنی / محدودیت', l.text));
}

/* ---------- ۴. کشویی کردن تمام کادرهای تب «پنل» (Accordion) ---------- */
function initDashAccordion() {
  const dash = $('tp-dash');
  if (!dash) return;

  if (!$('dashAccCss')) {
    const st = document.createElement('style');
    st.id = 'dashAccCss';
    st.textContent = `
      .dash-acc-bar{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:10px;padding:6px 10px;border-radius:10px;background:rgba(15,23,42,.55);border:1px solid var(--line);font-size:12px;color:var(--mute)}
      .dash-acc-bar .btnx{padding:4px 10px;font-size:11.5px}
      #tp-dash .card.dash-fold{padding:11px 13px;margin-bottom:9px!important}
      #tp-dash .card.dash-fold>.dash-hd{display:flex;justify-content:space-between;align-items:center;gap:8px;cursor:pointer;user-select:none;margin:0!important;min-height:28px;touch-action:manipulation}
      #tp-dash .card.dash-fold.acc-open>.dash-hd{margin-bottom:10px!important;padding-bottom:8px;border-bottom:1px dashed var(--line)}
      #tp-dash .card.dash-fold>.dash-bd{display:none}
      #tp-dash .card.dash-fold.acc-open>.dash-bd{display:block}
      .dash-chev{font-size:14px;color:var(--mute);transition:transform .2s ease;flex:none;margin-inline-start:4px}
      #tp-dash .card.dash-fold.acc-open>.dash-hd .dash-chev{transform:rotate(180deg);color:var(--accent)}
      #tp-dash details.card{padding:11px 13px;margin-bottom:9px!important}
      #tp-dash details.card>summary{cursor:pointer;font-weight:800;font-size:13.5px;list-style:none;display:flex;justify-content:space-between;align-items:center}
      #tp-dash details.card>summary::after{content:'▾';font-size:14px;color:var(--mute);transition:transform .2s}
      #tp-dash details.card[open]>summary::after{transform:rotate(180deg);color:var(--accent)}
    `;
    document.head.appendChild(st);
  }

  if (!$('dashAccBar')) {
    const bar = document.createElement('div');
    bar.id = 'dashAccBar';
    bar.className = 'dash-acc-bar';
    bar.innerHTML = `<span>کادرهای پنل (کشویی)</span><div style="display:flex;gap:6px"><button type="button" id="dashOpenAll" class="btnx">باز کردن همه</button><button type="button" id="dashCloseAll" class="btnx">بستن همه</button></div>`;
    dash.prepend(bar);
    $('dashOpenAll').addEventListener('click', () => {
      dash.querySelectorAll(':scope > .card.dash-fold').forEach((x) => x.classList.add('acc-open'));
      dash.querySelectorAll(':scope > details.card').forEach((x) => { x.open = true; });
    });
    $('dashCloseAll').addEventListener('click', () => {
      dash.querySelectorAll(':scope > .card.dash-fold').forEach((x) => x.classList.remove('acc-open'));
      dash.querySelectorAll(':scope > details.card').forEach((x) => { x.open = false; });
    });
  }

  function guessCardTitle(card) {
    const t = card.textContent || '';
    if (t.includes('فونت') || t.includes('اندازه') || t.includes('فیروزه‌ای')) return '🎨 ظاهر، رنگ و فونت';
    if (t.includes('تاریخچه هشدار')) return '🕒 تاریخچه هشدارها';
    if (t.includes('تلگرام')) return '🔔 هشدار تلگرام';
    if (t.includes('حساب') || t.includes('ورود مدیر')) return '👤 حساب و اشتراک';
    if (t.includes('ارز')) return '🪙 انتخاب ارزها';
    if (t.includes('وضعیت سیستم')) return '🩺 وضعیت سیستم';
    return '📦 بخش تنظیمات';
  }

  function wrapCard(card) {
    if (!card || card.id === 'dashAccBar' || card.tagName === 'DETAILS') return;
    if (!card.children.length) return;
    if (card.children.length === 1 && card.firstElementChild?.tagName === 'DETAILS') return;
    if (card.querySelector(':scope > .dash-bd')) return;

    let hd = card.querySelector(':scope > .ph');
    if (!hd) {
      const h = card.querySelector(':scope > h2, :scope > h3, :scope > .lbl');
      hd = document.createElement('div');
      hd.className = 'ph';
      if (h) {
        hd.appendChild(h);
      } else {
        const h3 = document.createElement('h3');
        h3.textContent = guessCardTitle(card);
        hd.appendChild(h3);
      }
      card.prepend(hd);
    }

    hd.classList.add('dash-hd');
    if (!hd.querySelector('.dash-chev')) {
      const ch = document.createElement('span');
      ch.className = 'dash-chev';
      ch.textContent = '▾';
      hd.appendChild(ch);
    }

    const bd = document.createElement('div');
    bd.className = 'dash-bd';
    const kids = [...card.childNodes].filter((n) => n !== hd);
    kids.forEach((n) => bd.appendChild(n));
    card.appendChild(bd);
    card.classList.add('dash-fold');

    if (!hd.dataset.accBound) {
      hd.dataset.accBound = '1';
      hd.addEventListener('click', (e) => {
        if (e.target.closest('button,input,select,a,label')) return;
        card.classList.toggle('acc-open');
      });
    }
  }

  let obsTm = null;
  const scanAll = () => {
    dash.querySelectorAll(':scope > .card').forEach(wrapCard);
    const bar = $('dashAccBar'), ev = $('evLogCard');
    if (bar && dash.firstElementChild !== bar) dash.prepend(bar);
    if (bar && ev && bar.nextElementSibling !== ev) bar.after(ev);
  };

  scanAll();
  const obs = new MutationObserver(() => {
    clearTimeout(obsTm);
    obsTm = setTimeout(scanAll, 120);
  });
  obs.observe(dash, { childList: true, subtree: true });
}

window.addEventListener('DOMContentLoaded', () => {
  mountQuantCard();
  mountEngineDashboard();
  mountEventLogCard();
  initDashAccordion();
  syncCloudModel();
  setInterval(syncCloudModel, 300000);
});
