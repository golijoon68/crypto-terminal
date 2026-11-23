// ============================================================
// GoliBit Quant Engine v13 — هسته واحد تحلیل چندلایه، رژیم بازار و مدیریت ریسک
// بدون Look-Ahead Bias | قابل اجرا هم‌زمان در مرورگر، Cloudflare Worker و بک‌تست
// ============================================================

export const TF_MS = {
  '1m': 60e3, '5m': 300e3, '15m': 900e3, '30m': 1800e3,
  '1h': 3600e3, '4h': 14400e3, '1d': 86400e3, '1w': 604800e3,
};

export const LAYERS = ['structure', 'smc', 'priceAction', 'momentum', 'volume', 'derivatives', 'mtf', 'context'];

// ماتریس وزن پیش‌فرض به تفکیک ۶ رژیم بازار (در موتور یادگیری قابل کالیبراسیون با سقف ایمنی)
export const DEFAULT_REGIME_WEIGHTS = {
  TREND_UP:    { structure: 20, smc: 14, priceAction: 10, momentum: 14, volume: 12, derivatives: 10, mtf: 14, context: 6 },
  TREND_DOWN:  { structure: 20, smc: 14, priceAction: 10, momentum: 14, volume: 12, derivatives: 10, mtf: 14, context: 6 },
  RANGE:       { structure: 12, smc: 24, priceAction: 16, momentum: 10, volume: 14, derivatives: 12, mtf: 6,  context: 6 },
  VOL_SQUEEZE: { structure: 14, smc: 18, priceAction: 12, momentum: 12, volume: 18, derivatives: 12, mtf: 10, context: 4 },
  VOL_SHOCK:   { structure: 16, smc: 18, priceAction: 12, momentum: 8,  volume: 14, derivatives: 16, mtf: 10, context: 6 },
  TRANSITION:  { structure: 22, smc: 18, priceAction: 14, momentum: 10, volume: 12, derivatives: 10, mtf: 10, context: 4 },
};

export const DEFAULT_CONFIG = {
  minConfidence: 68,
  minIndependentLayers: 3,      // حداقل ۳ لایه مستقل باید موافق باشند
  maxConflictLayers: 2,         // اگر بیشتر از ۲ لایه قوی مخالف باشند -> NO TRADE
  feeRoundTripPct: 0.12,        // کارمزد رفت و برگشت (تیکر + میکر متوسط)
  slippagePct: 0.05,            // اسلیپیج محافظه‌کارانه پایه
  minNetRR1: 1.15,              // حداقل RR خالص تا TP1
  minNetRR2: 1.8,               // حداقل RR خالص تا TP2
  maxSpreadBps: 8,
  maxSlippage10kBps: 6,
  minAtrPct: 0.12,
  maxAtrPct: 3.2,
  maxCorrelatedOpen: 2,         // حداکثر ۲ معامله هم‌جهت روی ارزهای همبسته (>0.70)
  maxDailyLossR: 3.0,
  maxLossStreak: 3,
  maxOpenTrades: 3,
  maxDataAgeMs: 120000,
};

const clamp = (x, a = -1, b = 1) => Math.max(a, Math.min(b, Number.isFinite(x) ? x : 0));
const mean = (a) => (a.length ? a.reduce((t, x) => t + x, 0) / a.length : 0);

/* ---------- ۱. اندیکاتورهای پایه (دقیق و بدون NaN) ---------- */
export function ema(arr, p) {
  if (!arr.length) return [];
  const k = 2 / (p + 1);
  let e = arr[0];
  const out = [e];
  for (let i = 1; i < arr.length; i++) {
    e = arr[i] * k + e * (1 - k);
    out.push(e);
  }
  return out;
}

export function sma(arr, p) {
  if (arr.length < p) return null;
  let s = 0;
  for (let i = arr.length - p; i < arr.length; i++) s += arr[i];
  return s / p;
}

export function rsi(closes, p = 14) {
  if (closes.length < p + 1) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= p; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) g += d; else l -= d;
  }
  g /= p; l /= p;
  for (let i = p + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    g = (g * (p - 1) + Math.max(d, 0)) / p;
    l = (l * (p - 1) + Math.max(-d, 0)) / p;
  }
  if (g === 0 && l === 0) return 50;
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}

export function atrSeries(bars, p = 14) {
  if (bars.length < p + 1) return [];
  const out = new Array(bars.length).fill(null);
  let a = 0;
  for (let i = 1; i < bars.length; i++) {
    const tr = Math.max(
      bars[i].h - bars[i].l,
      Math.abs(bars[i].h - bars[i - 1].c),
      Math.abs(bars[i].l - bars[i - 1].c)
    );
    if (i < p) a += tr;
    else if (i === p) { a = (a + tr) / p; out[i] = a; }
    else { a = (a * (p - 1) + tr) / p; out[i] = a; }
  }
  return out;
}

export function macdHist(closes) {
  if (closes.length < 35) return [];
  const e12 = ema(closes, 12), e26 = ema(closes, 26);
  const m = e12.map((v, i) => v - e26[i]);
  const s = ema(m, 9);
  return m.map((v, i) => v - s[i]);
}

export function adxCalc(bars, p = 14) {
  if (bars.length < p * 2 + 2) return { adx: 0, pdi: 0, mdi: 0 };
  let trS = 0, pDmS = 0, mDmS = 0;
  const dxList = [];
  for (let i = 1; i < bars.length; i++) {
    const up = bars[i].h - bars[i - 1].h;
    const dn = bars[i - 1].l - bars[i].l;
    const pDm = up > dn && up > 0 ? up : 0;
    const mDm = dn > up && dn > 0 ? dn : 0;
    const tr = Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i - 1].c), Math.abs(bars[i].l - bars[i - 1].c));
    if (i <= p) { trS += tr; pDmS += pDm; mDmS += mDm; }
    else {
      trS = trS - trS / p + tr;
      pDmS = pDmS - pDmS / p + pDm;
      mDmS = mDmS - mDmS / p + mDm;
    }
    if (i >= p && trS > 0) {
      const pdi = (pDmS / trS) * 100, mdi = (mDmS / trS) * 100;
      const dx = pdi + mdi > 0 ? (Math.abs(pdi - mdi) / (pdi + mdi)) * 100 : 0;
      dxList.push({ dx, pdi, mdi });
    }
  }
  if (dxList.length < p) return { adx: 0, pdi: 0, mdi: 0 };
  let adx = mean(dxList.slice(0, p).map((x) => x.dx));
  for (let i = p; i < dxList.length; i++) adx = (adx * (p - 1) + dxList[i].dx) / p;
  const last = dxList[dxList.length - 1];
  return { adx, pdi: last.pdi, mdi: last.mdi };
}

