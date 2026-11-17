// ============================================================
// Cloudflare Worker: پراکسی قیمت ایران + ثبت‌کننده‌ی ۲۴ساعته‌ی سیگنال اسکنر + تلگرام
// نیازها: KV با نام اتصال SIG | متغیرهای NOTIFY_KEY و (TG_TOKEN + TG_CHAT یا NTFY_TOPIC) | (اختیاری) SCALP_COST (پیش‌فرض 0.12)
// Cron Triggers: دو تا بساز →  */5 * * * *  (اسکنر و دفترچه)   و   * * * * *  (اسکالپ هوشمند ۱۶ ارز، هر دقیقه)
// ============================================================
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Key',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};
const out = (o, status = 200, cache = 15) =>
  new Response(JSON.stringify(o), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=' + cache },
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
  const [nb, tg] = await Promise.allSettled([
    getJson('https://apiv2.nobitex.ir/market/stats?srcCurrency=usdt&dstCurrency=rls'),
    getJson('https://call4.tgju.org/ajax.json'),
  ]);
  if (nb.status === 'fulfilled') {
    const v = num(nb.value?.stats?.['usdt-rls']?.latest);
    if (v) o.usd = { toman: v / 10, source: 'nobitex-usdt' };
    else o.errors.nobitex = 'داده usdt-rls پیدا نشد';
  } else o.errors.nobitex = String(nb.reason);
  if (tg.status === 'fulfilled') {
    const c = tg.value?.current || {};
    const g = num(c.geram18?.p), d = num(c.price_dollar_rl?.p);
    if (g) o.gold18 = { toman: g / 10, source: 'tgju' }; else o.errors.tgjuGold = 'geram18 پیدا نشد';
    if (d) o.usdFree = { toman: d / 10, source: 'tgju' }; else o.errors.tgjuUsd = 'price_dollar_rl پیدا نشد';
    if (debug) o.tgjuKeys = Object.keys(c).filter((k) => /geram|dollar|usd/i.test(k)).slice(0, 40);
  } else o.errors.tgju = String(tg.reason);
  return o;
}

