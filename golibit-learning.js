// ============================================================
// GoliBit Self-Learning & Walk-Forward Evaluation Engine (v13)
// کنترل Overfitting | Shrinkage | Rollback نسخه‌ها | کالیبراسیون ویلسون | Walk-Forward
// ============================================================
import { LAYERS, DEFAULT_REGIME_WEIGHTS, TF_MS, evaluateMarket } from './golibit-engine.js';

export const LEARN_CFG = {
  minSamplesPerRegime: 40,      // حداقل ۴۰ معامله بسته‌شده در هر رژیم قبل از تغییر وزن
  oosSplitRatio: 0.30,          // ۳۰٪ جدیدترین معاملات فقط برای اعتبارسنجی Out-of-Sample
  maxStepChangePct: 0.15,       // سقف تغییر هر وزن در یک چرخه (±۱۵٪)
  minWeight: 4,                 // هیچ لایه معتبری کاملاً صفر نمی‌شود
  maxWeight: 32,                // جلوگیری از غلبه افراطی یک لایه
  decayHalfLifeTrades: 60,      // وزن‌دهی نمایی به معاملات متعادل‌تر (نه فقط ۵ معامله اخیر)
  degradeWindow: 25,            // پنجره تشخیص افت عملکرد مدل فعال
  degradeMaxDD: 5.5,            // افت بیش از ۵.۵R باعث هشدار افت مدل و Rollback می‌شود
  degradeMinExpectancy: -0.15,  // Expectancy زیر -0.15R در ۲۵ معامله اخیر
};

export function wilsonCI(wins, n, z = 1.96) {
  if (!n) return { prob: 0, ciLow: 0, ciHigh: 0 };
  const p = wins / n;
  const denom = 1 + (z * z) / n;
  const center = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return {
    prob: Number(p.toFixed(4)),
    ciLow: Number(Math.max(0, (center - margin) / denom).toFixed(4)),
    ciHigh: Number(Math.min(1, (center + margin) / denom).toFixed(4)),
  };
}

/* ---------- ۱. محاسبه کامل شاخص‌های عملکرد حرفه‌ای ---------- */
export function computeMetrics(trades) {
  const n = trades.length;
  if (!n) {
    return {
      n: 0, wins: 0, losses: 0, winRate: 0, profitFactor: 0, netR: 0,
      maxDrawdownR: 0, expectancyR: 0, avgR: 0, sharpe: 0, sortino: 0,
    };
  }
  const rs = trades.map((t) => Number(t.realized_r ?? t.R ?? 0));
  const wins = rs.filter((r) => r > 0).length;
  const losses = rs.filter((r) => r < 0).length;
  const grossProfit = rs.filter((r) => r > 0).reduce((s, x) => s + x, 0);
  const grossLoss = Math.abs(rs.filter((r) => r < 0).reduce((s, x) => s + x, 0));
  const netR = rs.reduce((s, x) => s + x, 0);
  const avgR = netR / n;

  // Max Drawdown (به واحد R)
  let eq = 0, peak = 0, maxDD = 0;
  for (const r of rs) {
    eq += r;
    if (eq > peak) peak = eq;
    if (peak - eq > maxDD) maxDD = peak - eq;
  }

  // Sharpe & Sortino (بر پایه توزیع R معاملات)
  const variance = rs.reduce((s, x) => s + (x - avgR) ** 2, 0) / Math.max(1, n - 1);
  const std = Math.sqrt(variance);
  const downRs = rs.filter((r) => r < 0);
  const downVar = downRs.length ? downRs.reduce((s, x) => s + x * x, 0) / downRs.length : 0;
  const downStd = Math.sqrt(downVar);

  const sharpe = std > 0 ? (avgR / std) * Math.sqrt(n) : 0;
  const sortino = downStd > 0 ? (avgR / downStd) * Math.sqrt(n) : 0;

  return {
    n,
    wins,
    losses,
    winRate: Number(((wins / n) * 100).toFixed(2)),
    profitFactor: grossLoss > 0 ? Number((grossProfit / grossLoss).toFixed(2)) : (grossProfit > 0 ? 99 : 0),
    netR: Number(netR.toFixed(2)),
    maxDrawdownR: Number(maxDD.toFixed(2)),
    expectancyR: Number(avgR.toFixed(3)),
    avgR: Number(avgR.toFixed(3)),
    sharpe: Number(sharpe.toFixed(2)),
    sortino: Number(sortino.toFixed(2)),
  };
}