export function bollingerWidth(closes, p = 20) {
  if (closes.length < p) return null;
  const w = closes.slice(-p), m = mean(w);
  if (!(m > 0)) return null;
  const sd = Math.sqrt(mean(w.map((x) => (x - m) ** 2)));
  return { mid: m, upper: m + 2 * sd, lower: m - 2 * sd, widthPct: ((4 * sd) / m) * 100 };
}

export function efficiencyRatio(closes, n = 20) {
  if (closes.length < n + 1) return 0;
  const start = closes.length - 1 - n;
  let vol = 0;
  for (let i = start + 1; i < closes.length; i++) vol += Math.abs(closes[i] - closes[i - 1]);
  return vol > 0 ? Math.abs(closes[closes.length - 1] - closes[start]) / vol : 0;
}

export function pearsonCorr(a, b, n = 48) {
  if (!a || !b || a.length < n + 1 || b.length < n + 1) return null;
  const ra = [], rb = [];
  for (let i = 0; i < n; i++) {
    const ia = a.length - n + i, ib = b.length - n + i;
    ra.push(Math.log(a[ia].c / a[ia - 1].c));
    rb.push(Math.log(b[ib].c / b[ib - 1].c));
  }
  const ma = mean(ra), mb = mean(rb);
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const xa = ra[i] - ma, xb = rb[i] - mb;
    num += xa * xb; da += xa * xa; db += xb * xb;
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
}

/* ---------- ۲. تشخیص رژیم بازار (۶ حالته) ---------- */
export function detectRegime(bars) {
  const closes = bars.map((x) => x.c);
  const atrs = atrSeries(bars, 14);
  const A = atrs[atrs.length - 1];
  const validAtrs = atrs.filter((x) => x != null);
  const avgAtr = validAtrs.length >= 20 ? mean(validAtrs.slice(-50)) : A;
  const volRatio = avgAtr > 0 ? A / avgAtr : 1;
  const { adx, pdi, mdi } = adxCalc(bars, 14);
  const er = efficiencyRatio(closes, 20);
  const bb = bollingerWidth(closes, 20);
  const bbHist = [];
  for (let i = Math.max(20, closes.length - 40); i <= closes.length; i++) {
    const b = bollingerWidth(closes.slice(0, i), 20);
    if (b) bbHist.push(b.widthPct);
  }
  const bbPctRank = bbHist.length ? bbHist.filter((x) => x <= (bb ? bb.widthPct : 0)).length / bbHist.length : 0.5;
  const e20 = ema(closes, 20), e50 = ema(closes, 50);
  const n = closes.length - 1;
  const slopeUp = e20[n] > e50[n] && e50[n] >= e50[Math.max(0, n - 5)];
  const slopeDn = e20[n] < e50[n] && e50[n] <= e50[Math.max(0, n - 5)];
  const lastBar = bars[n];
  const shockBar = A > 0 && (lastBar.h - lastBar.l) / A >= 2.8;

  let regime = 'RANGE';
  let riskMultiplier = 1.0;
  if (volRatio >= 1.85 || shockBar) {
    regime = 'VOL_SHOCK';
    riskMultiplier = 0.65;
  } else if (bbPctRank <= 0.15 && volRatio <= 0.78) {
    regime = 'VOL_SQUEEZE';
    riskMultiplier = 0.9;
  } else if (adx >= 23 && er >= 0.28 && slopeUp && pdi > mdi) {
    regime = 'TREND_UP';
    riskMultiplier = 1.0;
  } else if (adx >= 23 && er >= 0.28 && slopeDn && mdi > pdi) {
    regime = 'TREND_DOWN';
    riskMultiplier = 1.0;
  } else if (adx >= 18 && ((slopeUp && pdi < mdi) || (slopeDn && pdi > mdi))) {
    regime = 'TRANSITION';
    riskMultiplier = 0.8;
  }

  return {
    regime,
    adx, pdi, mdi, er, volRatio,
    atr: A,
    atrPct: closes[n] > 0 ? (A / closes[n]) * 100 : 0,
    bbWidthPct: bb ? bb.widthPct : null,
    bbPctRank,
    riskMultiplier,
  };
}

/* ---------- ۳. پیوت‌های غیرآینده‌نگر، ساختار بازار (BOS/CHoCH) و موج الیوت ساده ---------- */
export function findConfirmedPivots(bars, k = 3, atrVal = 0, minPromAtr = 0.6) {
  // پیوت در اندیس i فقط وقتی معتبر است که تا i+k بسته شده باشد (صفر Look-Ahead)
  const highs = [], lows = [];
  for (let i = k; i < bars.length - k; i++) {
    let isH = true, isL = true, minN = Infinity, maxN = -Infinity;
    for (let j = 1; j <= k; j++) {
      if (bars[i].h <= bars[i - j].h || bars[i].h <= bars[i + j].h) isH = false;
      if (bars[i].l >= bars[i - j].l || bars[i].l >= bars[i + j].l) isL = false;
      minN = Math.min(minN, bars[i - j].l, bars[i + j].l);
      maxN = Math.max(maxN, bars[i - j].h, bars[i + j].h);
    }
    if (isH && (atrVal <= 0 || bars[i].h - minN >= minPromAtr * atrVal)) highs.push({ i, t: bars[i].t, p: bars[i].h });
    if (isL && (atrVal <= 0 || maxN - bars[i].l >= minPromAtr * atrVal)) lows.push({ i, t: bars[i].t, p: bars[i].l });
  }
  return { highs, lows };
}