// ---------- موتور اسکنر (همان توابع صفحه؛ فاندینگ در سرور لحاظ نمی‌شود) ----------
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
    await new Promise((r) => setTimeout(r, 500 * (round + 1)));
  }
  throw new Error('binance unreachable');
}
async function kl(sym, tf, n) {
  const d = await bj(`/api/v3/klines?symbol=${sym}&interval=${tf}&limit=${n}`);
  if (!Array.isArray(d) || d.length < 62) throw new Error('کندل ناکافی');
  const a = d.slice(0, -1).map((k) => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
  if (a.some((x) => ![x.o, x.h, x.l, x.c, x.v].every(Number.isFinite) || x.h < x.l || x.c <= 0)) throw new Error('کندل نامعتبر');
  return { a, live: +d[d.length - 1][4] };
}
function ema(a,p){if(!Array.isArray(a)||!a.length||!a.every(Number.isFinite))return [];const k=2/(p+1);let e=a[0];const out=[e];for(let i=1;i<a.length;i++){e=a[i]*k+e*(1-k);out.push(e)}return out}
function rsi(c,p=14){if(c.length<p+1)return null;let g=0,l=0;
  for(let i=1;i<=p;i++){const d=c[i]-c[i-1];d>=0?g+=d:l-=d}g/=p;l/=p;
  for(let i=p+1;i<c.length;i++){const d=c[i]-c[i-1];g=(g*(p-1)+Math.max(d,0))/p;l=(l*(p-1)+Math.max(-d,0))/p}
  if(g===0&&l===0)return 50;return l===0?100:100-100/(1+g/l)}
function atr(cs,p=14){if(cs.length<p+1)return null;let a=0;
  for(let i=1;i<cs.length;i++){const h=cs[i].h,l=cs[i].l,pc=cs[i-1].c;const tr=Math.max(h-l,Math.abs(h-pc),Math.abs(l-pc));a=i<=p?a+tr/p:(a*(p-1)+tr)/p}return a}
function macdHist(c){const a=ema(c,12),b=ema(c,26),m=a.map((v,i)=>v-b[i]),sg=ema(m,9);return m.map((v,i)=>v-sg[i])}
function tfTrend(a){
  const c=a.map(x=>x.c);if(c.length<80)return 0;
  const e20=ema(c,20),e50=ema(c,50),i=c.length-1;
  const f=[e20[i]>e50[i],c[i]>e50[i],e50[i]>e50[i-5]];
  if(c.length>=200){const e200=ema(c,200);f.push(c[i]>e200[i])}
  return f.reduce((t,x)=>t+(x?1:-1),0)/f.length;
}
function sigLevels(a,k,A,pm){
  const hi=[],lo=[];
  for(let i=k;i<a.length-k;i++){
    let H=true,L=true,mn=Infinity,mx=-Infinity;
    for(let j=1;j<=k;j++){
      if(a[i].h<=a[i-j].h||a[i].h<=a[i+j].h)H=false;
      if(a[i].l>=a[i-j].l||a[i].l>=a[i+j].l)L=false;
      mn=Math.min(mn,a[i-j].l,a[i+j].l);mx=Math.max(mx,a[i-j].h,a[i+j].h);
    }
    if(H&&a[i].h-mn>=pm*A)hi.push(a[i].h);
    if(L&&mx-a[i].l>=pm*A)lo.push(a[i].l);
  }
  return{hi,lo};
}
function evalCoin(sym,D,btcBias){
  const a=D.m15.a,price=D.m15.live,c=a.map(x=>x.c),n=c.length-1;
  const t4=tfTrend(D.h4.a),t1=tfTrend(D.h1.a),trend=.6*t4+.4*t1;
  const o={sym,price,t4,t1,score:0,dir:0,reasons:[],warns:[],reject:null,setup:null};
  const rej=t=>{if(!o.reject)o.reject=t};
  if(!(price>0)){o.reject='قیمت نامعتبر';return o}
  const d=trend>=0?1:-1;o.dir=d;
  const trendOk=Math.abs(trend)>=.5&&t4*t1>0;
  if(!trendOk)rej('روند ۱ساعته و ۴ساعته هم‌جهت و قوی نیست');
  const e20=ema(c,20),r=rsi(c),A=atr(a),H=macdHist(c);
  if(![r,A,e20[n],H[n],H[n-1]].every(Number.isFinite)||A<=0){o.reject='اندیکاتور نامعتبر';return o}
  const ap=A/price*100;
  if(ap<.12)rej('نوسان خیلی کم است');
  if(ap>2.5)rej('نوسان بیش‌ازحد؛ ریسک لغزش بالا');
  if(d>0?r>72:r<28)rej(d>0?'اشباع خرید؛ تعقیب قیمت':'اشباع فروش؛ تعقیب قیمت');
  const c1h=D.h1.a.map(x=>x.c),n1=c1h.length-1,den1=c1h.slice(n1-19).reduce((t,x,i,arr)=>i?t+Math.abs(x-arr[i-1]):t,0),er1=den1>0?Math.abs(c1h[n1]-c1h[n1-19])/den1:0;
  if(er1<.2)rej('بازار ۱ساعته رنج است (ER='+fa(er1,2)+')');
  if((price-c[n])*d>.8*A)rej('قیمت در جهت معامله پریده؛ منتظر پولبک یا کندل بعدی');
  let sc=Math.max(0,t4*d)*25+Math.max(0,t1*d)*15;
  if(trendOk)o.reasons.push('روند '+(d>0?'صعودی':'نزولی')+' در ۱ساعته و ۴ساعته');
  const dist=(price-e20[n])*d/A;
  if(dist<=.3&&dist>=-1.2){sc+=15;o.reasons.push('قیمت نزدیک EMA20 (پولبک سالم)')}
  else if(dist>1.5){sc-=10;o.warns.push('قیمت از EMA20 دور شده؛ احتمال تعقیب')}
  if(c[n]*d>e20[n]*d){sc+=10;o.reasons.push('آخرین کندل بسته‌شده سمت درست EMA20')}
  if(H[n]*d>0&&(H[n]-H[n-1])*d>0){sc+=15;o.reasons.push('MACD هم‌جهت و در حال تقویت')}
  else if(H[n]*d>0)sc+=7;
  else{sc-=5;o.warns.push('مومنتوم ۱۵ دقیقه هنوز هم‌جهت نیست')}
  if(d>0?(r>=40&&r<=62):(r>=38&&r<=60)){sc+=10;o.reasons.push('RSI در محدوده سالم ('+fa(r,0)+')')}
  const vAvg=a.slice(-21,-1).reduce((t,x)=>t+x.v,0)/20,vr=vAvg>0?a[n].v/vAvg:0;
  if(vr>=1.2){sc+=10;o.reasons.push('حجم بالاتر از میانگین ('+fa(vr,1)+' برابر)')}
  else if(vr<.6){sc-=5;o.warns.push('حجم ضعیف')}
  if(sym!=='BTCUSDT'){
    if(btcBias*d>=.4){sc+=10;o.reasons.push('بیت‌کوین هم‌جهت است')}
    else if(btcBias*d<=-.4){sc-=15;o.warns.push('بیت‌کوین خلاف جهت است')}
  }
  const fr=SC.fund[sym];
  if(Number.isFinite(fr)){
    const f=fr*100*d;
    if(f>.05){sc-=10;o.warns.push('فاندینگ در جهت معامله بالاست (ازدحام)')}
    else if(f<-.01){sc+=5;o.reasons.push('فاندینگ به نفع معامله')}
  }
  o.score=Math.max(0,Math.min(100,Math.round(sc/115*100)));
  const last=a.slice(-10),swing=d>0?Math.min(...last.map(x=>x.l)):Math.max(...last.map(x=>x.h));
  let risk=d>0?price-(swing-.2*A):(swing+.2*A)-price;
  risk=Math.max(risk,1.2*A);
  if(risk>2.5*A){rej('حد ضرر منطقی دور است (ورود دیر)');risk=2.5*A}
  const A1h=atr(D.h1.a);
  const P=sigLevels(a.slice(-96),5,A,1),Q=Number.isFinite(A1h)?sigLevels(D.h1.a.slice(-120),3,A1h,1):{hi:[],lo:[]};
  const hiL=[...P.hi,...Q.hi,Math.max(...a.slice(-96).map(x=>x.h))].filter(x=>x>price*1.0005),loL=[...P.lo,...Q.lo,Math.min(...a.slice(-96).map(x=>x.l))].filter(x=>x<price*.9995);
  const near=d>0?Math.min(Infinity,...hiL):Math.max(-Infinity,...loL);
  const room=d>0?near-price:price-near,cost=price*.0012;
  let tp1=price+d*1.5*risk,tp2=price+d*2.5*risk,capped=false;
  if(room<1.1*risk)rej((d>0?'مقاومت':'حمایت')+' خیلی نزدیک است (فضا کمتر از ۱٫۱ برابر ریسک)');
  else if(room<1.5*risk){capped=true;tp1=price+d*(room-.15*A);tp2=tp1;o.warns.push('هدف تا '+(d>0?'مقاومت':'حمایت')+' محدود شد')}
  const rr1=(Math.abs(tp1-price)-cost)/(risk+cost),rr2=(Math.abs(tp2-price)-cost)/(risk+cost);
  if(capped?rr1<1:rr2<1.5)rej(capped?'هدف محدودشده نسبت به ریسک و کارمزد کم است':'حد ضرر خیلی نزدیک است؛ کارمزد سود را می‌خورد');
  o.setup={entry:price,maxEntry:price+d*.3*A,sl:price-d*risk,tp1,tp2,rr1,rr2,atrPct:ap,capped,level:Number.isFinite(near)?near:null};
  return o;
}

// ---------- تلگرام ----------
async function tg(env, text) {
  // مسیر دوم اختیاری: ntfy.sh (اپ ntfy روی گوشی). فقط اگر متغیر NTFY_TOPIC تنظیم شده باشد.
  if (env.NTFY_TOPIC) {
    try {
      await fetch('https://ntfy.sh/' + encodeURIComponent(env.NTFY_TOPIC), {
        method: 'POST',
        headers: { Title: 'Crypto Terminal', Priority: 'high', Tags: 'chart_with_upwards_trend' },
        body: String(text).slice(0, 1500),
      });
    } catch (e) {}
  }
  if (!env.TG_TOKEN || !env.TG_CHAT) return;
  try {
    await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: env.TG_CHAT, text: String(text).slice(0, 1500) }),
    });
  } catch (e) {}
}
const closeJ = (e, st, pr) => { e.status = st; e.closeT = Date.now(); e.closeP = pr; };
// وقتی TP و SL در یک کندل ۱۵دقیقه‌ای لمس شوند، با کندل‌های ۱دقیقه‌ای ترتیب را تعیین می‌کنیم؛ اگر باز هم مبهم بود، ضرر.
async function tieBreak(e, k) {
  try {
    const d = await bj(`/api/v3/klines?symbol=${e.sym}&interval=1m&startTime=${k[0]}&limit=15`);
    for (const c of d) {
      const h = +c[2], l = +c[3];
      if (e.side > 0 ? l <= e.sl : h >= e.sl) return 'loss';
      if (e.side > 0 ? h >= e.tp : l <= e.tp) return 'win';
    }
  } catch (x) {}
  return 'loss';
}
const nm = (s) => s.replace('USDT', '');
const hm = () => new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Tehran' });
const pp = (x) => (x >= 100 ? Number(x).toFixed(2) : x >= 1 ? Number(x).toFixed(3) : Number(x).toFixed(5));
const pc = (a, b) => { const v = (a / b - 1) * 100; return (v >= 0 ? '+' : '') + v.toFixed(2) + '%'; };
function sigMsg(kind, sym, dir, score, s, note) {
  return (kind === 'scalp' ? '⚡ اسکالپ' : '📈 اسکنر') + ' · ' + (dir > 0 ? '🟢 LONG' : '🔴 SHORT') + ' · ' + nm(sym) + '\n' +
    '🕒 ساعت تهران: ' + hm() + '\n' +
    '🎯 ورود: ' + pp(s.entry) + (s.maxEntry ? ' (حداکثر ورود ' + pp(s.maxEntry) + ')' : '') + '\n' +
    '🛑 SL: ' + pp(s.sl) + ' (' + pc(s.sl, s.entry) + ')\n' +
    '✅ TP1: ' + pp(s.tp1) + ' (' + pc(s.tp1, s.entry) + ')' + (s.tp2 ? ' | TP2: ' + pp(s.tp2) + ' (' + pc(s.tp2, s.entry) + ')' : '') + '\n' +
    '📊 امتیاز ' + score + (s.rr2 != null ? ' | RR ' + Number(s.rr2).toFixed(2) : '') + '\n' + note;
}