/* ---------- ۲. کالیبراسیون احتمال برد واقعی از داده‌های تاریخی ---------- */
export function buildCalibrationTable(closedSignals) {
  const bins = [[60, 70], [70, 80], [80, 90], [90, 101]];
  const map = {};
  for (const s of closedSignals) {
    const score = Number(s.confidence_score);
    const bin = bins.find(([lo, hi]) => score >= lo && score < hi);
    if (!bin) continue;
    const key = `${s.regime}:${bin[0]}-${bin[1]}`;
    if (!map[key]) map[key] = { regime: s.regime, lo: bin[0], hi: bin[1], n: 0, w: 0, sumR: 0 };
    map[key].n++;
    if ((s.realized_r || 0) > 0) map[key].w++;
    map[key].sumR += Number(s.realized_r || 0);
  }
  const result = {};
  for (const [key, b] of Object.entries(map)) {
    const ci = wilsonCI(b.w, b.n);
    result[key] = {
      regime: b.regime, scoreLow: b.lo, scoreHigh: b.hi,
      n: b.n, wins: b.w, ...ci,
      avgR: Number((b.sumR / b.n).toFixed(3)),
      reliable: b.n >= 30,
    };
  }
  return result;
}

/* ---------- ۳. بهینه‌ساز تطبیقی وزن‌ها (با Out-of-Sample و کنترل Overfitting) ---------- */
export function proposeWeightUpdate(currentWeights, closedSignals) {
  const byRegime = {};
  for (const s of closedSignals) {
    if (!s.features_json || !Number.isFinite(s.realized_r)) continue;
    const fv = typeof s.features_json === 'string' ? JSON.parse(s.features_json) : s.features_json;
    if (!fv || !fv.layers) continue;
    if (!byRegime[s.regime]) byRegime[s.regime] = [];
    byRegime[s.regime].push({ ...s, layers: fv.layers });
  }

  const nextWeights = JSON.parse(JSON.stringify(currentWeights || DEFAULT_REGIME_WEIGHTS));
  const report = {};

  for (const [regime, list] of Object.entries(byRegime)) {
    list.sort((a, b) => (a.close_at || a.created_at) - (b.close_at || b.created_at));
    if (list.length < LEARN_CFG.minSamplesPerRegime) {
      report[regime] = { updated: false, reason: `نمونه کافی نیست (${list.length}/${LEARN_CFG.minSamplesPerRegime})` };
      continue;
    }

    // تقسیم زمانی In-Sample (۷۰٪) و Out-of-Sample (۳۰٪) بدون نشت آینده
    const splitIdx = Math.floor(list.length * (1 - LEARN_CFG.oosSplitRatio));
    const trainSet = list.slice(0, splitIdx);
    const oosSet = list.slice(splitIdx);

    const baseW = { ...(nextWeights[regime] || DEFAULT_REGIME_WEIGHTS[regime]) };
    const candidateW = { ...baseW };
    const decayLambda = Math.LN2 / LEARN_CFG.decayHalfLifeTrades;

    // محاسبه همبستگی عملکردی هر لایه با R واقعی روی Train Set با وزن‌دهی نمایی
    const layerPerf = {};
    for (const layer of LAYERS) {
      let num = 0, den = 0;
      for (let i = 0; i < trainSet.length; i++) {
        const age = trainSet.length - 1 - i;
        const tw = Math.exp(-decayLambda * age);
        const lv = Number(trainSet[i].layers[layer] || 0);
        const r = Number(trainSet[i].realized_r || 0);
        if (Math.abs(lv) < 0.05) continue;
        num += tw * lv * r;
        den += tw * Math.abs(lv);
      }
      layerPerf[layer] = den > 3 ? num / den : 0; // میانگین R تعدیل‌شده برای این لایه
    }

    // Shrinkage ملایم با سقف ±۱۵٪ در هر چرخه
    for (const layer of LAYERS) {
      const edge = Math.max(-0.5, Math.min(0.5, layerPerf[layer]));
      const factor = 1 + edge * (LEARN_CFG.maxStepChangePct / 0.5);
      candidateW[layer] = Math.max(LEARN_CFG.minWeight, Math.min(LEARN_CFG.maxWeight, baseW[layer] * factor));
    }
    // نرمال‌سازی مجموع وزن‌ها به ۱۰۰
    const sumW = LAYERS.reduce((t, k) => t + candidateW[k], 0);
    for (const layer of LAYERS) candidateW[layer] = Number(((candidateW[layer] / sumW) * 100).toFixed(2));

    // اعتبارسنجی Out-of-Sample: مقایسه کیفیت مرتب‌سازی (Rank Expectancy) وزن قدیم vs وزن جدید
    const scoreWith = (wMap, item) => LAYERS.reduce((t, k) => t + (wMap[k] || 0) * (item.layers[k] || 0), 0);
    const evalOOS = (wMap) => {
      const ranked = [...oosSet].sort((a, b) => scoreWith(wMap, b) - scoreWith(wMap, a));
      const topHalf = ranked.slice(0, Math.max(5, Math.floor(ranked.length * 0.5)));
      return computeMetrics(topHalf);
    };

    const oldOOS = evalOOS(baseW);
    const newOOS = evalOOS(candidateW);
    const improved = newOOS.expectancyR > oldOOS.expectancyR + 0.03 && newOOS.maxDrawdownR <= oldOOS.maxDrawdownR * 1.1;

    if (improved) {
      nextWeights[regime] = candidateW;
      report[regime] = { updated: true, trainN: trainSet.length, oosN: oosSet.length, oldOOS, newOOS, layerPerf };
    } else {
      report[regime] = { updated: false, reason: 'بهبود معنادار در Out-of-Sample تأیید نشد', oldOOS, newOOS };
    }
  }

  const anyUpdated = Object.values(report).some((x) => x.updated);
  return { anyUpdated, nextWeights, report };
}