export function analyzeStructure(bars, A) {
  const { highs, lows } = findConfirmedPivots(bars.slice(-140), 3, A, 0.7);
  const last = bars[bars.length - 1];
  if (highs.length < 2 || lows.length < 2) {
    return { score: 0, bias: 0, bos: 0, choch: 0, fib: null, elliott: 0, highs, lows, notes: [] };
  }
  const h1 = highs[highs.length - 1], h2 = highs[highs.length - 2];
  const l1 = lows[lows.length - 1], l2 = lows[lows.length - 2];
  const hh = h1.p > h2.p, hl = l1.p > l2.p;
  const lh = h1.p < h2.p, ll = l1.p < l2.p;
  const bias = hh && hl ? 1 : lh && ll ? -1 : 0;
  const bos = last.c > h1.p ? 1 : last.c < l1.p ? -1 : 0;
  // CHoCH: شکست خلاف روند ساختاری قبلی
  const choch = (bias === -1 && last.c > h1.p) ? 1 : (bias === 1 && last.c < l1.p) ? -1 : 0;

  // ناحیه طلایی فیبوناچی (OTE 0.618 - 0.786) روی آخرین لگ معتبر
  let fibScore = 0, fibNote = null;
  const swingSpan = h1.p - l1.p;
  if (swingSpan > 1.5 * A) {
    if (h1.i > l1.i) {
      // لگ صعودی -> پولبک به 0.5 تا 0.786
      const ret = (h1.p - last.c) / swingSpan;
      if (ret >= 0.5 && ret <= 0.786) { fibScore = 0.45; fibNote = `پولبک به ناحیه طلایی فیبوناچی (${(ret * 100).toFixed(0)}٪)`; }
    } else {
      // لگ نزولی -> پولبک صعودی به 0.5 تا 0.786
      const ret = (last.c - l1.p) / swingSpan;
      if (ret >= 0.5 && ret <= 0.786) { fibScore = -0.45; fibNote = `پولبک به مقاومت فیبوناچی (${(ret * 100).toFixed(0)}٪)`; }
    }
  }

  // ارزیابی ساختار ایمپالس ۳ موجی (الیوت محافظه‌کارانه فقط هنگام اعتبار پیوت‌ها)
  let elliott = 0;
  if (highs.length >= 3 && lows.length >= 3) {
    const h0 = highs[highs.length - 3], l0 = lows[lows.length - 3];
    if (l1.p > l2.p && l2.p > l0.p && h1.p > h2.p && h2.p > h0.p && l1.p > h0.p) elliott = 0.25;
    else if (h1.p < h2.p && h2.p < h0.p && l1.p < l2.p && l2.p < l0.p && h1.p < l0.p) elliott = -0.25;
  }

  const notes = [];
  if (bias > 0) notes.push('ساختار صعودی (HH/HL)');
  else if (bias < 0) notes.push('ساختار نزولی (LH/LL)');
  if (bos > 0) notes.push('شکست ساختار صعودی (BOS ▲)');
  if (bos < 0) notes.push('شکست ساختار نزولی (BOS ▼)');
  if (choch > 0) notes.push('تغییر کاراکتر صعودی (CHoCH ▲)');
  if (choch < 0) notes.push('تغییر کاراکتر نزولی (CHoCH ▼)');
  if (fibNote) notes.push(fibNote);

  const score = clamp(bias * 0.45 + bos * 0.35 + choch * 0.3 + fibScore + elliott);
  return { score, bias, bos, choch, fibScore, elliott, highs, lows, lastHigh: h1.p, lastLow: l1.p, notes };
}

/* ---------- ۴. Smart Money Concepts (OB, FVG, Liquidity Sweep, S&D) ---------- */
export function analyzeSMC(bars, A, pivots) {
  const n = bars.length - 1, last = bars[n], prev = bars[n - 1];
  const notes = [];
  let obScore = 0, fvgScore = 0, sweepScore = 0;

  // الف) Fair Value Gaps (FVG) باز و پرنشده در ۴۰ کندل اخیر
  const bullFvg = [], bearFvg = [];
  for (let i = Math.max(2, n - 40); i <= n - 1; i++) {
    if (bars[i].l > bars[i - 2].h + 0.15 * A) {
      const gapLow = bars[i - 2].h, gapHigh = bars[i].l;
      const mitigated = bars.slice(i + 1).some((b) => b.l <= gapLow);
      if (!mitigated) bullFvg.push({ low: gapLow, high: gapHigh });
    }
    if (bars[i].h < bars[i - 2].l - 0.15 * A) {
      const gapLow = bars[i].h, gapHigh = bars[i - 2].l;
      const mitigated = bars.slice(i + 1).some((b) => b.h >= gapHigh);
      if (!mitigated) bearFvg.push({ low: gapLow, high: gapHigh });
    }
  }
  const inBullFvg = bullFvg.some((g) => last.l <= g.high && last.c >= g.low);
  const inBearFvg = bearFvg.some((g) => last.h >= g.low && last.c <= g.high);
  if (inBullFvg) { fvgScore += 0.4; notes.push('واکنش قیمت به Fair Value Gap صعودی'); }
  if (inBearFvg) { fvgScore -= 0.4; notes.push('واکنش قیمت به Fair Value Gap نزولی'); }

  // ب) Order Blocks / نواحی عرضه و تقاضا (آخرین کندل مخالف قبل از حرکت ایمپالس ≥ 1.6 ATR)
  const bullOB = [], bearOB = [];
  for (let i = Math.max(2, n - 50); i <= n - 2; i++) {
    const b = bars[i], next1 = bars[i + 1], next2 = bars[i + 2];
    const dispUp = Math.max(next1.c, next2.c) - b.h;
    const dispDn = b.l - Math.min(next1.c, next2.c);
    if (b.c < b.o && dispUp >= 1.6 * A) bullOB.push({ low: b.l, high: b.h });
    if (b.c > b.o && dispDn >= 1.6 * A) bearOB.push({ low: b.l, high: b.h });
  }
  const nearBullOB = bullOB.slice(-3).some((z) => last.l <= z.high + 0.25 * A && last.c >= z.low - 0.15 * A);
  const nearBearOB = bearOB.slice(-3).some((z) => last.h >= z.low - 0.25 * A && last.c <= z.high + 0.15 * A);
  if (nearBullOB) { obScore += 0.45; notes.push('برخورد به Order Block / ناحیه تقاضا'); }
  if (nearBearOB) { obScore -= 0.45; notes.push('برخورد به Order Block / ناحیه عرضه'); }

  // ج) Liquidity Sweep (جمع‌آوری نقدینگی سقف/کف قبلی با شدو و بازگشت داخل رنج)
  const recentHighs = pivots.highs.slice(-4).map((x) => x.p);
  const recentLows = pivots.lows.slice(-4).map((x) => x.p);
  const sweptLow = recentLows.some((lv) => (last.l < lv && last.c > lv) || (prev.l < lv && prev.c > lv && last.c > prev.c));
  const sweptHigh = recentHighs.some((lv) => (last.h > lv && last.c < lv) || (prev.h > lv && prev.c < lv && last.c < prev.c));
  if (sweptLow) { sweepScore += 0.55; notes.push('جمع‌آوری نقدینگی کف (Bullish Liquidity Sweep)'); }
  if (sweptHigh) { sweepScore -= 0.55; notes.push('جمع‌آوری نقدینگی سقف (Bearish Liquidity Sweep)'); }

  return {
    score: clamp(obScore + fvgScore + sweepScore),
    inBullFvg, inBearFvg, nearBullOB, nearBearOB, sweptLow, sweptHigh,
    bullOB, bearOB, notes,
  };
}

