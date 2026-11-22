// ============================================================
// GOLBIT Cloudflare Worker (v11)
// پراکسی قیمت ایران + اسکنر و اسکالپ ۲۴ساعته + اشتراک USDT + مهمان ۷ روزه + تلگرام چندکاربره + دامیننس تتر
// نیازها: KV با نام SIG | متغیرها: NOTIFY_KEY (یا ADMIN_KEY)، TG_TOKEN، TG_CHAT
// Cron Triggers:  */5 * * * *  (اسکنر و دفترچه)   و   * * * * *  (اسکالپ و پیشنهاد طلایی)
// ============================================================
function corsHeaders(env) {
  return {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Access-Control-Allow-Origin': env && env.ALLOWED_ORIGIN ? env.ALLOWED_ORIGIN : '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Key',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  };
}
let _ENV = null;
const out = (o, status = 200, cache = 15) =>
  new Response(JSON.stringify(o), {
    status,
    headers: { ...corsHeaders(_ENV), 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=' + cache },
  });
const num = (v) => {
  const n = parseFloat(String(v).replace(/[,٬\s]/g, ''));
  return Number.isFinite(n) ? n : null;
};
async function getJson(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' }, cf: { cacheTtl: 10 } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

// ---------- دلار و طلای ایران ----------
async function iran(debug) {
  const o = { ts: Date.now(), usd: null, usdFree: null, gold18: null, errors: {} };
  const [nb, tgRes] = await Promise.allSettled([
    getJson('https://apiv2.nobitex.ir/market/stats?srcCurrency=usdt&dstCurrency=rls'),
    getJson('https://call4.tgju.org/ajax.json'),
  ]);
  if (nb.status === 'fulfilled') {
    const v = num(nb.value?.stats?.['usdt-rls']?.latest);
    if (v) o.usd = { toman: v / 10, source: 'nobitex-usdt' };
    else o.errors.nobitex = 'داده usdt-rls پیدا نشد';
  } else o.errors.nobitex = String(nb.reason);
  if (tgRes.status === 'fulfilled') {
    const c = tgRes.value?.current || {};
    const g = num(c.geram18?.p), d = num(c.price_dollar_rl?.p);
    if (g) o.gold18 = { toman: g / 10, source: 'tgju' }; else o.errors.tgjuGold = 'geram18 پیدا نشد';
    if (d) o.usdFree = { toman: d / 10, source: 'tgju' }; else o.errors.tgjuUsd = 'price_dollar_rl پیدا نشد';
    if (debug) o.tgjuKeys = Object.keys(c).filter((k) => /geram|dollar|usd/i.test(k)).slice(0, 40);
  } else o.errors.tgju = String(tgRes.reason);
  return o;
}

// ---------- دامیننس تتر (USDT.D) و بیت‌کوین (ذخیره در KV برای تحلیل ۲۴ساعته) ----------
let DOM_CACHE = null;
async function getDomCtx(env, allowFetch = true) {
  const now = Date.now();
  if (DOM_CACHE && now - DOM_CACHE.t < 240000) return DOM_CACHE.d;
  let hist = [];
  if (env.SIG) {
    try { hist = JSON.parse((await env.SIG.get('dom_hist')) || '[]'); } catch (_) {}
  }
  const last = hist[hist.length - 1];
  if (allowFetch && (!last || now - last.t > 300000)) {
    try {
      const g = (await getJson('https://api.coingecko.com/api/v3/global')).data;
      const b = g?.market_cap_percentage?.btc, u = g?.market_cap_percentage?.usdt;
      if (Number.isFinite(b) && Number.isFinite(u)) {
        hist.push({ t: now, b, u });
        hist = hist.filter((x) => now - x.t < 6 * 3600e3).slice(-120);
        if (env.SIG) await env.SIG.put('dom_hist', JSON.stringify(hist), { expirationTtl: 8 * 3600 });
      }
    } catch (_) {}
  }
  if (!hist.length) return { btc: null, usdt: null, du: 0, ctx: 0, mins: 0 };
  const cur = hist[hist.length - 1];
  const ref = hist.find((x) => cur.t - x.t >= 45 * 60000 && cur.t - x.t <= 105 * 60000) || hist[0];
  const mins = Math.round((cur.t - ref.t) / 60000);
  const du = cur.u - ref.u;
  // USDT.D نزولی = ورود نقدینگی به بازار (+1) | USDT.D صعودی = خروج نقدینگی به تتر (-1)
  const ctx = mins >= 15 ? (du <= -0.04 ? 1 : du >= 0.04 ? -1 : 0) : 0;
  const d = { btc: cur.b, usdt: cur.u, du, ctx, mins, ts: cur.t };
  DOM_CACHE = { t: now, d };
  return d;
}

// ---------- اندیکاتورها و موتور اسکنر ----------
const SC = { fund: {} };
const fa = (n, d = 0) => Number(n).toFixed(d);
const SCAN = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'NEARUSDT', 'SUIUSDT'];
const SC_MIN = 65;
const BN = ['https://api.binance.com', 'https://data-api.binance.vision'];
async function bj(path) {
  for (let round = 0; round < 2; round++) {
    for (const h of BN) {
      try {
        const r = await fetch(h + path, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (r.ok) return await r.json();
      } catch (e) {}
    }
    await new Promise((r) => setTimeout(r, 450 * (round + 1)));
  }
  throw new Error('binance unreachable');
}
async function kl(sym, tf, n) {
  const d = await bj(`/api/v3/klines?symbol=${sym}&interval=${tf}&limit=${n}`);
  if (!Array.isArray(d) || d.length < 62) throw new Error('کندل ناکافی');
  const a = d.slice(0, -1).map((k) => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5], tb: +k[9] }));
  if (a.some((x) => ![x.o, x.h, x.l, x.c, x.v].every(Number.isFinite) || x.h < x.l || x.c <= 0)) throw new Error('کندل نامعتبر');
  return { a, live: +d[d.length - 1][4] };
}
function ema(a, p) {
  if (!Array.isArray(a) || !a.length || !a.every(Number.isFinite)) return [];
  const k = 2 / (p + 1); let e = a[0]; const out = [e];
  for (let i = 1; i < a.length; i++) { e = a[i] * k + e * (1 - k); out.push(e); }
  return out;
}
function rsiSeries(c, p = 14) {
  const out = new Array(c.length).fill(null);
  if (c.length < p + 1) return out;
  let g = 0, l = 0;
  for (let i = 1; i <= p; i++) { const d = c[i] - c[i - 1]; d >= 0 ? (g += d) : (l -= d); }
  g /= p; l /= p;
  out[p] = g === 0 && l === 0 ? 50 : l === 0 ? 100 : 100 - 100 / (1 + g / l);
  for (let i = p + 1; i < c.length; i++) {
    const d = c[i] - c[i - 1];
    g = (g * (p - 1) + Math.max(d, 0)) / p;
    l = (l * (p - 1) + Math.max(-d, 0)) / p;
    out[i] = g === 0 && l === 0 ? 50 : l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out;
}
function rsi(c, p = 14) { const s = rsiSeries(c, p); return s[s.length - 1]; }
function rsiDivHook(a) {
  const c = a.map((x) => x.c), rs = rsiSeries(c, 14), n = a.length - 1;
  if (n < 35 || rs[n] == null || rs[n - 1] == null) return { div: 0, hook: 0, r: rs[n] };
  const lo = [], hi = [];
  const start = Math.max(18, n - 45);
  for (let i = start; i <= n - 2; i++) {
    if (rs[i] == null) continue;
    if (a[i].l <= a[i - 1].l && a[i].l <= a[i - 2].l && a[i].l <= a[i + 1].l && a[i].l <= a[i + 2].l) lo.push({ i, p: a[i].l, r: rs[i] });
    if (a[i].h >= a[i - 1].h && a[i].h >= a[i - 2].h && a[i].h >= a[i + 1].h && a[i].h >= a[i + 2].h) hi.push({ i, p: a[i].h, r: rs[i] });
  }
  let div = 0;
  if (lo.length >= 2) {
    const b = lo[lo.length - 1], p0 = lo[lo.length - 2];
    if (n - b.i <= 14 && b.i - p0.i >= 4 && b.p < p0.p && b.r > p0.r + 2 && p0.r < 45) div = 1;
  }
  if (!div && hi.length >= 2) {
    const b = hi[hi.length - 1], p0 = hi[hi.length - 2];
    if (n - b.i <= 14 && b.i - p0.i >= 4 && b.p > p0.p && b.r < p0.r - 2 && p0.r > 55) div = -1;
  }
  const prev3 = [rs[n - 3], rs[n - 2], rs[n - 1]].filter((x) => x != null);
  let hook = 0;
  if (prev3.some((x) => x <= 32) && rs[n] > 32 && rs[n] > rs[n - 1]) hook = 1;
  else if (prev3.some((x) => x >= 68) && rs[n] < 68 && rs[n] < rs[n - 1]) hook = -1;
  return { div, hook, r: rs[n] };
}
function atr(cs, p = 14) {
  if (cs.length < p + 1) return null;
  let a = 0;
  for (let i = 1; i < cs.length; i++) {
    const h = cs[i].h, l = cs[i].l, pc = cs[i - 1].c;
    const tr = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    a = i <= p ? a + tr / p : (a * (p - 1) + tr) / p;
  }
  return a;
}
function macdHist(c) { const a = ema(c, 12), b = ema(c, 26), m = a.map((v, i) => v - b[i]), sg = ema(m, 9); return m.map((v, i) => v - sg[i]); }
function tfTrend(a) {
  const c = a.map((x) => x.c); if (c.length < 80) return 0;
  const e20 = ema(c, 20), e50 = ema(c, 50), i = c.length - 1;
  const f = [e20[i] > e50[i], c[i] > e50[i], e50[i] > e50[i - 5]];
  if (c.length >= 200) { const e200 = ema(c, 200); f.push(c[i] > e200[i]); }
  return f.reduce((t, x) => t + (x ? 1 : -1), 0) / f.length;
}
function sigLevels(a, k, A, pm) {
  const hi = [], lo = [];
  for (let i = k; i < a.length - k; i++) {
    let H = true, L = true, mn = Infinity, mx = -Infinity;
    for (let j = 1; j <= k; j++) {
      if (a[i].h <= a[i - j].h || a[i].h <= a[i + j].h) H = false;
      if (a[i].l >= a[i - j].l || a[i].l >= a[i + j].l) L = false;
      mn = Math.min(mn, a[i - j].l, a[i + j].l); mx = Math.max(mx, a[i - j].h, a[i + j].h);
    }
    if (H && a[i].h - mn >= pm * A) hi.push(a[i].h);
    if (L && mx - a[i].l >= pm * A) lo.push(a[i].l);
  }
  return { hi, lo };
}
function evalCoin(sym, D, btcBias, domCtx = 0) {
  const a = D.m15.a, price = D.m15.live, c = a.map((x) => x.c), n = c.length - 1;
  const t4 = tfTrend(D.h4.a), t1 = tfTrend(D.h1.a), trend = 0.6 * t4 + 0.4 * t1;
  const o = { sym, price, t4, t1, score: 0, dir: 0, reasons: [], warns: [], reject: null, setup: null };
  const rej = (t) => { if (!o.reject) o.reject = t; };
  if (!(price > 0)) { o.reject = 'قیمت نامعتبر'; return o; }
  const d = trend >= 0 ? 1 : -1; o.dir = d;
  const trendOk = Math.abs(trend) >= 0.5 && t4 * t1 > 0;
  if (!trendOk) rej('روند ۱ساعته و ۴ساعته هم‌جهت و قوی نیست');
  const e20 = ema(c, 20), rdh = rsiDivHook(a), r = rdh.r, A = atr(a), H = macdHist(c);
  if (![r, A, e20[n], H[n], H[n - 1]].every(Number.isFinite) || A <= 0) { o.reject = 'اندیکاتور نامعتبر'; return o; }
  const ap = (A / price) * 100;
  if (ap < 0.12) rej('نوسان خیلی کم است');
  if (ap > 2.5) rej('نوسان بیش‌ازحد؛ ریسک لغزش بالا');
  if (d > 0 ? r > 72 : r < 28) rej(d > 0 ? 'اشباع خرید؛ تعقیب قیمت' : 'اشباع فروش؛ تعقیب قیمت');
  const c1h = D.h1.a.map((x) => x.c), n1 = c1h.length - 1;
  const den1 = c1h.slice(n1 - 19).reduce((t, x, i, arr) => (i ? t + Math.abs(x - arr[i - 1]) : t), 0);
  const er1 = den1 > 0 ? Math.abs(c1h[n1] - c1h[n1 - 19]) / den1 : 0;
  if (er1 < 0.2) rej('بازار ۱ساعته رنج است (ER=' + fa(er1, 2) + ')');
  if ((price - c[n]) * d > 0.8 * A) rej('قیمت در جهت معامله پریده؛ منتظر پولبک یا کندل بعدی');

  let ps = Math.max(0, t4 * d) * 25 + Math.max(0, t1 * d) * 15;
  if (trendOk) o.reasons.push('روند ' + (d > 0 ? 'صعودی' : 'نزولی') + ' در ۱ساعته و ۴ساعته');
  const dist = ((price - e20[n]) * d) / A;
  if (dist <= 0.3 && dist >= -1.2) { ps += 15; o.reasons.push('قیمت نزدیک EMA20 (پولبک سالم)'); }
  else if (dist > 1.5) { ps -= 10; o.warns.push('قیمت از EMA20 دور شده؛ احتمال تعقیب'); }
  if (H[n] * d > 0 && (H[n] - H[n - 1]) * d > 0) { ps += 15; o.reasons.push('MACD هم‌جهت و در حال تقویت'); }
  else if (H[n] * d > 0) ps += 7;
  else { ps -= 5; o.warns.push('مومنتوم ۱۵ دقیقه هنوز هم‌جهت نیست'); }
  if (d > 0 ? r >= 40 && r <= 62 : r >= 38 && r <= 60) { ps += 10; o.reasons.push('RSI در محدوده سالم (' + fa(r, 0) + ')'); }
  // واگرایی و چرخش RSI از کف/سقف اشباع
  if (rdh.div * d > 0) { ps += 8; o.reasons.push('واگرایی RSI هم‌جهت'); }
  else if (rdh.div * d < 0) { ps -= 10; o.warns.push('واگرایی RSI خلاف جهت (هشدار ضعف)'); }
  if (rdh.hook * d > 0) { ps += 5; o.reasons.push('چرخش RSI از محدوده اشباع'); }
  ps = Math.min(ps, 62);

  // خانواده مستقل از قیمت: حجم، دلتای تیکر، بیت‌کوین، دامیننس تتر، فاندینگ
  let ns = 0, indep = 0;
  const vAvg = a.slice(-21, -1).reduce((t, x) => t + x.v, 0) / 20, vr = vAvg > 0 ? a[n].v / vAvg : 0;
  if (vr >= 1.2) { ns += 10; indep++; o.reasons.push('حجم بالاتر از میانگین (' + fa(vr, 1) + ' برابر)'); }
  else if (vr < 0.6) { ns -= 5; o.warns.push('حجم ضعیف'); }
  const w8 = a.slice(-8), tv8 = w8.reduce((t, x) => t + x.v, 0);
  const td = tv8 > 0 && w8.every((x) => Number.isFinite(x.tb)) ? w8.reduce((t, x) => t + (2 * x.tb - x.v), 0) / tv8 : null;
  if (td != null) {
    if (td * d >= 0.08) { ns += 15; indep++; o.reasons.push('جریان سفارش تهاجمی هم‌جهت'); }
    else if (td * d <= -0.08) { ns -= 15; o.warns.push('جریان سفارش خلاف جهت'); }
  }
  if (sym !== 'BTCUSDT') {
    if (btcBias * d >= 0.4) { ns += 10; o.reasons.push('بیت‌کوین هم‌جهت است'); }
    else if (btcBias * d <= -0.4) { ns -= 15; o.warns.push('بیت‌کوین خلاف جهت است'); }
  }
  if (domCtx) {
    if (domCtx * d > 0) { ns += 8; indep++; o.reasons.push(d > 0 ? 'دامیننس تتر نزولی (ورود نقدینگی)' : 'دامیننس تتر صعودی (خروج نقدینگی)'); }
    else { ns -= 8; o.warns.push(d > 0 ? 'دامیننس تتر صعودی (خلاف جهت لانگ)' : 'دامیننس تتر نزولی (خلاف جهت شورت)'); }
  }
  const fr = SC.fund[sym];
  if (Number.isFinite(fr)) {
    const f = fr * 100 * d;
    if (f > 0.05) { ns -= 10; o.warns.push('فاندینگ در جهت معامله بالاست'); }
    else if (f < -0.01) { ns += 5; indep++; o.reasons.push('فاندینگ به نفع معامله'); }
  }
  if (trendOk && indep === 0) rej('هیچ تأیید مستقل از قیمت نیست');
  o.score = Math.max(0, Math.min(100, Math.round(ps + Math.max(ns, -40))));

  const last = a.slice(-10), swing = d > 0 ? Math.min(...last.map((x) => x.l)) : Math.max(...last.map((x) => x.h));
  let risk = d > 0 ? price - (swing - 0.2 * A) : swing + 0.2 * A - price;
  risk = Math.max(risk, 1.2 * A);
  if (risk > 2.5 * A) { rej('حد ضرر منطقی دور است (ورود دیر)'); risk = 2.5 * A; }
  const A1h = atr(D.h1.a);
  const P = sigLevels(a.slice(-96), 5, A, 1), Q = Number.isFinite(A1h) ? sigLevels(D.h1.a.slice(-120), 3, A1h, 1) : { hi: [], lo: [] };
  const hiL = [...P.hi, ...Q.hi, Math.max(...a.slice(-96).map((x) => x.h))].filter((x) => x > price * 1.0005);
  const loL = [...P.lo, ...Q.lo, Math.min(...a.slice(-96).map((x) => x.l))].filter((x) => x < price * 0.9995);
  const near = d > 0 ? Math.min(Infinity, ...hiL) : Math.max(-Infinity, ...loL);
  const room = d > 0 ? near - price : price - near, cost = price * 0.0012;
  let tp1 = price + d * 1.5 * risk, tp2 = price + d * 2.5 * risk, capped = false;
  if (room < 1.1 * risk) rej((d > 0 ? 'مقاومت' : 'حمایت') + ' خیلی نزدیک است');
  else if (room < 1.5 * risk) { capped = true; tp1 = price + d * (room - 0.15 * A); tp2 = tp1; o.warns.push('هدف تا سطح کلیدی محدود شد'); }
  const rr1 = (Math.abs(tp1 - price) - cost) / (risk + cost), rr2 = (Math.abs(tp2 - price) - cost) / (risk + cost);
  if (capped ? rr1 < 1 : rr2 < 1.5) rej('نسبت سود به ریسک پس از کارمزد کافی نیست');
  o.setup = { entry: price, maxEntry: price + d * 0.3 * A, sl: price - d * risk, tp1, tp2, rr1, rr2, atrPct: ap, capped, level: Number.isFinite(near) ? near : null };
  return o;
}

// ---------- تلگرام (مدیر + ارسال گروهی به کاربران فعال برای اسکنر و طلایی) ----------
async function tgSendOne(token, chatId, text) {
  if (!token || !chatId) return { ok: false, error: 'missing config' };
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: String(chatId), text: String(text).slice(0, 1500) }),
    });
    const j = await r.json().catch(() => ({}));
    return { ok: !!j.ok, status: r.status, desc: j.description || '' };
  } catch (e) {
    return { ok: false, desc: String(e) };
  }
}
async function tgAdmin(env, text) {
  if (env.NTFY_TOPIC) {
    try {
      await fetch('https://ntfy.sh/' + encodeURIComponent(env.NTFY_TOPIC), {
        method: 'POST',
        headers: { Title: 'GOLBIT', Priority: 'high', Tags: 'chart_with_upwards_trend' },
        body: String(text).slice(0, 1500),
      });
    } catch (_) {}
  }
  if (env.TG_TOKEN && env.TG_CHAT) await tgSendOne(env.TG_TOKEN, env.TG_CHAT, text);
}
async function tgBroadcast(env, text) {
  await tgAdmin(env, text);
  if (!env.TG_TOKEN || !env.SIG) return;
  try {
    const subs = JSON.parse((await env.SIG.get('tg_subs')) || '{}');
    const now = Date.now();
    const sent = new Set(env.TG_CHAT ? [String(env.TG_CHAT)] : []);
    const targets = [];
    for (const uid of Object.keys(subs)) {
      const s = subs[uid];
      if (!s || !s.enabled || !s.chatId) continue;
      const cid = String(s.chatId);
      if (sent.has(cid)) continue;
      // فقط کاربرانی که اشتراک، آزمایشی، مهمان یا دسترسی مدیر فعال دارند
      if (s.admin || (s.until && s.until > now)) {
        sent.add(cid);
        targets.push(cid);
      }
    }
    // سقف امن ساب‌ریکوئست در پلن رایگان کلودفلر
    await Promise.allSettled(targets.slice(0, 18).map((cid) => tgSendOne(env.TG_TOKEN, cid, text)));
  } catch (_) {}
}
let BOT_USER = null;
async function getBotUsername(env) {
  if (BOT_USER) return BOT_USER;
  if (!env.TG_TOKEN) return '';
  if (env.SIG) {
    try { const cached = await env.SIG.get('tg_bot_user'); if (cached) { BOT_USER = cached; return cached; } } catch (_) {}
  }
  try {
    const r = await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/getMe`);
    const j = await r.json();
    if (j && j.ok && j.result && j.result.username) {
      BOT_USER = j.result.username;
      if (env.SIG) await env.SIG.put('tg_bot_user', BOT_USER, { expirationTtl: 7 * 86400 });
      return BOT_USER;
    }
  } catch (_) {}
  return '';
}
async function syncSubExpiry(env, uid, until, admin) {
  if (!env.SIG || !uid) return;
  try {
    const subs = JSON.parse((await env.SIG.get('tg_subs')) || '{}');
    if (subs[uid]) {
      subs[uid].until = until || subs[uid].until || 0;
      subs[uid].admin = !!admin;
      await env.SIG.put('tg_subs', JSON.stringify(subs));
    }
  } catch (_) {}
}

const closeJ = (e, st, pr) => { e.status = st; e.closeT = Date.now(); e.closeP = pr; };
async function tieBreak(e, k) {
  try {
    const d = await bj(`/api/v3/klines?symbol=${e.sym}&interval=1m&startTime=${k[0]}&limit=15`);
    for (const c of d) {
      const h = +c[2], l = +c[3];
      if (e.side > 0 ? l <= e.sl : h >= e.sl) return 'loss';
      if (e.side > 0 ? h >= e.tp : l <= e.tp) return 'win';
    }
  } catch (_) {}
  return 'loss';
}
const nm = (s) => s.replace('USDT', '');
const hm = () => new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Tehran' });
const pp = (x) => (x >= 100 ? Number(x).toFixed(2) : x >= 1 ? Number(x).toFixed(3) : Number(x).toFixed(5));
const pc = (a, b) => { const v = (a / b - 1) * 100; return (v >= 0 ? '+' : '') + v.toFixed(2) + '%'; };
function sigMsg(kind, sym, dir, score, s, note) {
  return (kind === 'gold' ? '🏆 پیشنهاد طلایی GOLBIT' : '📈 اسکنر GOLBIT') + ' | ' + (dir > 0 ? '🟢 LONG' : '🔴 SHORT') + ' | ' + nm(sym) + '\n' +
    '🕒 ساعت تهران: ' + hm() + '\n' +
    '🎯 ورود: ' + pp(s.entry) + (s.maxEntry ? ' (حداکثر ورود ' + pp(s.maxEntry) + ')' : '') + '\n' +
    '🛑 SL: ' + pp(s.sl) + ' (' + pc(s.sl, s.entry) + ')\n' +
    '✅ TP1: ' + pp(s.tp1) + ' (' + pc(s.tp1, s.entry) + ')' + (s.tp2 ? ' | TP2: ' + pp(s.tp2) + ' (' + pc(s.tp2, s.entry) + ')' : '') + '\n' +
    '📊 امتیاز ' + score + (s.rr2 != null ? ' | RR ' + Number(s.rr2).toFixed(2) : '') + '\n' + note;
}

// ---------- کرون اسکنر (هر ۵ دقیقه): اسکن + دفترچه + ارسال اسکنر و طلایی ----------
async function cron(env) {
  if (!env.SIG) return { error: 'KV binding SIG تنظیم نشده' };
  const st = JSON.parse((await env.SIG.get('journal')) || '{"entries":[]}');
  const E = st.entries; let dirty = false; const msgs = [];
  for (const e of E.filter((x) => x.status === 'open')) {
    try {
      const d = await bj(`/api/v3/klines?symbol=${e.sym}&interval=15m&startTime=${e.t}&limit=1000`);
      for (const k of d) {
        const h = +k[2], l = +k[3];
        const hitSL = e.side > 0 ? l <= e.sl : h >= e.sl, hitTP = e.side > 0 ? h >= e.tp : l <= e.tp;
        if (hitSL && hitTP) { const r = await tieBreak(e, k); closeJ(e, r, r === 'win' ? e.tp : e.sl); break; }
        if (hitSL) { closeJ(e, 'loss', e.sl); break; }
        if (hitTP) { closeJ(e, 'win', e.tp); break; }
      }
      if (e.status === 'open' && Date.now() - e.t > 3 * 864e5) closeJ(e, 'expired', d.length ? +d[d.length - 1][4] : null);
      if (e.status !== 'open') {
        dirty = true;
        msgs.push((e.status === 'win' ? '✅ ' : e.status === 'loss' ? '❌ ' : '⏱ ') + nm(e.sym) + ' ' + (e.side > 0 ? 'LONG' : 'SHORT') + ' (اسکنر) بسته شد: ' + (e.status === 'win' ? 'TP1' : e.status === 'loss' ? 'SL' : 'منقضی') + '\n🕒 ' + hm() + ' | ورود ' + pp(e.entry) + ' → خروج ' + pp(e.closeP || e.entry));
      }
    } catch (_) {}
  }
  const dom = await getDomCtx(env, true);
  const SCL = await coinsOf(env, 'scan'), CH = 8, nch = Math.ceil(SCL.length / CH), rot = nch > 1 ? Math.floor(Date.now() / 300000) : 0;
  const chunk = SCL.filter((_, i) => Math.floor(i / CH) === rot % nch);
  const res = await Promise.allSettled(chunk.map(async (s) => ({ s, m15: await kl(s, '15m', 200), h1: await kl(s, '1h', 210), h4: await kl(s, '4h', 210) })));
  const D = {}; res.forEach((r, i) => { if (r.status === 'fulfilled') D[chunk[i]] = r.value; });
  if (chunk.length && !Object.keys(D).length) {
    try {
      if (!(await env.SIG.get('al:scan_data'))) {
        await env.SIG.put('al:scan_data', '1', { expirationTtl: 3600 });
        await tgAdmin(env, '⚠️ هشدار سیستم GOLBIT: دریافت داده کندل بایننس در موتور اسکنر با خطا مواجه شد.');
      }
    } catch (_) {}
  }
  let BT = D.BTCUSDT; if (!BT) { try { BT = { h1: await kl('BTCUSDT', '1h', 210), h4: await kl('BTCUSDT', '4h', 210) }; } catch (_) {} }
  const bb = BT ? 0.6 * tfTrend(BT.h4.a) + 0.4 * tfTrend(BT.h1.a) : 0;
  const ev = chunk.filter((s) => D[s]).map((s) => evalCoin(s, D[s], bb, dom.ctx));
  for (const x of ev) {
    if (!x.reject && x.score >= SC_MIN) {
      try {
        await env.SIG.put('sg:' + x.sym, JSON.stringify({ dir: x.dir, score: x.score, e: x.setup?.entry, t1: x.setup?.tp1, sl: x.setup?.sl, ts: Date.now() }), { expirationTtl: 10800 });
      } catch (_) {}
    }
  }
  const best = ev.filter((x) => !x.reject && x.score >= SC_MIN).sort((a, b) => b.score - a.score)[0];
  let opened = null;
  if (best && !E.some((e) => e.status === 'open' && e.sym === best.sym)) {
    const last = [...E].reverse().find((e) => e.sym === best.sym);
    if (!(last && last.side === best.dir && Date.now() - (last.closeT || last.t) < 15 * 60000)) {
      const s = best.setup;
      opened = { id: Date.now(), t: Date.now(), sym: best.sym, side: best.dir, entry: s.entry, tp: s.tp1, sl: s.sl, src: 'scan', ttl: 0, score: best.score, status: 'open' };
      E.push(opened); dirty = true;
      // بررسی هم‌جهتی هم‌زمان با اسکالپ برای پیام طلایی
      let isGold = false;
      try {
        const scLive = JSON.parse((await env.SIG.get('scl:' + best.sym)) || 'null');
        if (scLive && scLive.dir === best.dir && scLive.score >= 65 && best.score >= 70 && Date.now() - scLive.ts < 20 * 60000 && Math.abs(scLive.e / s.entry - 1) <= 0.012) {
          const gk = 'gd:' + best.sym + best.dir;
          if (!(await env.SIG.get(gk))) {
            await env.SIG.put(gk, '1', { expirationTtl: 1800 });
            isGold = true;
            msgs.push('🌟🌟 هم‌جهتی کامل اسکنر (' + best.score + ') و اسکالپ (' + scLive.score + ') 🌟🌟\n' + sigMsg('gold', best.sym, best.dir, Math.round((best.score + scLive.score) / 2), s, '⏳ اعتبار اسکنر: تا TP/SL (حداکثر ۳ روز)'));
          }
        }
      } catch (_) {}
      if (!isGold) msgs.push(sigMsg('scan', best.sym, best.dir, best.score, s, '⏳ اعتبار: تا رسیدن به TP/SL (حداکثر ۳ روز)'));
    }
  }
  if (dirty) { st.entries = E.slice(-500); st.ts = Date.now(); await env.SIG.put('journal', JSON.stringify(st)); }
  for (const m of msgs) await tgBroadcast(env, m);
  return { scanned: Object.keys(D).length, opened: !!opened, changed: dirty, domCtx: dom.ctx, scores: ev.map((x) => [x.sym, x.score, x.reject || 'OK']) };
}

// ============================================================
// اسکالپ سمت سرور: فقط برای تشخیص «پیشنهاد طلایی» و خطاهای سیستم
// (سیگنال اسکالپ عادی به تلگرام فرستاده نمی‌شود)
// ============================================================
const SCALP = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'LINKUSDT'];
const SCALP_MIN_SCORE = 50;
const clamp1 = (x) => Math.max(-1, Math.min(1, Number.isFinite(x) ? x : 0));
async function klr(sym, tf, n) {
  const d = await bj(`/api/v3/klines?symbol=${sym}&interval=${tf}&limit=${n}`);
  if (!Array.isArray(d) || d.length < 62) throw new Error('کندل ناکافی');
  const a = d.map((k) => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5], tb: +k[9] }));
  if (a.some((x) => ![x.o, x.h, x.l, x.c, x.v, x.tb].every(Number.isFinite) || x.h < x.l || x.c <= 0)) throw new Error('کندل نامعتبر');
  return a;
}
function swingStruct(a, k) {
  const H = [], L = [];
  for (let i = k; i < a.length - k; i++) {
    let h = true, l = true;
    for (let j = 1; j <= k; j++) { if (a[i].h <= a[i - j].h || a[i].h <= a[i + j].h) h = false; if (a[i].l >= a[i - j].l || a[i].l >= a[i + j].l) l = false; }
    if (h) H.push(a[i].h); if (l) L.push(a[i].l);
  }
  if (H.length < 2 || L.length < 2) return { dir: 0, bos: 0 };
  const hh = H[H.length - 1] > H[H.length - 2], hl = L[L.length - 1] > L[L.length - 2], c = a[a.length - 1].c;
  return { dir: hh && hl ? 1 : !hh && !hl ? -1 : 0, bos: c > H[H.length - 1] ? 1 : c < L[L.length - 1] ? -1 : 0 };
}
function trendOfC(c) {
  if (c.length < 40) return 0;
  const e9 = ema(c, 9).at(-1), e21 = ema(c, 21).at(-1), a = ema(c, 12), b = ema(c, 26);
  const m = a.map((v, i) => v - b[i]), sg = ema(m, 9), h = m.at(-1) - sg.at(-1);
  if (![e9, e21, h].every(Number.isFinite)) return 0;
  const x = (e9 > e21 ? 1 : -1) + (h > 0 ? 1 : -1);
  return x === 2 ? 1 : x === -2 ? -1 : 0;
}
function scalpEvalS(sym, K1, K5, H1, dp, fr, costPct, domCtx = 0) {
  const R = { sym, gate: [], comp: [], score: 0, dir: 0, gateOk: false, ok: false, setup: null, why: null };
  const bids = (dp.bids || []).map((x) => [+x[0], +x[1]]), asks = (dp.asks || []).map((x) => [+x[0], +x[1]]);
  if (!bids.length || !asks.length) { R.why = 'دفتر سفارش خالی'; return R; }
  const bid = bids[0][0], ask = asks[0][0], mid = (bid + ask) / 2;
  const a1 = K1.slice(0, -1), a5 = K5.slice(0, -1), c1 = a1.map((x) => x.c), c5 = a5.map((x) => x.c);
  const A1 = atr(a1), A5 = atr(a5);
  if (![A1, A5].every(Number.isFinite) || A5 <= 0 || A1 <= 0) { R.why = 'اندیکاتور نامعتبر'; return R; }
  const gate = (name, ok, val) => R.gate.push({ name, ok, val });
  const spr = ((ask - bid) / mid) * 1e4;
  gate('اسپرد', spr <= (/^(BTC|ETH)/.test(sym) ? 2.5 : 8), fa(spr, 2) + ' bps');
  const slip = (side) => {
    const bk = side > 0 ? asks : bids; let need = 1e4, cost = 0, qty = 0;
    for (const [p, q] of bk) { const v = p * q, t = Math.min(need, v); cost += t; qty += t / p; need -= t; if (need <= 0) break; }
    return need > 0 ? null : Math.abs(cost / qty / mid - 1) * 1e4;
  };
  const sb = slip(1), ss = slip(-1), sm = sb == null || ss == null ? null : Math.max(sb, ss);
  gate('لغزش سفارش ۱۰هزار دلاری', sm != null && sm <= 4, sm == null ? 'عمق کافی نیست' : fa(sm, 2) + ' bps');
  const ap5 = (A5 / mid) * 100; gate('نوسان ۵دقیقه‌ای', ap5 >= 0.04 && ap5 <= 0.8, fa(ap5, 2) + '٪');
  const l1 = a1[a1.length - 1], spike = (l1.h - l1.l) / A1; gate('بدون جهش ناگهانی', spike < 3, fa(spike, 1) + ' برابر ATR');
  R.gateOk = R.gate.every((x) => x.ok);

  const add = (name, w, v, fam) => R.comp.push({ name, w, v: clamp1(v), fam: fam || 'price' });
  const delta = (arr) => { const v = arr.reduce((t, x) => t + x.v, 0); return v > 0 ? arr.reduce((t, x) => t + (2 * x.tb - x.v), 0) / v : 0; };
  add('حجم مهاجم ~۱-۲ دقیقه', 15, delta(K1.slice(-2)) / 0.4, 'flow');
  add('CVD ۵دقیقه', 10, delta(K1.slice(-5)) / 0.25, 'flow');
  const B = bids.slice(0, 10).reduce((t, x) => t + x[0] * x[1], 0), A = asks.slice(0, 10).reduce((t, x) => t + x[0] * x[1], 0), imb = B + A > 0 ? (B - A) / (B + A) : 0;
  add('عدم‌توازن دفتر سفارش', 10, imb / 0.3, 'book');
  const wl = (bk) => { const v = bk.slice(0, 20).map((x) => x[0] * x[1]); if (v.length < 10) return 0; const mean = v.reduce((t, x) => t + x, 0) / v.length; return mean > 0 ? Math.max(...v.slice(0, 10)) / mean : 0; };
  const aw = wl(asks), bw = wl(bids);
  add('دیوار سفارش', 5, aw >= 4 && bw < 4 ? -1 : bw >= 4 && aw < 4 ? 1 : 0, 'book');
  add('ازدحام فاندینگ', 10, Number.isFinite(fr) ? (fr > 0.05 ? -1 : fr < -0.01 ? 1 : 0) * 0.6 : 0, 'deriv');
  const e9 = ema(c1, 9).at(-1), e21 = ema(c1, 21).at(-1), w = a1.slice(-60), pv = w.reduce((t, x) => t + ((x.h + x.l + x.c) / 3) * x.v, 0), vv = w.reduce((t, x) => t + x.v, 0), vwap = vv > 0 ? pv / vv : mid;
  add('VWAP ۱ساعته', 8, (mid - vwap) / (0.8 * A5));
  add('EMA9/21 یک‌دقیقه‌ای', 7, (e9 - e21) / (0.5 * A1));
  const Hm = macdHist(c5), h0 = Hm.at(-1), h1 = Hm.at(-2);
  add('MACD پنج‌دقیقه‌ای', 5, (h0 > 0 ? 0.5 : -0.5) + (h0 > h1 ? 0.5 : -0.5));
  const prev = a1.slice(-16, -1), hi15 = Math.max(...prev.map((x) => x.h)), lo15 = Math.min(...prev.map((x) => x.l)), vAvg = a1.slice(-21, -1).reduce((t, x) => t + x.v, 0) / 20, vr = vAvg > 0 ? l1.v / vAvg : 0;
  const bo = l1.c > hi15 && mid > hi15 && vr >= 1.3 ? 1 : l1.c < lo15 && mid < lo15 && vr >= 1.3 ? -1 : 0;
  const prev2 = a1.slice(-17, -2), h2 = Math.max(...prev2.map((x) => x.h)), l2 = Math.min(...prev2.map((x) => x.l)), pc = a1[a1.length - 2];
  const fake = pc.c > h2 && l1.c <= h2 ? -1 : pc.c < l2 && l1.c >= l2 ? 1 : 0;
  add('شکست ۱۵دقیقه‌ای', 5, bo || fake);
  add('روند ۱ساعته', 5, trendOfC(H1.slice(0, -1).map((x) => x.c)));
  const ss5 = swingStruct(a5.slice(-80), 2); add('ساختار ۵دقیقه‌ای', 8, ss5.dir * 0.7 + ss5.bos * 0.5);
  const rdh5 = rsiDivHook(a5); add('واگرایی و چرخش RSI پنج‌دقیقه', 6, rdh5.div * 0.8 + rdh5.hook * 0.5);
  add('دامیننس تتر (زمینه)', 10, domCtx || 0, 'ctx');

  const FW = { flow: 30, price: 26, book: 15, deriv: 19, ctx: 10 }, fv = {};
  Object.keys(FW).forEach((f) => { const cs = R.comp.filter((x) => x.fam === f), sw = cs.reduce((t, x) => t + x.w, 0); fv[f] = sw > 0 ? cs.reduce((t, x) => t + x.w * x.v, 0) / sw : 0; });
  const S0 = Object.keys(FW).reduce((t, f) => t + FW[f] * fv[f], 0);
  const n5 = c5.length - 1, den = c5.slice(n5 - 19, n5 + 1).reduce((t, x, i, arr) => (i ? t + Math.abs(x - arr[i - 1]) : t), 0), er = den > 0 ? Math.abs(c5[n5] - c5[n5 - 19]) / den : 0;
  const regime = er >= 0.3 ? 1 : er >= 0.2 ? 0.85 : 0.65;
  R.score = Math.round(Math.abs(S0) * regime); R.dir = S0 >= 0 ? 1 : -1; R.fam = fv;
  {
    const dd = R.dir, agree = ['flow', 'price', 'book', 'deriv'].filter((f) => fv[f] * dd >= 0.25);
    gate('تأیید مستقل (≥۲ خانواده، یکی جریان/دفتر سفارش)', agree.length >= 2 && (agree.includes('flow') || agree.includes('book')), agree.join('+') || 'هیچ');
    gate('جریان سفارش مخالف نیست', fv.flow * dd > -0.2, fa(fv.flow * dd * 100, 0) + '٪');
    gate('رژیم بازار (روندی بودن)', er >= 0.15, 'ER=' + fa(er, 2));
    const m2 = ((mid / c5[Math.max(0, n5 - 24)] - 1) * 100) * dd, rs = rdh5.r, ap = (A5 / mid) * 100, ext = m2 > 10 * ap || (rs != null && (dd < 0 ? rs < 30 : rs > 70));
    gate('بدون کشیدگی', !ext, (m2 >= 0 ? '+' : '') + m2.toFixed(2) + '% | RSI ' + (rs == null ? '—' : Math.round(rs)));
    R.gateOk = R.gate.every((x) => x.ok);
  }
  const d = R.dir, l8 = a1.slice(-8), sw = d > 0 ? Math.min(...l8.map((x) => x.l)) : Math.max(...l8.map((x) => x.h));
  let risk = d > 0 ? mid - (sw - 0.1 * A5) : sw + 0.1 * A5 - mid; risk = Math.max(risk, 0.8 * A5);
  const cost = mid * (costPct / 100), rr2 = (2.5 * risk - cost) / (risk + cost);
  const lv = sigLevels(a5.slice(-96), 3, A5, 1); lv.hi.push(Math.max(...a5.slice(-96).map((x) => x.h))); lv.lo.push(Math.min(...a5.slice(-96).map((x) => x.l)));
  const near = d > 0 ? Math.min(Infinity, ...lv.hi.filter((x) => x > mid * 1.0002)) : Math.max(-Infinity, ...lv.lo.filter((x) => x < mid * 0.9998));
  const room = Number.isFinite(near) ? (d > 0 ? near - mid : mid - near) : Infinity;
  if (risk > 1.6 * A5) R.why = 'حد ضرر منطقی دور است (ورود دیر)';
  else if (room < 1.2 * risk) R.why = (d > 0 ? 'مقاومت' : 'حمایت') + ' نزدیک است';
  else if (rr2 < 1.5) R.why = 'حرکت قابل‌انتظار نسبت به کارمزد کوچک است';
  let t1 = mid + d * 1.5 * risk; if (Number.isFinite(room) && room < 1.5 * risk) t1 = mid + d * (room - 0.1 * A5);
  R.setup = { entry: mid, maxEntry: mid + d * 0.15 * A5, sl: mid - d * risk, tp1: t1, tp2: mid + d * 2.5 * risk, rr2 };
  if (!R.gateOk) R.why = 'گیت رد شد: ' + R.gate.filter((x) => !x.ok).map((x) => x.name).join('، ');
  else if (R.score < SCALP_MIN_SCORE) R.why = 'قدرت سیگنال کمتر از ' + SCALP_MIN_SCORE;
  R.ok = R.gateOk && R.score >= SCALP_MIN_SCORE && !R.why;
  return R;
}

async function scalpCron(env, all) {
  const SL = await coinsOf(env, 'scalp');
  // حداکثر ۵ ارز در هر دقیقه تا با ۱۵ ارز هم سقف ۵۰ درخواست کل) {
  const SL = await coinsOf(env, 'scalp');
  // حداکثر ۵ ارز در هر دقیقه تا با ۱۵ ارز هم سقف ۵۰ درخواست کلودفلر رایگان رد نشود
  const CH = 5, nch = Math.max(1, Math.ceil(SL.length / CH)), slot = Math.floor(Date.now() / 60000) % nch;
  const list = all ? SL.slice(0, 10) : SL.slice(slot * CH, (slot + 1) * CH);
  const costPct = parseFloat(env.SCALP_COST) || 0.12;
  const dom = await getDomCtx(env, false);
  const fund = {};
  try { const r = await fetch('https://fapi.binance.com/fapi/v1/premiumIndex', { headers: { 'User-Agent': 'Mozilla/5.0' } }); if (r.ok) (await r.json()).forEach((x) => { fund[x.symbol] = +x.lastFundingRate * 100; }); } catch (_) {}
  const outList = [];
  await Promise.allSettled(list.map(async (sym) => {
    try {
      const [K1, K5, H1, dp] = await Promise.all([klr(sym, '1m', 100), klr(sym, '5m', 100), klr(sym, '1h', 100), bj(`/api/v3/depth?symbol=${sym}&limit=20`)]);
      outList.push(scalpEvalS(sym, K1, K5, H1, dp, fund[sym], costPct, dom.ctx));
    } catch (_) { outList.push({ sym, ok: false, score: 0, why: 'داده دریافت نشد' }); }
  }));
  if (outList.length && outList.every((x) => x.why === 'داده دریافت نشد') && env.SIG) {
    try {
      if (!(await env.SIG.get('al:data'))) {
        await env.SIG.put('al:data', '1', { expirationTtl: 3600 });
        await tgAdmin(env, '⚠️ هشدار سیستم GOLBIT: داده‌ی بازار (بایننس) دریافت نمی‌شود.');
      }
    } catch (_) {}
  }
  const goldenSent = [];
  for (const R of outList.filter((x) => x.ok && x.score >= 65).sort((a, b) => b.score - a.score)) {
    if (env.SIG) {
      try { await env.SIG.put('scl:' + R.sym, JSON.stringify({ dir: R.dir, score: R.score, e: R.setup?.entry, ts: Date.now() }), { expirationTtl: 1200 }); } catch (_) {}
      // فقط اگر با اسکنر هم‌جهت و هماهنگ بود (پیشنهاد طلایی) به تلگرام برود؛ اسکالپ عادی به تلگرام نمی‌رود
      try {
        const g = JSON.parse((await env.SIG.get('sg:' + R.sym)) || 'null');
        if (g && g.dir === R.dir && g.score >= 70 && cohere(g, R)) {
          const gk = 'gd:' + R.sym + R.dir;
          if (!(await env.SIG.get(gk))) {
            await env.SIG.put(gk, '1', { expirationTtl: 1800 });
            const avgScore = Math.round((g.score + R.score) / 2);
            await tgBroadcast(env, '🌟🌟 هم‌جهتی کامل اسکنر (' + g.score + ') و اسکالپ (' + R.score + ') 🌟🌟\n' +
              sigMsg('gold', R.sym, R.dir, avgScore, R.setup, '⏳ اعتبار ورود اسکالپ: ۲۰ دقیقه\n📈 دید روند اسکنر: هدف ' + pp(g.t1) + ' | SL روند ' + pp(g.sl)));
            goldenSent.push(R.sym);
          }
        }
      } catch (_) {}
    }
  }
  return { scanned: list.length, goldenSignals: goldenSent, scores: outList.map((x) => [x.sym, x.score, x.dir, x.ok ? 'OK' : x.why]) };
}

// ---------- شمارنده آنلاین سراسری (همگام با KV بدون مصرف زیاد Write) ----------
const ONL = new Map();
let onlReadAt = 0, onlWriteAt = 0;
async function handlePing(id, env) {
  const now = Date.now(), TTL = 300000;
  if (env.SIG && now - onlReadAt > 40000) {
    try {
      const raw = JSON.parse((await env.SIG.get('onl_map')) || '{}');
      for (const [k, t] of Object.entries(raw)) {
        if (now - t < TTL) ONL.set(k, Math.max(ONL.get(k) || 0, t));
      }
      onlReadAt = now;
    } catch (_) {}
  }
  const isNew = id && !ONL.has(id);
  if (id) ONL.set(id, now);
  for (const [k, t] of ONL) if (now - t > TTL) ONL.delete(k);
  if (env.SIG && (isNew || now - onlWriteAt > 240000)) {
    try {
      const obj = {};
      let c = 0;
      for (const [k, t] of ONL) { if (c++ < 500) obj[k] = t; }
      await env.SIG.put('onl_map', JSON.stringify(obj), { expirationTtl: 600 });
      onlWriteAt = now;
    } catch (_) {}
  }
  return Math.max(1, ONL.size);
}

// ---------- اشتراک (۹٫۹۹، ۲۶٫۹۹، ۸۹٫۹۹) + مهمان ۷ روزه ----------
const WALLET_DEFAULT = 'TMiRbjMb4dwzcwmZcbC5hfuDnwctRY2aAN';
const PLANS = { m1: { price: 9.99, days: 30 }, m3: { price: 26.99, days: 90 }, y1: { price: 89.99, days: 365 } };
const USDT_TRC20 = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

async function lic(p, u, req, env) {
  const kv = env.SIG, now = Date.now(), WALLET = env.LIC_WALLET || WALLET_DEFAULT, TH = parseFloat(env.TRIAL_H || '24');
  if (!kv) return out({ error: 'KV تنظیم نشده' }, 500, 0);

  // ساخت / لیست / حذف اکانت مهمان توسط مدیر
  if (p === '/lic/guest-admin' && req.method === 'POST') {
    const ak = env.ADMIN_KEY || env.NOTIFY_KEY, ip = req.headers.get('CF-Connecting-IP') || 'x', fk = 'af:' + ip;
    if (!ak) return out({ error: 'رمز مدیر تنظیم نشده' }, 403, 0);
    const fails = parseInt((await kv.get(fk)) || '0', 10);
    if (fails >= 8) return out({ error: 'تلاش بیش از حد؛ ۱۰ دقیقه بعد' }, 429, 0);
    if (!safeEq(req.headers.get('X-Key') || '', ak)) { await kv.put(fk, String(fails + 1), { expirationTtl: 600 }); return out({ error: 'unauthorized' }, 401, 0); }
    let body = {}; try { body = await req.json(); } catch (_) {}
    const op = String(body.op || 'list');
    let G = {}; try { G = JSON.parse((await kv.get('guests')) || '{}'); } catch (_) {}
    if (op === 'list') {
      const list = Object.keys(G).map((k) => {
        const g = G[k];
        const status = !g.activatedAt ? 'waiting' : g.expiresAt > now ? 'active' : 'expired';
        return { user: k, pass: g.pass, days: g.days, createdAt: g.createdAt, activatedAt: g.activatedAt || 0, expiresAt: g.expiresAt || 0, status };
      }).sort((a, b) => b.createdAt - a.createdAt);
      return out({ ok: true, list }, 200, 0);
    }
    const uname = String(body.user || '').trim().toLowerCase().replace(/[^a-z0-9_.-]/g, '').slice(0, 24);
    if (op === 'create') {
      const pass = String(body.pass || '').trim().slice(0, 32);
      const days = Math.max(1, Math.min(365, parseInt(body.days, 10) || 7));
      if (uname.length < 3 || pass.length < 4) return out({ error: 'نام کاربری حداقل ۳ حرف انگلیسی/عدد و رمز حداقل ۴ کاراکتر باشد' }, 400, 0);
      G[uname] = { pass, days, createdAt: now, activatedAt: 0, expiresAt: 0, uid: '' };
      await kv.put('guests', JSON.stringify(G));
      return out({ ok: true, user: uname, pass, days }, 200, 0);
    }
    if (op === 'delete') {
      const prev = G[uname];
      if (prev && prev.uid) {
        try {
          const rec = JSON.parse((await kv.get('u:' + prev.uid)) || 'null');
          if (rec && rec.guest === uname) { rec.paidUntil = 1; await kv.put('u:' + prev.uid, JSON.stringify(rec)); await syncSubExpiry(env, prev.uid, 1, false); }
        } catch (_) {}
      }
      delete G[uname];
      await kv.put('guests', JSON.stringify(G));
      return out({ ok: true }, 200, 0);
    }
    return out({ error: 'عملیات نامعتبر' }, 400, 0);
  }

  // ورود کاربر مهمان (مهلت ۷ روزه از اولین ورود)
  if (p === '/lic/guest-login' && req.method === 'POST') {
    const ip = req.headers.get('CF-Connecting-IP') || 'x', fk = 'gf:' + ip;
    const fails = parseInt((await kv.get(fk)) || '0', 10);
    if (fails >= 10) return out({ error: 'تلاش بیش از حد؛ ۱۰ دقیقه بعد دوباره امتحان کن' }, 429, 0);
    let body = {}; try { body = await req.json(); } catch (_) {}
    const uname = String(body.user || '').trim().toLowerCase().replace(/[^a-z0-9_.-]/g, '').slice(0, 24);
    const pass = String(body.pass || '').trim();
    const uidIn = String(body.uid || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 32);
    const dev = String(body.dev || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 24);
    if (!uname || !pass || uidIn.length < 12) return out({ error: 'نام کاربری و رمز را کامل وارد کن' }, 400, 0);
    let G = {}; try { G = JSON.parse((await kv.get('guests')) || '{}'); } catch (_) {}
    const g = G[uname];
    if (!g || !safeEq(pass, g.pass)) {
      await kv.put(fk, String(fails + 1), { expirationTtl: 600 });
      return out({ error: 'نام کاربری یا رمز اشتباه است' }, 401, 0);
    }
    if (g.activatedAt && g.expiresAt <= now) return out({ error: 'مهلت ' + g.days + ' روزه‌ی این اکانت به پایان رسیده است' }, 403, 0);
    let targetUid = g.uid || uidIn;
    if (!g.activatedAt) {
      g.activatedAt = now;
      g.expiresAt = now + (g.days || 7) * 86400e3;
      g.uid = targetUid;
      await kv.put('guests', JSON.stringify(G));
    }
    const rec = JSON.parse((await kv.get('u:' + targetUid)) || 'null') || {};
    rec.devs = rec.devs || [];
    if (dev && !rec.devs.includes(dev)) {
      if (rec.devs.length >= 2) return out({ error: 'این اکانت مهمان روی ۲ دستگاه فعال شده و امکان ورود روی دستگاه سوم نیست.' }, 403, 0);
      rec.devs.push(dev);
    }
    rec.paidUntil = Math.max(rec.paidUntil || 0, g.expiresAt);
    rec.guest = uname;
    await kv.put('u:' + targetUid, JSON.stringify(rec));
    await syncSubExpiry(env, targetUid, rec.paidUntil, false);
    return out({ ok: true, state: 'paid', uid: targetUid, until: rec.paidUntil, guest: uname, days: g.days }, 200, 0);
  }

  const uid = String(u.searchParams.get('uid') || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 32);
  if (uid.length < 12) return out({ error: 'کد نامعتبر' }, 400, 0);
  const rec = JSON.parse((await kv.get('u:' + uid)) || 'null') || {};
  const save = () => kv.put('u:' + uid, JSON.stringify(rec));
  const state = () => {
    const paid = rec.paidUntil && rec.paidUntil > now, trial = rec.trialEnd && rec.trialEnd > now;
    return {
      state: paid ? 'paid' : trial ? 'trial' : rec.trialEnd || rec.paidUntil ? 'expired' : 'new',
      until: paid ? rec.paidUntil : trial ? rec.trialEnd : 0,
      now,
      admin: !!rec.admin,
      guest: rec.guest || '',
    };
  };
  const dev = String(u.searchParams.get('dev') || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 24);
  if (dev && !rec.admin) {
    rec.devs = rec.devs || [];
    if (!rec.devs.includes(dev)) {
      if (rec.devs.length >= 2 && (rec.paidUntil || rec.trialEnd)) return out({ state: 'devices', error: 'این کد روی ۲ دستگاه فعال است. برای تعویض دستگاه از تب «پیام» با مدیر تماس بگیر یا با دستگاه‌های قبلی وارد شو.' }, 200, 0);
      rec.devs.push(dev);
      if (rec.paidUntil || rec.trialEnd) await save();
    }
  }
  if (p === '/lic/status') return out(state(), 200, 0);
  if (p === '/lic/trial') {
    if (rec.trialEnd || rec.paidUntil) return out(state(), 200, 0);
    const ik = 'ti:' + (req.headers.get('CF-Connecting-IP') || 'x');
    if (await kv.get(ik)) { rec.trialEnd = 1; await save(); return out({ ...state(), reason: 'ip' }, 200, 0); }
    rec.trialEnd = now + TH * 3600e3;
    await save();
    await kv.put(ik, String(now), { expirationTtl: 30 * 86400 });
    return out(state(), 200, 0);
  }
  if (p === '/lic/admin') {
    const ak = env.ADMIN_KEY || env.NOTIFY_KEY, ip = req.headers.get('CF-Connecting-IP') || 'x', fk = 'af:' + ip;
    if (!ak) return out({ error: 'رمز مدیر در Worker تنظیم نشده (ADMIN_KEY یا NOTIFY_KEY)' }, 403, 0);
    const fails = parseInt((await kv.get(fk)) || '0', 10);
    if (fails >= 8) return out({ error: 'تلاش بیش از حد؛ ۱۰ دقیقه بعد دوباره امتحان کن' }, 429, 0);
    if (!safeEq(req.headers.get('X-Key') || u.searchParams.get('key'), ak)) { await kv.put(fk, String(fails + 1), { expirationTtl: 600 }); return out({ error: 'رمز اشتباه است' }, 401, 0); }
    rec.paidUntil = now + 3650 * 864e5; rec.admin = true;
    await save();
    await syncSubExpiry(env, uid, rec.paidUntil, true);
    return out({ ...state(), admin: true }, 200, 0);
  }
  if (p === '/lic/start') {
    const plan = PLANS[u.searchParams.get('plan')] ? u.searchParams.get('plan') : 'm1', P = PLANS[plan];
    let micro = rec.plan === plan && rec.pay && rec.payTs && now - rec.payTs < 72 * 3600e3 ? rec.pay : 0;
    if (!micro) {
      if (rec.pay) await kv.delete('pm:' + rec.pay);
      // کاهش ۱ تا ۱۹۹ هزارم تتر (۳ رقم اعشار، همواره کمتر یا مساوی قیمت اعلامی)
      for (let i = 0; i < 40 && !micro; i++) {
        const m = Math.round(P.price * 1e6) - (1 + Math.floor(Math.random() * 199)) * 1000;
        const holder = await kv.get('pm:' + m);
        if (!holder || holder === uid) { micro = m; await kv.put('pm:' + m, uid, { expirationTtl: 72 * 3600 }); }
      }
      if (!micro) return out({ error: 'شلوغ است؛ دوباره تلاش کن' }, 503, 0);
      rec.pay = micro; rec.payTs = now; rec.plan = plan; await save();
    }
    return out({ wallet: WALLET, network: 'TRC20', amount: Number((micro / 1e6).toFixed(3)), amountText: (micro / 1e6).toFixed(3), price: P.price, days: P.days, plan }, 200, 0);
  }
  if (p === '/lic/check') {
    if (!rec.pay) return out({ ...state(), paid: false }, 200, 0);
    const r = await fetch('https://api.trongrid.io/v1/accounts/' + WALLET + '/transactions/trc20?only_to=true&only_confirmed=true&limit=200&contract_address=' + USDT_TRC20 + '&min_timestamp=' + (now - 96 * 3600e3),
      { headers: env.TRONGRID_KEY ? { 'TRON-PRO-API-KEY': env.TRONGRID_KEY } : {} });
    if (!r.ok) return out({ ...state(), paid: false, error: 'خطا در خواندن بلاک‌چین (HTTP ' + r.status + ')' }, 200, 0);
    const list = (await r.json()).data || [];
    const hit = list.find((t) => t.to === WALLET && t.token_info && t.token_info.address === USDT_TRC20 && Number(t.value) === rec.pay && t.block_timestamp >= rec.payTs - 3600e3);
    if (!hit) return out({ ...state(), paid: false }, 200, 0);
    const used = await kv.get('x:' + hit.transaction_id);
    if (used && used !== uid) return out({ ...state(), paid: false, error: 'این تراکنش برای کد دیگری ثبت شده' }, 200, 0);
    if (!used) {
      await kv.put('x:' + hit.transaction_id, uid);
      rec.paidUntil = Math.max(now, rec.paidUntil || 0) + (PLANS[rec.plan] || PLANS.m1).days * 86400e3;
      rec.guest = '';
      await kv.delete('pm:' + rec.pay);
      rec.pay = 0;
      await save();
      await syncSubExpiry(env, uid, rec.paidUntil, !!rec.admin);
      await tgAdmin(env, '💰 اشتراک جدید فعال شد! پلن: ' + rec.plan + ' | کاربر: ' + uid.slice(0, 6) + '…');
    }
    return out({ ...state(), paid: true }, 200, 0);
  }
  return out({ error: 'مسیر ناشناخته' }, 404, 0);
}

// ---------- اتصال تلگرام برای همه کاربران ----------
async function handleTgApi(p, u, req, env) {
  const kv = env.SIG;
  if (!kv) return out({ error: 'KV تنظیم نشده' }, 500, 0);
  if (p === '/tg/setup') {
    const ak = env.ADMIN_KEY || env.NOTIFY_KEY;
    if (!ak || !safeEq(req.headers.get('X-Key') || u.searchParams.get('key'), ak)) return out({ error: 'unauthorized' }, 401, 0);
    if (!env.TG_TOKEN) return out({ error: 'TG_TOKEN در Worker تنظیم نشده' }, 400, 0);
    const hookUrl = u.origin + '/tg-hook';
    const r = await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/setWebhook`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: hookUrl }),
    });
    const j = await r.json().catch(() => ({}));
    const bot = await getBotUsername(env);
    return out({ ok: !!j.ok, bot, hookUrl, desc: j.description || '' }, 200, 0);
  }
  if (p === '/tg/status') {
    const uid = String(u.searchParams.get('uid') || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 32);
    const bot = await getBotUsername(env);
    let sub = null;
    if (uid.length >= 12) {
      try { const subs = JSON.parse((await kv.get('tg_subs')) || '{}'); sub = subs[uid] || null; } catch (_) {}
    }
    return out({ ok: true, bot, enabled: !!(sub && sub.enabled), chatId: sub ? sub.chatId : '' }, 200, 0);
  }
  if (p === '/tg/bind' && req.method === 'POST') {
    let body = {}; try { body = await req.json(); } catch (_) {}
    const uid = String(body.uid || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 32);
    const rawId = String(body.chatId || '').trim();
    const bot = await getBotUsername(env);
    if (uid.length < 12) return out({ error: 'کد دستگاه نامعتبر است' }, 400, 0);
    if (/^@/.test(rawId) || !/^-?\d{