// ---------- کرون: اسکن + ارزیابی + ثبت ----------
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
        msgs.push((e.status === 'win' ? '✅ ' : e.status === 'loss' ? '❌ ' : '⏱ ') + nm(e.sym) + ' ' + (e.side > 0 ? 'LONG' : 'SHORT') + ' بسته شد: ' + (e.status === 'win' ? 'TP1' : e.status === 'loss' ? 'SL' : 'منقضی') + '\n🕒 ' + hm() + ' | ورود ' + pp(e.entry) + ' → خروج ' + pp(e.closeP || e.entry));
      }
    } catch (_) {}
  }
  const res = await Promise.allSettled(SCAN.map(async (s) => ({ s, m15: await kl(s, '15m', 200), h1: await kl(s, '1h', 210), h4: await kl(s, '4h', 210) })));
  const D = {}; res.forEach((r, i) => { if (r.status === 'fulfilled') D[SCAN[i]] = r.value; });
  const bb = D.BTCUSDT ? 0.6 * tfTrend(D.BTCUSDT.h4.a) + 0.4 * tfTrend(D.BTCUSDT.h1.a) : 0;
  const ev = SCAN.filter((s) => D[s]).map((s) => evalCoin(s, D[s], bb));
  const best = ev.filter((x) => !x.reject && x.score >= SC_MIN).sort((a, b) => b.score - a.score)[0];
  let opened = null;
  if (best && !E.some((e) => e.status === 'open' && e.sym === best.sym)) {
    const last = [...E].reverse().find((e) => e.sym === best.sym);
    if (!(last && last.side === best.dir && Date.now() - (last.closeT || last.t) < 15 * 60000)) {
      const s = best.setup;
      opened = { id: Date.now(), t: Date.now(), sym: best.sym, side: best.dir, entry: s.entry, tp: s.tp1, sl: s.sl, src: 'scan', ttl: 0, score: best.score, status: 'open' };
      E.push(opened); dirty = true;
      msgs.push(sigMsg('scan', best.sym, best.dir, best.score, s, '⏳ اعتبار: تا رسیدن به TP/SL (حداکثر ۳ روز)'));
    }
  }
  if (dirty) { st.entries = E.slice(-500); st.ts = Date.now(); await env.SIG.put('journal', JSON.stringify(st)); }
  for (const m of msgs) await tg(env, m);
  return { scanned: Object.keys(D).length, opened: !!opened, changed: dirty, scores: ev.map((x) => [x.sym, x.score, x.reject || 'OK']) };
}