/* ---------- ۵. پرایس اکشن و الگوهای کندلی ---------- */
export function analyzePriceAction(bars, A) {
  const n = bars.length - 1, b = bars[n], p = bars[n - 1];
  const body = Math.abs(b.c - b.o), rng = Math.max(1e-9, b.h - b.l);
  const upWick = b.h - Math.max(b.o, b.c), dnWick = Math.min(b.o, b.c) - b.l;
  const pBody = Math.abs(p.c - p.o);
  const notes = [];
  let score = 0;

  // Bullish / Bearish Engulfing
  if (b.c > b.o && p.c < p.o && b.c >= p.o && b.o <= p.c && body >= 0.45 * A && body > pBody) {
    score += 0.55; notes.push('الگوی پوشای صعودی (Bullish Engulfing)');
  } else if (b.c < b.o && p.c > p.o && b.c <= p.o && b.o >= p.c && body >= 0.45 * A && body > pBody) {
    score -= 0.55; notes.push('الگوی پوشای نزولی (Bearish Engulfing)');
  }

  // Pin Bar / Wick Rejection
  if (dnWick >= 2.1 * Math.max(body, 0.1 * rng) && dnWick / rng >= 0.58 && rng >= 0.6 * A) {
    score += 0.45; notes.push('پین‌بار صعودی (پس‌زنی قوی کف)');
  } else if (upWick >= 2.1 * Math.max(body, 0.1 * rng) && upWick / rng >= 0.58 && rng >= 0.6 * A) {
    score -= 0.45; notes.push('پین‌بار نزولی (پس‌زنی قوی سقف)');
  }

  // موقعیت بسته شدن کندل در بدنه خودش (مومنتوم کلوز)
  const closePos = (b.c - b.l) / rng;
  score += (closePos - 0.5) * 0.4;

  return { score: clamp(score), notes };
}

/* ---------- ۶. مومنتوم، حجم/VWAP، مشتقات و چندتایم‌فریم ---------- */
export function analyzeMomentum(bars, A) {
  const c = bars.map((x) => x.c), n = c.length - 1;
  const r = rsi(c, 14), rPrev = rsi(c.slice(0, -1), 14);
  const mh = macdHist(c), h0 = mh[mh.length - 1], h1 = mh[mh.length - 2];
  const e9 = ema(c, 9)[n], e20 = ema(c, 20)[n], e50 = ema(c, 50)[n];
  const notes = [];
  let score = 0;

  if (e9 > e20 && e20 > e50) score += 0.35;
  else if (e9 < e20 && e20 < e50) score -= 0.35;

  if (Number.isFinite(h0) && Number.isFinite(h1)) {
    if (h0 > 0 && h0 > h1) { score += 0.35; notes.push('MACD صعودی و در حال تقویت'); }
    else if (h0 < 0 && h0 < h1) { score -= 0.35; notes.push('MACD نزولی و در حال تشدید'); }
    else score += h0 > 0 ? 0.12 : -0.12;
  }

  if (Number.isFinite(r)) {
    if (r >= 45 && r <= 65 && rPrev != null && r > rPrev) { score += 0.25; notes.push(`RSI در فاز مومنتوم صعودی (${r.toFixed(0)})`); }
    else if (r >= 35 && r <= 55 && rPrev != null && r < rPrev) { score -= 0.25; notes.push(`RSI در فاز مومنتوم نزولی (${r.toFixed(0)})`); }
    else if (r > 76) { score -= 0.4; notes.push(`هشدار اشباع خرید RSI (${r.toFixed(0)})`); }
    else if (r < 24) { score += 0.4; notes.push(`هشدار اشباع فروش RSI (${r.toFixed(0)})`); }
  }

  const distE20 = A > 0 ? (c[n] - e20) / A : 0;
  return { score: clamp(score), rsi: r, macd: h0, e9, e20, e50, distE20, notes };
}