/* ---------- ۴. تشخیص افت عملکرد مدل (Degradation Detector + Rollback Signal) ---------- */
export function checkModelHealth(closedSignals) {
  const recent = closedSignals.slice(-LEARN_CFG.degradeWindow);
  const m = computeMetrics(recent);
  if (recent.length < 15) return { healthy: true, status: 'WARMING_UP', metrics: m, action: 'NONE' };
  const degraded = m.expectancyR <= LEARN_CFG.degradeMinExpectancy || m.maxDrawdownR >= LEARN_CFG.degradeMaxDD;
  return {
    healthy: !degraded,
    status: degraded ? 'DEGRADED' : 'HEALTHY',
    metrics: m,
    action: degraded ? 'ROLLBACK_OR_CONSERVATIVE_MODE' : 'KEEP_ACTIVE',
  };
}

/* ---------- ۵. موتور بک‌تست سخت‌گیرانه Walk-Forward (کندل‌به‌کندل بدون نشت آینده) ---------- */
export function runWalkForwardBacktest({
  symbol,
  primaryTf = '15m',
  allTimeframes,         // { '15m': [...], '1h': [...], '4h': [...], '1d': [...] }
  btcBars = null,
  config = {},
  initialWeights = DEFAULT_REGIME_WEIGHTS,
  trainWindowBars = 300,
  testWindowBars = 150,
}) {
  const bars = allTimeframes[primaryTf] || [];
  if (bars.length < trainWindowBars + testWindowBars + 80) {
    return { error: 'داده تاریخی برای Walk-Forward کافی نیست' };
  }

  const tfDur = TF_MS[primaryTf] || 900e3;
  // تابع برش بدون Look-Ahead برای تایم‌فریم‌های بالاتر
  const sliceClosed = (arr, tf, nowTs) => {
    const dur = TF_MS[tf] || 900e3;
    let lo = 0, hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid].t + dur <= nowTs) lo = mid + 1; else hi = mid;
    }
    return arr.slice(Math.max(0, lo - 220), lo);
  };

  let activeWeights = JSON.parse(JSON.stringify(initialWeights));
  const oosTrades = [];
  const foldSummaries = [];

  for (let start = 200; start + trainWindowBars + testWindowBars <= bars.length; start += testWindowBars) {
    const trainEnd = start + trainWindowBars;
    const testEnd = Math.min(bars.length - 2, trainEnd + testWindowBars);

    const simulateSlice = (fromIdx, toIdx, wMap) => {
      const trades = [];
      let i = fromIdx;
      while (i < toIdx) {
        const nowTs = bars[i].t + tfDur;
        const tfSnap = {};
        for (const [tf, arr] of Object.entries(allTimeframes)) {
          tfSnap[tf] = tf === primaryTf ? bars.slice(Math.max(0, i - 219), i + 1) : sliceClosed(arr, tf, nowTs);
        }
        const btcSnap = btcBars ? sliceClosed(btcBars, primaryTf, nowTs) : null;
        const res = evaluateMarket(
          { symbol, primaryTf, timeframes: tfSnap, livePrice: bars[i].c, btcBars: btcSnap, nowTs },
          wMap,
          config
        );
        if (res.signal === 'NO_TRADE') { i++; continue; }

        // ورود محافظه‌کارانه روی Open کندل بعدی (حذف فریب کلوز هم‌کندل)
        const entryBar = bars[i + 1];
        const dir = res.signal === 'LONG' ? 1 : -1;
        const entry = entryBar.o;
        const risk = Math.abs(entry - res.stopLoss);
        if (!(risk > 0)) { i++; continue; }

        const cost = entry * (((config.feeRoundTripPct || 0.12) + (config.slippagePct || 0.05)) / 100);
        let exitPrice = null, status = 'EXPIRED', j = i + 1, mfe = 0, mae = 0;
        const maxBarsHold = 32;

        for (; j < Math.min(bars.length, i + 1 + maxBarsHold); j++) {
          const b = bars[j];
          const fav = dir > 0 ? (b.h - entry) / risk : (entry - b.l) / risk;
          const adv = dir > 0 ? (entry - b.l) / risk : (b.h - entry) / risk;
          if (fav > mfe) mfe = fav;
          if (adv > mae) mae = adv;
          const hitSL = dir > 0 ? b.l <= res.stopLoss : b.h >= res.stopLoss;
          const hitTP1 = dir > 0 ? b.h >= res.tp1 : b.l <= res.tp1;
          const hitTP2 = dir > 0 ? b.h >= res.tp2 : b.l <= res.tp2;
          // در صورت ابهام در یک کندل، محافظه‌کارانه SL لحاظ می‌شود
          if (hitSL) { exitPrice = res.stopLoss; status = 'SL'; break; }
          if (hitTP2) { exitPrice = res.tp2; status = 'TP2'; break; }
          if (hitTP1) { exitPrice = res.tp1; status = 'TP1'; break; }
        }
        if (exitPrice == null) { j = Math.min(j, bars.length - 1); exitPrice = bars[j].c; }

        const realized_r = (dir * (exitPrice - entry) - cost) / (risk + cost);
        trades.push({
          created_at: nowTs,
          close_at: bars[j].t + tfDur,
          symbol, timeframe: primaryTf,
          regime: res.regime,
          signal_type: res.signal,
          confidence_score: res.confidenceScore,
          realized_r: Number(realized_r.toFixed(3)),
          mfe_r: Number(mfe.toFixed(2)),
          mae_r: Number(mae.toFixed(2)),
          status,
          features_json: res.featureVector,
        });
        i = j + 1;
      }
      return trades;
    };

    // گام آموزش روی پنجره Train و کالیبراسیون وزن فقط در صورت عبور از گیت OOS
    const trainTrades = simulateSlice(start, trainEnd, activeWeights);
    const upd = proposeWeightUpdate(activeWeights, trainTrades);
    if (upd.anyUpdated) activeWeights = upd.nextWeights;

    // تست کاملاً خارج از نمونه (Out-of-Sample) روی پنجره بعدی
    const testTrades = simulateSlice(trainEnd, testEnd, activeWeights);
    oosTrades.push(...testTrades);
    foldSummaries.push({
      trainCount: trainTrades.length,
      testCount: testTrades.length,
      weightsUpdated: upd.anyUpdated,
      testMetrics: computeMetrics(testTrades),
    });
  }

  // تفکیک عملکرد به تفکیک رژیم بازار
  const byRegime = {};
  for (const t of oosTrades) {
    if (!byRegime[t.regime]) byRegime[t.regime] = [];
    byRegime[t.regime].push(t);
  }
  const regimeBreakdown = Object.fromEntries(
    Object.entries(byRegime).map(([r, list]) => [r, computeMetrics(list)])
  );

  return {
    symbol,
    timeframe: primaryTf,
    overallOOS: computeMetrics(oosTrades),
    regimeBreakdown,
    calibration: buildCalibrationTable(oosTrades),
    foldSummaries,
    finalWeights: activeWeights,
    trades: oosTrades,
  };
}