// ============================================================
// اسکالپ هوشمند سمت سرور (وقتی برنامه بسته یا در پس‌زمینه است هم کار می‌کند)
// داده از REST بایننس: کندل ۱دقیقه‌ای با حجم خریدار تهاجمی (taker)، کندل ۵دقیقه‌ای و ۱ساعته، و عمق ۲۰ سطحی.
// هر دقیقه نیمی از ارزها بررسی می‌شوند (سقف ۵۰ درخواست در پلن رایگان)؛ هر ارز هر ۲ دقیقه یک بار.
// ============================================================
const SCALP = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','LINKUSDT','AVAXUSDT','DOGEUSDT'];
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
    for (let j = 1; j <= k; j++) { if (a[i].h <= a[i-j].h || a[i].h <= a[i+j].h) h = false; if (a[i].l >= a[i-j].l || a[i].l >= a[i+j].l) l = false; }
    if (h) H.push(a[i].h); if (l) L.push(a[i].l);
  }
  if (H.length < 2 || L.length < 2) return { dir: 0, bos: 0 };
  const hh = H[H.length-1] > H[H.length-2], hl = L[L.length-1] > L[L.length-2], c = a[a.length-1].c;
  return { dir: hh && hl ? 1 : (!hh && !hl ? -1 : 0), bos: c > H[H.length-1] ? 1 : c < L[L.length-1] ? -1 : 0 };
}
function trendOfC(c) {
  if (c.length < 40) return 0;
  const e9 = ema(c, 9).at(-1), e21 = ema(c, 21).at(-1), a = ema(c, 12), b = ema(c, 26);
  const m = a.map((v, i) => v - b[i]), sg = ema(m, 9), h = m.at(-1) - sg.at(-1);
  if (![e9, e21, h].every(Number.isFinite)) return 0;
  const x = (e9 > e21 ? 1 : -1) + (h > 0 ? 1 : -1);
  return x === 2 ? 1 : x === -2 ? -1 : 0;
}
function scalpEvalS(sym, K1, K5, H1, dp, fr, costPct) {
  const R = { sym, gate: [], comp: [], score: 0, dir: 0, gateOk: false, ok: false, setup: null, why: null };
  const bids = (dp.bids || []).map((x) => [+x[0], +x[1]]), asks = (dp.asks || []).map((x) => [+x[0], +x[1]]);
  if (!bids.length || !asks.length) { R.why = 'دفتر سفارش خالی'; return R; }
  const bid = bids[0][0], ask = asks[0][0], mid = (bid + ask) / 2;
  const a1 = K1.slice(0, -1), a5 = K5.slice(0, -1), c1 = a1.map((x) => x.c), c5 = a5.map((x) => x.c);
  const A1 = atr(a1), A5 = atr(a5);
  if (![A1, A5].every(Number.isFinite) || A5 <= 0 || A1 <= 0) { R.why = 'اندیکاتور نامعتبر'; return R; }
  const gate = (name, ok, val) => R.gate.push({ name, ok, val });
  const spr = (ask - bid) / mid * 1e4;
  gate('اسپرد', spr <= (/^(BTC|ETH)/.test(sym) ? 2.5 : 8), fa(spr, 2) + ' bps');
  const slip = (side) => { const bk = side > 0 ? asks : bids; let need = 1e4, cost = 0, qty = 0; for (const [p, q] of bk) { const v = p * q, t = Math.min(need, v); cost += t; qty += t / p; need -= t; if (need <= 0) break; } return need > 0 ? null : Math.abs(cost / qty / mid - 1) * 1e4; };
  const sb = slip(1), ss = slip(-1), sm = sb == null || ss == null ? null : Math.max(sb, ss);
  gate('لغزش سفارش ۱۰هزار دلاری', sm != null && sm <= 4, sm == null ? 'عمق کافی نیست' : fa(sm, 2) + ' bps');
  const ap5 = A5 / mid * 100; gate('نوسان ۵دقیقه‌ای', ap5 >= .04 && ap5 <= .8, fa(ap5, 2) + '٪');
  const l1 = a1[a1.length - 1], spike = (l1.h - l1.l) / A1; gate('بدون جهش ناگهانی', spike < 3, fa(spike, 1) + ' برابر ATR');
  R.gateOk = R.gate.every((x) => x.ok);
  const add = (name, w, v, fam) => R.comp.push({ name, w, v: clamp1(v), fam: fam || 'price' });
  // جریان: حجم خریدار تهاجمی کندل‌های ۱دقیقه‌ای (کندل جاری هم لحاظ می‌شود)
  const delta = (arr) => { const v = arr.reduce((t, x) => t + x.v, 0); return v > 0 ? arr.reduce((t, x) => t + (2 * x.tb - x.v), 0) / v : 0; };
  add('حجم مهاجم ~۱-۲ دقیقه', 15, delta(K1.slice(-2)) / .4, 'flow');
  add('CVD ۵دقیقه', 10, delta(K1.slice(-5)) / .25, 'flow');
  const B = bids.slice(0, 10).reduce((t, x) => t + x[0] * x[1], 0), A = asks.slice(0, 10).reduce((t, x) => t + x[0] * x[1], 0), imb = B + A > 0 ? (B - A) / (B + A) : 0;
  add('عدم‌توازن دفتر سفارش', 10, imb / .3, 'book');
  const wl = (bk) => { const v = bk.slice(0, 20).map((x) => x[0] * x[1]); if (v.length < 10) return 0; const mean = v.reduce((t, x) => t + x, 0) / v.length; return mean > 0 ? Math.max(...v.slice(0, 10)) / mean : 0; };
  const aw = wl(asks), bw = wl(bids);
  add('دیوار سفارش', 5, (aw >= 4 && bw < 4) ? -1 : (bw >= 4 && aw < 4) ? 1 : 0, 'book');
  add('ازدحام فاندینگ', 10, Number.isFinite(fr) ? (fr > .05 ? -1 : fr < -.01 ? 1 : 0) * .6 : 0, 'deriv');
  const e9 = ema(c1, 9).at(-1), e21 = ema(c1, 21).at(-1), w = a1.slice(-60), pv = w.reduce((t, x) => t + (x.h + x.l + x.c) / 3 * x.v, 0), vv = w.reduce((t, x) => t + x.v, 0), vwap = vv > 0 ? pv / vv : mid;
  add('VWAP ۱ساعته', 8, (mid - vwap) / (.8 * A5));
  add('EMA9/21 یک‌دقیقه‌ای', 7, (e9 - e21) / (.5 * A1));
  const Hm = macdHist(c5), h0 = Hm.at(-1), h1 = Hm.at(-2);
  add('MACD پنج‌دقیقه‌ای', 5, (h0 > 0 ? .5 : -.5) + (h0 > h1 ? .5 : -.5));
  const prev = a1.slice(-16, -1), hi15 = Math.max(...prev.map((x) => x.h)), lo15 = Math.min(...prev.map((x) => x.l)), vAvg = a1.slice(-21, -1).reduce((t, x) => t + x.v, 0) / 20, vr = vAvg > 0 ? l1.v / vAvg : 0;
  const bo = l1.c > hi15 && mid > hi15 && vr >= 1.3 ? 1 : l1.c < lo15 && mid < lo15 && vr >= 1.3 ? -1 : 0;
  const prev2 = a1.slice(-17, -2), h2 = Math.max(...prev2.map((x) => x.h)), l2 = Math.min(...prev2.map((x) => x.l)), pc = a1[a1.length - 2];
  const fake = pc.c > h2 && l1.c <= h2 ? -1 : pc.c < l2 && l1.c >= l2 ? 1 : 0;
  add('شکست ۱۵دقیقه‌ای', 5, bo || fake);
  add('روند ۱ساعته', 5, trendOfC(H1.slice(0, -1).map((x) => x.c)));
  const ss5 = swingStruct(a5.slice(-80), 2); add('ساختار ۵دقیقه‌ای', 8, ss5.dir * .7 + ss5.bos * .5);
  const FW = { flow: 30, price: 28, book: 15, deriv: 20, ctx: 7 }, fv = {};
  Object.keys(FW).forEach((f) => { const cs = R.comp.filter((x) => x.fam === f), sw = cs.reduce((t, x) => t + x.w, 0); fv[f] = sw > 0 ? cs.reduce((t, x) => t + x.w * x.v, 0) / sw : 0; });
  const S0 = Object.keys(FW).reduce((t, f) => t + FW[f] * fv[f], 0);
  const n5 = c5.length - 1, den = c5.slice(n5 - 19, n5 + 1).reduce((t, x, i, arr) => (i ? t + Math.abs(x - arr[i - 1]) : t), 0), er = den > 0 ? Math.abs(c5[n5] - c5[n5 - 19]) / den : 0;
  const regime = er >= .3 ? 1 : er >= .2 ? .85 : .65;
  R.score = Math.round(Math.abs(S0) * regime); R.dir = S0 >= 0 ? 1 : -1; R.fam = fv;
  { const dd = R.dir, agree = ['flow', 'price', 'book', 'deriv'].filter((f) => fv[f] * dd >= .25);
    gate('تأیید مستقل (≥۲ خانواده، یکی جریان/دفتر سفارش)', agree.length >= 2 && (agree.includes('flow') || agree.includes('book')), agree.join('+') || 'هیچ');
    gate('جریان سفارش مخالف نیست', fv.flow * dd > -.2, fa(fv.flow * dd * 100, 0) + '٪');
    gate('رژیم بازار (روندی بودن)', er >= .15, 'ER=' + fa(er, 2));
    R.gateOk = R.gate.every((x) => x.ok); }
  const d = R.dir, l8 = a1.slice(-8), sw = d > 0 ? Math.min(...l8.map((x) => x.l)) : Math.max(...l8.map((x) => x.h));
  let risk = d > 0 ? mid - (sw - .1 * A5) : (sw + .1 * A5) - mid; risk = Math.max(risk, .8 * A5);
  const cost = mid * (costPct / 100), rr2 = (2.5 * risk - cost) / (risk + cost);
  const lv = sigLevels(a5.slice(-96), 3, A5, 1); lv.hi.push(Math.max(...a5.slice(-96).map((x) => x.h))); lv.lo.push(Math.min(...a5.slice(-96).map((x) => x.l))); const near = d > 0 ? Math.min(Infinity, ...lv.hi.filter((x) => x > mid * 1.0002)) : Math.max(-Infinity, ...lv.lo.filter((x) => x < mid * .9998)), room = Number.isFinite(near) ? (d > 0 ? near - mid : mid - near) : Infinity;
  if (risk > 1.6 * A5) R.why = 'حد ضرر منطقی دور است (ورود دیر)';
  else if (room < 1.2 * risk) R.why = (d > 0 ? 'مقاومت' : 'حمایت') + ' نزدیک است';
  else if (rr2 < 1.5) R.why = 'حرکت قابل‌انتظار نسبت به کارمزد کوچک است';
  let t1 = mid + d * 1.5 * risk; if (Number.isFinite(room) && room < 1.5 * risk) t1 = mid + d * (room - .1 * A5);
  R.setup = { entry: mid, maxEntry: mid + d * .15 * A5, sl: mid - d * risk, tp1: t1, tp2: mid + d * 2.5 * risk, rr2 };
  if (!R.gateOk) R.why = 'گیت رد شد: ' + R.gate.filter((x) => !x.ok).map((x) => x.name).join('، ');
  else if (R.score < SCALP_MIN_SCORE) R.why = 'قدرت سیگنال کمتر از ' + SCALP_MIN_SCORE;
  R.ok = R.gateOk && R.score >= SCALP_MIN_SCORE && !R.why;
  return R;
}
async function scalpCron(env, all) {
  const slot = Math.floor(Date.now() / 60000) % 2;
  const list = all ? SCALP : SCALP.filter((_, i) => i % 2 === slot);
  const costPct = parseFloat(env.SCALP_COST) || .12;
  const fund = {};
  try { const r = await fetch('https://fapi.binance.com/fapi/v1/premiumIndex', { headers: { 'User-Agent': 'Mozilla/5.0' } }); if (r.ok) (await r.json()).forEach((x) => { fund[x.symbol] = +x.lastFundingRate * 100; }); } catch (e) {}
  const out = [];
  await Promise.allSettled(list.map(async (sym) => {
    try {
      const [K1, K5, H1, dp] = await Promise.all([klr(sym, '1m', 100), klr(sym, '5m', 100), klr(sym, '1h', 100), bj(`/api/v3/depth?symbol=${sym}&limit=20`)]);
      out.push(scalpEvalS(sym, K1, K5, H1, dp, fund[sym], costPct));
    } catch (e) { out.push({ sym, ok: false, score: 0, why: 'داده دریافت نشد' }); }
  }));
  const sent = [];
  for (const R of out.filter((x) => x.ok).sort((a, b) => b.score - a.score)) {
    const key = 'sc:' + R.sym + R.dir;
    if (env.SIG) { if (await env.SIG.get(key)) continue; await env.SIG.put(key, '1', { expirationTtl: 900 }); }
    const s = R.setup;
    await tg(env, sigMsg('scalp', R.sym, R.dir, R.score, s, '⏳ انقضا: ۲۰ دقیقه از همین ساعت'));
    sent.push(R.sym);
  }
  return { scanned: list.length, signals: sent, scores: out.map((x) => [x.sym, x.score, x.dir, x.ok ? 'OK' : x.why]) };
}