export function analyzeVolumeAndFlow(bars, A, orderbook) {
  const n = bars.length - 1, last = bars[n];
  const notes = [];
  let score = 0;

  // VWAP روزانه
  const dayStart = Math.floor(last.t / 864e5) * 864e5;
  const dayBars = bars.filter((x) => x.t >= dayStart);
  const useBars = dayBars.length >= 6 ? dayBars : bars.slice(-24);
  const pv = useBars.reduce((t, x) => t + ((x.h + x.l + x.c) / 3) * x.v, 0);
  const vv = useBars.reduce((t, x) => t + x.v, 0);
  const vwap = vv > 0 ? pv / vv : last.c;
  const vwapDist = A > 0 ? (last.c - vwap) / A : 0;
  score += clamp(vwapDist * 0.22, -0.3, 0.3);
  if (vwapDist > 0.2) notes.push('قیمت بالای VWAP روزانه');
  else if (vwapDist < -0.2) notes.push('قیمت پایین VWAP روزانه');

  // حجم نسبی
  const vAvg = mean(bars.slice(-21, -1).map((x) => x.v));
  const volRatio = vAvg > 0 ? last.v / vAvg : 1;
  const barDir = last.c >= last.o ? 1 : -1;
  if (volRatio >= 1.35) {
    score += barDir * 0.3;
    notes.push(`تأیید حجم (${volRatio.toFixed(1)}× میانگین ۲۰ کندل)`);
  }

  // Taker Buy/Sell Delta (اگر فیلد tb موجود باشد)
  const w8 = bars.slice(-8);
  let takerDelta = null;
  if (w8.every((x) => Number.isFinite(x.tb))) {
    const sumV = w8.reduce((t, x) => t + x.v, 0);
    if (sumV > 0) {
      takerDelta = w8.reduce((t, x) => t + (2 * x.tb - x.v), 0) / sumV;
      score += clamp(takerDelta / 0.22, -0.45, 0.45);
      if (Math.abs(takerDelta) >= 0.08) {
        notes.push(`جریان سفارش اجراشده (Taker Delta): ${(takerDelta * 100).toFixed(1)}٪`);
      }
    }
  }

  // Order Book Imbalance (در صورت وجود عمق معتبر)
  let obImb = null;
  if (orderbook && Array.isArray(orderbook.bids) && Array.isArray(orderbook.asks) && orderbook.bids.length && orderbook.asks.length) {
    const B = orderbook.bids.slice(0, 15).reduce((t, x) => t + x[0] * x[1], 0);
    const Ask = orderbook.asks.slice(0, 15).reduce((t, x) => t + x[0] * x[1], 0);
    if (B + Ask > 0) {
      obImb = (B - Ask) / (B + Ask);
      score += clamp(obImb * 0.5, -0.25, 0.25);
    }
  }

  return { score: clamp(score), vwap, volRatio, takerDelta, obImb, notes };
}

export function analyzeDerivatives(deriv, priceChangePct = 0) {
  if (!deriv) return { score: 0, available: false, notes: ['داده مشتقات در دسترس نیست (وزن صفر در نظر گرفته شد)'] };
  const notes = [];
  let score = 0, used = 0;

  if (Number.isFinite(deriv.fundingRatePct)) {
    used++;
    const fr = deriv.fundingRatePct;
    if (fr > 0.05) { score -= 0.4; notes.push(`فاندینگ بالا (${fr.toFixed(4)}٪) — ریسک ازدحام لانگ`); }
    else if (fr < -0.015) { score += 0.4; notes.push(`فاندینگ منفی (${fr.toFixed(4)}٪) — پتانسیل شورت اسکوئیز`); }
  }
  if (Number.isFinite(deriv.oiChangePct)) {
    used++;
    const oc = deriv.oiChangePct;
    if (oc > 2.5 && priceChangePct > 0.3) { score += 0.35; notes.push(`افزایش OI (+${oc.toFixed(1)}٪) هم‌زمان با رشد قیمت`); }
    else if (oc > 2.5 && priceChangePct < -0.3) { score -= 0.35; notes.push(`افزایش OI (+${oc.toFixed(1)}٪) هم‌زمان با ریزش قیمت`); }
    else if (oc < -3.0) { notes.push(`کاهش OI (${oc.toFixed(1)}٪) — خروج موقعیت‌های باز`); }
  }
  if (Number.isFinite(deriv.longShortRatio)) {
    used++;
    const lr = deriv.longShortRatio;
    if (lr > 2.1) { score -= 0.25; notes.push(`نسبت لانگ/شورت شلوغ (${lr.toFixed(2)})`); }
    else if (lr < 0.75) { score += 0.25; notes.push(`نسبت لانگ/شورت پایین (${lr.toFixed(2)})`); }
  }
  if (Number.isFinite(deriv.liqLongUsd) && Number.isFinite(deriv.liqShortUsd)) {
    const tot = deriv.liqLongUsd + deriv.liqShortUsd;
    if (tot >= 50000) {
      used++;
      const im = (deriv.liqShortUsd - deriv.liqLongUsd) / tot;
      score += clamp(im * 0.4, -0.35, 0.35);
      notes.push(`عدم‌توازن لیکوئیدیشن: ${(im * 100).toFixed(0)}٪`);
    }
  }
  return { score: clamp(score), available: used > 0, notes };
}

export function analyzeMTF(timeframesMap, primaryTf) {
  // پشتیبانی کامل از 1m, 5m, 15m, 30m, 1h, 4h, 1d, 1w
  const order = ['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w'];
  const pIdx = Math.max(0, order.indexOf(primaryTf));
  const biases = {};
  let wSum = 0, sSum = 0, higherAligned = 0, higherConflict = 0;

  for (let idx = 0; idx < order.length; idx++) {
    const tf = order[idx], arr = timeframesMap && timeframesMap[tf];
    if (!Array.isArray(arr) || arr.length < 55) continue;
    const c = arr.map((x) => x.c), n = c.length - 1;
    const e20 = ema(c, 20)[n], e50 = ema(c, 50)[n], e50p = ema(c, 50)[n - 5];
    const flags = [e20 > e50 ? 1 : -1, c[n] > e50 ? 1 : -1, e50 > e50p ? 1 : -1];
    if (c.length >= 200) flags.push(c[n] > ema(c, 200)[n] ? 1 : -1);
    const b = mean(flags);
    biases[tf] = b;

    const isHigher = idx > pIdx;
    const w = isHigher ? (idx - pIdx <= 2 ? 2.0 : 1.3) : (idx === pIdx ? 1.0 : 0.5);
    wSum += w;
    sSum += w * b;
  }

  const agg = wSum > 0 ? sSum / wSum : 0;
  const dir = agg >= 0 ? 1 : -1;
  Object.entries(biases).forEach(([tf, b]) => {
    if (order.indexOf(tf) > pIdx) {
      if (b * dir >= 0.45) higherAligned++;
      else if (b * dir <= -0.45) higherConflict++;
    }
  });

  // جریمه تعارض تایم‌فریم‌های بالاتر
  const penalty = higherConflict > 0 ? Math.min(0.5, higherConflict * 0.25) : 0;
  const finalScore = clamp(agg - Math.sign(agg) * penalty);
  return { score: finalScore, biases, higherAligned, higherConflict };
}

