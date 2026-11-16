// ============================================================
// Cloudflare Worker: پراکسی قیمت ایران + ثبت‌کننده‌ی ۲۴ساعته‌ی سیگنال اسکنر + تلگرام
// نیازها: KV با نام اتصال SIG | (اختیاری) متغیرهای TG_TOKEN و TG_CHAT و NOTIFY_KEY | Cron: */5 * * * *
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
const SCAN = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'ADAUSDT', 'NEARUSDT', 'SUIUSDT'];
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
  const hiL=[...P.hi,...Q.hi].filter(x=>x>price*1.0005),loL=[...P.lo,...Q.lo].filter(x=>x<price*.9995);
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
  if (!env.TG_TOKEN || !env.TG_CHAT) return;
  try {
    await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: env.TG_CHAT, text: String(text).slice(0, 900) }),
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
        msgs.push((e.status === 'win' ? '✅ ' : e.status === 'loss' ? '❌ ' : '⏱ ') + nm(e.sym) + ' ' + (e.side > 0 ? 'LONG' : 'SHORT') + ' بسته شد: ' + (e.status === 'win' ? 'TP1' : e.status === 'loss' ? 'SL' : 'منقضی'));
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
      msgs.push('📈 اسکنر: ' + nm(best.sym) + ' ' + (best.dir > 0 ? 'LONG' : 'SHORT') + ' | ورود ' + fa(s.entry, 4) + ' | SL ' + fa(s.sl, 4) + ' | TP1 ' + fa(s.tp1, 4) + ' | TP2 ' + fa(s.tp2, 4) + ' | امتیاز ' + best.score);
    }
  }
  if (dirty) { st.entries = E.slice(-500); st.ts = Date.now(); await env.SIG.put('journal', JSON.stringify(st)); }
  for (const m of msgs) await tg(env, m);
  return { scanned: Object.keys(D).length, opened: !!opened, changed: dirty, scores: ev.map((x) => [x.sym, x.score, x.reject || 'OK']) };
}

// ---------- مسیرها ----------
export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const u = new URL(req.url);
    const p = u.pathname.replace(/\/+$/, '') || '/';
    if (p === '/journal') {
      if (!env.SIG) return out({ error: 'KV binding SIG تنظیم نشده', entries: [] }, 200, 0);
      const raw = (await env.SIG.get('journal')) || '{"entries":[]}';
      return new Response(raw, { headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=20' } });
    }
    if (p === '/notify' && req.method === 'POST') {
      if (!env.NOTIFY_KEY || req.headers.get('X-Key') !== env.NOTIFY_KEY) return out({ error: 'unauthorized' }, 401, 0);
      let b = {}; try { b = await req.json(); } catch (e) {}
      if (!b.text) return out({ error: 'no text' }, 400, 0);
      await tg(env, '⚡ ' + String(b.text).slice(0, 500));
      return out({ ok: true }, 200, 0);
    }
    if (p === '/run') {
      if (!env.NOTIFY_KEY || (req.headers.get('X-Key') || u.searchParams.get('key')) !== env.NOTIFY_KEY) return out({ error: 'unauthorized' }, 401, 0);
      return out(await cron(env), 200, 0);
    }
    return out(await iran(u.searchParams.get('debug')));
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(cron(env));
  },
};