const ONL = new Map(); // شمارنده‌ی آنلاین (تقریبی؛ در حافظه‌ی Worker)
// ---------- مسیرها ----------
export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const u = new URL(req.url);
    const p = u.pathname.replace(/\/+$/, '') || '/';
    if (p === '/ping') {
      const id = String(u.searchParams.get('id') || '').slice(0, 40), now = Date.now();
      if (id) ONL.set(id, now);
      for (const [k, t] of ONL) if (now - t > 150000) ONL.delete(k);
      return out({ n: ONL.size }, 200, 0);
    }
    if (p === '/journal') {
      if (!env.SIG) return out({ error: 'KV binding SIG تنظیم نشده', entries: [] }, 200, 0);
      const raw = (await env.SIG.get('journal')) || '{"entries":[]}';
      return new Response(raw, { headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=20' } });
    }
    if (p === '/notify' && req.method === 'POST') {
      if (!env.NOTIFY_KEY || req.headers.get('X-Key') !== env.NOTIFY_KEY) return out({ error: 'unauthorized' }, 401, 0);
      let b = {}; try { b = await req.json(); } catch (e) {}
      if (!b.text) return out({ error: 'no text' }, 400, 0);
      if (b.sym && b.side && env.SIG) { // جلوگیری از پیام تکراری وقتی صفحه باز است و سرور هم همان سیگنال را دیده
        const key = 'sc:' + b.sym + b.side;
        if (await env.SIG.get(key)) return out({ ok: true, dup: true }, 200, 0);
        await env.SIG.put(key, '1', { expirationTtl: 900 });
      }
      await tg(env, '⚡ ' + String(b.text).slice(0, 500));
      return out({ ok: true }, 200, 0);
    }
    if (p === '/test') {
      if (!env.NOTIFY_KEY || (req.headers.get('X-Key') || u.searchParams.get('key')) !== env.NOTIFY_KEY) return out({ error: 'unauthorized' }, 401, 0);
      await tg(env, '✅ تست اتصال: اگر این پیام را می‌بینی، هشدار تلگرام درست کار می‌کند');
      return out({ ok: true, telegram: !!(env.TG_TOKEN && env.TG_CHAT), ntfy: !!env.NTFY_TOPIC, kv: !!env.SIG }, 200, 0);
    }
    if (p === '/run-scalp') {
      if (!env.NOTIFY_KEY || (req.headers.get('X-Key') || u.searchParams.get('key')) !== env.NOTIFY_KEY) return out({ error: 'unauthorized' }, 401, 0);
      return out(await scalpCron(env, u.searchParams.get('all') === '1'), 200, 0);
    }
    if (p === '/run') {
      if (!env.NOTIFY_KEY || (req.headers.get('X-Key') || u.searchParams.get('key')) !== env.NOTIFY_KEY) return out({ error: 'unauthorized' }, 401, 0);
      return out(await cron(env), 200, 0);
    }
    return out(await iran(u.searchParams.get('debug')));
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(event.cron === '* * * * *' ? scalpCron(env, false) : cron(env));
  },
};