/* ---------- ۷. ارزیابی نهایی یک نماد (خروجی کامل و قابل ردیابی) ---------- */
export function evaluateMarket(input, customWeights = null, customCfg = null, calibrationLookup = null) {
  const cfg = { ...DEFAULT_CONFIG, ...(customCfg || {}) };
  const {
    symbol,
    primaryTf = '15m',
    timeframes = {},        // { '1m': [...], '5m': [...], '15m': [...], '1h': [...], '4h': [...], '1d': [...], ... }
    livePrice = null,
    orderbook = null,
    derivatives = null,
    btcBars = null,         // کندل‌های هم‌تایم BTCUSDT برای محاسبه همبستگی و بایاس
    sentiment = null,       // { fearGreed: 0..100, usdtDomCtx: -1..1 }
    riskContext = null,     // { accountEquity, riskPct, openTrades: [{symbol, side, corrWithBtc}], dailyLossR, lossStreak }
    nowTs = Date.now(),
  } = input;

  const bars = timeframes[primaryTf];
  const makeNoTrade = (reason, extra = {}) => ({
    symbol,
    timeframe: primaryTf,
    signal: 'NO_TRADE',
    timestamp: nowTs,
    regime: extra.regime || 'UNKNOWN',
    confidenceScore: extra.confidenceScore || 0,
    calibratedProb: null,
    signalStrength: 'NONE',
    entry: livePrice || (bars && bars.length ? bars[bars.length - 1].c : null),
    entryZone: null,
    stopLoss: null,
    tp1: null, tp2: null, tp3: null,
    rr: null,
    positionSize: null,
    ttlMinutes: null,
    reasonsFor: extra.reasonsFor || [],
    reasonsAgainst: [reason, ...(extra.reasonsAgainst || [])],
    invalidationConditions: [],
    featureVector: extra.featureVector || null,
    gates: extra.gates || [{ name: 'Data Integrity', ok: false, detail: reason }],
  });

  // گیت ۰: اعتبارسنجی داده و تازگی
  if (!Array.isArray(bars) || bars.length < 80) return makeNoTrade('تعداد کندل‌های تایم‌فریم اصلی کافی نیست (<80)');
  const lastBar = bars[bars.length - 1];
  const price = Number.isFinite(livePrice) && livePrice > 0 ? livePrice : lastBar.c;
  if (!(price > 0) || bars.slice(-20).some((x) => ![x.o, x.h, x.l, x.c, x.v].every(Number.isFinite) || x.h < x.l || x.c <= 0)) {
    return makeNoTrade('داده کندل نامعتبر یا دارای NaN است');
  }
  const tfDur = TF_MS[primaryTf] || 900e3;
  if (nowTs - (lastBar.t + tfDur) > Math.max(cfg.maxDataAgeMs, tfDur * 2)) {
    return makeNoTrade('داده بازار کهنه است — معامله در داده غیرزنده ممنوع');
  }

  // ۱. تشخیص رژیم بازار
  const reg = detectRegime(bars);
  const A = reg.atr;
  if (!(A > 0)) return makeNoTrade('محاسبه ATR نامعتبر است', { regime: reg.regime });

  // ۲. اجرای هم‌زمان لایه‌های تحلیلی
  const struct = analyzeStructure(bars, A);
  const smc = analyzeSMC(bars, A, struct);
  const pa = analyzePriceAction(bars, A);
  const mom = analyzeMomentum(bars, A);
  const vol = analyzeVolumeAndFlow(bars, A, orderbook);
  const chg24 = bars.length >= 24 ? ((price / bars[bars.length - 24].c) - 1) * 100 : 0;
  const deriv = analyzeDerivatives(derivatives, chg24);
  const mtf = analyzeMTF(timeframes, primaryTf);

  // لایه زمینه: همبستگی و روند بیت‌کوین + سنتیمنت بازار
  let ctxScore = 0;
  const ctxNotes = [];
  let btcCorr = null;
  if (symbol !== 'BTCUSDT' && Array.isArray(btcBars) && btcBars.length >= 60) {
    btcCorr = pearsonCorr(bars, btcBars, 48);
    const btcReg = detectRegime(btcBars);
    const btcDir = btcReg.regime === 'TREND_UP' ? 1 : btcReg.regime === 'TREND_DOWN' ? -1 : 0;
    if (btcCorr != null && btcCorr > 0.5 && btcDir !== 0) {
      ctxScore += btcDir * 0.55;
      ctxNotes.push(`همبستگی ${(btcCorr * 100).toFixed(0)}٪ با BTC (${btcDir > 0 ? 'صعودی' : 'نزولی'})`);
    }
  }
  if (sentiment && Number.isFinite(sentiment.fearGreed)) {
    const fg = sentiment.fearGreed;
    if (fg <= 20) { ctxScore += 0.25; ctxNotes.push(`ترس شدید بازار (${fg})`); }
    else if (fg >= 82) { ctxScore -= 0.25; ctxNotes.push(`طمع شدید بازار (${fg})`); }
  }
  if (sentiment && Number.isFinite(sentiment.usdtDomCtx)) ctxScore += sentiment.usdtDomCtx * 0.2;
  ctxScore = clamp(ctxScore);

  const layerScores = {
    structure: struct.score,
    smc: smc.score,
    priceAction: pa.score,
    momentum: mom.score,
    volume: vol.score,
    derivatives: deriv.available ? deriv.score : 0,
    mtf: mtf.score,
    context: ctxScore,
  };

  // ۳. وزن‌دهی پویا بر اساس رژیم تشخیص‌داده‌شده
  const regimeWeights = (customWeights && customWeights[reg.regime]) || DEFAULT_REGIME_WEIGHTS[reg.regime] || DEFAULT_REGIME_WEIGHTS.RANGE;
  let wTotal = 0, weightedSum = 0;
  for (const k of LAYERS) {
    if (k === 'derivatives' && !deriv.available) continue; // داده ناموجود وزن صفر می‌گیرد
    const w = Number(regimeWeights[k]) || 0;
    wTotal += w;
    weightedSum += w * layerScores[k];
  }
  const netBias = wTotal > 0 ? weightedSum / wTotal : 0; // -1 .. +1
  const dir = netBias >= 0 ? 1 : -1;

  // هم‌جهتی و تضاد لایه‌ها
  const alignedLayers = [], conflictLayers = [];
  for (const k of LAYERS) {
    if (k === 'derivatives' && !deriv.available) continue;
    const v = layerScores[k] * dir;
    if (v >= 0.22) alignedLayers.push(k);
    else if (v <= -0.25) conflictLayers.push(k);
  }

  // تبدیل نمره خام به امتیاز اطمینان ۰..۱۰۰ با تعدیل تعارض و رژیم
  const rawScore = Math.abs(netBias) * 100;
  const conflictPenalty = conflictLayers.length * 8 + mtf.higherConflict * 7;
  const regimeBoost = (reg.regime === 'TREND_UP' && dir > 0) || (reg.regime === 'TREND_DOWN' && dir < 0) ? 10 : reg.regime === 'VOL_SHOCK' ? -10 : 0;
  const confidenceScore = Math.round(clamp(rawScore * 1.35 + regimeBoost - conflictPenalty, 0, 100));

  // جمع‌آوری دلایل موافق و مخالف
  const allNotes = [
    ...struct.notes, ...smc.notes, ...pa.notes,
    ...mom.notes, ...vol.notes, ...deriv.notes, ...ctxNotes,
  ];
  const reasonsFor = allNotes.filter((t) =>
    dir > 0 ? !/نزولی|عرضه|سقف|فروش|اشباع خرید|ازدحام لانگ/.test(t) : !/صعودی|تقاضا|کف|اشباع فروش|شورت اسکوئیز/.test(t)
  );
  const reasonsAgainst = allNotes.filter((t) => !reasonsFor.includes(t));
  if (mtf.higherConflict > 0) reasonsAgainst.push(`تعارض با ${mtf.higherConflict} تایم‌فریم بالاتر`);
  if (reg.regime === 'VOL_SHOCK') reasonsAgainst.push('نوسان غیرعادی بازار (VOL_SHOCK)');

  // ۴. تعیین ساختاریافته سطوح ورود، حد ضرر و TP1/TP2/TP3
  const recent12 = bars.slice(-12);
  const swingSL = dir > 0 ? Math.min(...recent12.map((x) => x.l)) : Math.max(...recent12.map((x) => x.h));
  let risk = dir > 0 ? price - (swingSL - 0.25 * A) : (swingSL + 0.25 * A) - price;
  risk = Math.max(risk, 1.15 * A);
  const slTooFar = risk > 2.8 * A;
  if (slTooFar) risk = 2.8 * A;

  const stopLoss = price - dir * risk;
  const entryZone = dir > 0
    ? { low: price - 0.2 * A, high: price + 0.25 * A }
    : { low: price - 0.25 * A, high: price + 0.2 * A };

  // بررسی فاصله تا نزدیک‌ترین مقاومت/حمایت ساختاری
  const levels = dir > 0
    ? struct.highs.map((x) => x.p).filter((p) => p > price * 1.001)
    : struct.lows.map((x) => x.p).filter((p) => p < price * 0.999);
  const nearestOpp = levels.length ? (dir > 0 ? Math.min(...levels) : Math.max(...levels)) : null;
  const room = nearestOpp != null ? Math.abs(nearestOpp - price) : Infinity;

  let tp1 = price + dir * 1.5 * risk;
  if (room >= 1.2 * risk && room < 1.5 * risk) tp1 = price + dir * (room - 0.15 * A);
  const tp2 = price + dir * 2.5 * risk;
  const tp3 = price + dir * 3.8 * risk;

  const totalCost = price * ((cfg.feeRoundTripPct + cfg.slippagePct) / 100);
  const rr1 = (Math.abs(tp1 - price) - totalCost) / (risk + totalCost);
  const rr2 = (Math.abs(tp2 - price) - totalCost) / (risk + totalCost);
  const rr3 = (Math.abs(tp3 - price) - totalCost) / (risk + totalCost);

  // ۵. گیت‌های سخت‌گیرانه مدیریت ریسک (Hard Risk Gates)
  const gates = [];
  const addGate = (name, ok, detail) => gates.push({ name, ok: !!ok, detail });

  addGate('امتیاز اطمینان کافی', confidenceScore >= cfg.minConfidence, `${confidenceScore} / ${cfg.minConfidence}`);
  addGate('تأیید چندلایه مستقل', alignedLayers.length >= cfg.minIndependentLayers, `${alignedLayers.length} لایه (${alignedLayers.join(', ')})`);
  addGate('عدم تعارض شدید لایه‌ها', conflictLayers.length <= cfg.maxConflictLayers, `${conflictLayers.length} لایه مخالف`);
  addGate('هم‌سویی تایم‌فریم بالاتر', mtf.higherConflict === 0, mtf.higherConflict ? `${mtf.higherConflict} تعارض` : 'هم‌جهت');
  addGate('بازه نوسان مجاز (ATR)', reg.atrPct >= cfg.minAtrPct && reg.atrPct <= cfg.maxAtrPct, `${reg.atrPct.toFixed(2)}%`);
  addGate('عدم پرش قیمتی از EMA20', Math.abs(mom.distE20) <= 2.4, `${mom.distE20.toFixed(2)} ATR`);
  addGate('فاصله منطقی حد ضرر', !slTooFar, `${(risk / A).toFixed(2)} ATR`);
  addGate('فضا تا مانع پیش‌رو', room >= 1.2 * risk, Number.isFinite(room) ? `${(room / risk).toFixed(2)}R` : 'باز');
  addGate('نسبت RR خالص پس از کارمزد و اسلیپیج', rr1 >= cfg.minNetRR1 && rr2 >= cfg.minNetRR2, `TP1=${rr1.toFixed(2)} | TP2=${rr2.toFixed(2)}`);

  // گیت عمق بازار و اسپرد (در صورت وجود دفتر سفارش)
  if (orderbook && orderbook.bids && orderbook.asks && orderbook.bids.length && orderbook.asks.length) {
    const bid = orderbook.bids[0][0], ask = orderbook.asks[0][0], mid = (bid + ask) / 2;
    const spreadBps = ((ask - bid) / mid) * 1e4;
    addGate('اسپرد و نقدشوندگی بازار', spreadBps <= cfg.maxSpreadBps, `${spreadBps.toFixed(2)} bps`);
  }

  // گیت‌های ریسک پرتفوی (زیان روزانه، ضرر پیاپی، کنترل همبستگی)
  let positionSize = null;
  if (riskContext) {
    const dailyOk = !(riskContext.dailyLossR <= -cfg.maxDailyLossR);
    const streakOk = !(riskContext.lossStreak >= cfg.maxLossStreak);
    const openTrades = Array.isArray(riskContext.openTrades) ? riskContext.openTrades : [];
    const openOk = openTrades.length < cfg.maxOpenTrades;
    const sameDirCorr = openTrades.filter((t) => t.side === dir && (t.symbol === symbol || (t.corrWithBtc || 0.75) >= 0.7)).length;
    const corrOk = sameDirCorr < cfg.maxCorrelatedOpen;
    addGate('سقف زیان روزانه', dailyOk, `${(riskContext.dailyLossR || 0).toFixed(2)}R`);
    addGate('محدودیت ضرر پیاپی', streakOk, `${riskContext.lossStreak || 0}`);
    addGate('سقف معاملات هم‌زمان', openOk, `${openTrades.length}/${cfg.maxOpenTrades}`);
    addGate('کنترل همبستگی معاملات هم‌جهت', corrOk, `${sameDirCorr} همبسته`);

    if (riskContext.accountEquity > 0 && riskContext.riskPct > 0) {
      const effectiveRiskPct = riskContext.riskPct * reg.riskMultiplier;
      const riskUsd = riskContext.accountEquity * (effectiveRiskPct / 100);
      const qty = riskUsd / (risk + totalCost);
      positionSize = {
        riskPctApplied: Number(effectiveRiskPct.toFixed(2)),
        riskUsd: Number(riskUsd.toFixed(2)),
        quantity: Number(qty.toPrecision(5)),
        notionalUsd: Number((qty * price).toFixed(2)),
      };
    }
  }

  const failedGates = gates.filter((g) => !g.ok);
  const featureVector = {
    regime: reg.regime,
    adx: Number(reg.adx.toFixed(2)),
    er: Number(reg.er.toFixed(3)),
    atrPct: Number(reg.atrPct.toFixed(3)),
    btcCorr: btcCorr != null ? Number(btcCorr.toFixed(2)) : null,
    layers: Object.fromEntries(LAYERS.map((k) => [k, Number((layerScores[k] * dir).toFixed(3))])),
  };

  if (failedGates.length > 0) {
    return makeNoTrade(
      `رد شده در ${failedGates.length} گیت: ${failedGates.map((g) => g.name).join('، ')}`,
      { regime: reg.regime, confidenceScore, reasonsFor, reasonsAgainst, featureVector, gates }
    );
  }

  // کالیبراسیون احتمال برد واقعی از داده‌های تاریخی (امتیاز هرگز جایگزین احتمال نمی‌شود)
  const calibrated = calibrationLookup ? calibrationLookup(reg.regime, confidenceScore) : null;
  const ttlMinutes = Math.round((tfDur / 60e3) * 16); // حدود ۱۶ کندل تایم‌فریم مبنا
  const signalStrength = confidenceScore >= 84 ? 'VERY_STRONG' : confidenceScore >= 75 ? 'STRONG' : 'MODERATE';

  const invalidationConditions = [
    `بسته شدن کندل ${primaryTf} ${dir > 0 ? 'زیر' : 'بالای'} ${stopLoss.toPrecision(6)}`,
    `تغییر ساختار (CHoCH) خلاف جهت در تایم‌فریم ${primaryTf}`,
    symbol !== 'BTCUSDT' ? 'ریزش یا شکست ساختاری ناگهانی BTCUSDT خلاف جهت معامله' : 'افزایش ناگهانی نوسان (VOL_SHOCK) خلاف جهت',
    `عدم ورود در محدوده مجاز (${entryZone.low.toPrecision(6)} – ${entryZone.high.toPrecision(6)}) تا ${ttlMinutes} دقیقه`,
  ];

  return {
    symbol,
    timeframe: primaryTf,
    signal: dir > 0 ? 'LONG' : 'SHORT',
    timestamp: nowTs,
    regime: reg.regime,
    confidenceScore,
    calibratedProb: calibrated ? { prob: calibrated.prob, ciLow: calibrated.ciLow, ciHigh: calibrated.ciHigh, n: calibrated.n } : null,
    signalStrength,
    entry: price,
    entryZone,
    stopLoss,
    tp1, tp2, tp3,
    rr: { tp1: Number(rr1.toFixed(2)), tp2: Number(rr2.toFixed(2)), tp3: Number(rr3.toFixed(2)) },
    positionSize,
    ttlMinutes,
    reasonsFor: reasonsFor.slice(0, 6),
    reasonsAgainst: reasonsAgainst.slice(0, 4),
    invalidationConditions,
    featureVector,
    gates,
  };
}