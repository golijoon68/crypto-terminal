// ============================================================
// GOLBIT Worker v13: پراکسی ایران + اسکنر ۲۴ساعته + تلگرام + اشتراک + کاربر موقت + پیام مدیر
// نیازها: KV با نام اتصال SIG | NOTIFY_KEY (یا ADMIN_KEY) | TG_TOKEN + TG_CHAT
// پیشنهادی: D1 با نام اتصال DB (برای شمارنده‌ی دقیق آنلاین) | TRONGRID_KEY | ALLOWED_ORIGIN
// Cron Triggers: دو تا →  */5 * * * *  (اسکنر و دفترچه)   و   * * * * *  (اسکالپ هوشمند تا ۱۵ ارز + صف تلگرام)
// تلگرام فقط: اسکنر فرصت، پیشنهاد طلایی، و خطاهای سیستم (اسکالپ تکی پیام نمی‌دهد)
// ============================================================
const CORS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
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
const SC = { fund: {}, dom: { s: 0, l: 0, u: null } };
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
  const a = d.slice(0, -1).map((k) => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5], tb: +k[9] }));
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
const pctS = (n) => (Number.isFinite(n) ? (n >= 0 ? '+' : '') + n.toFixed(2) + '٪' : '—');
function dayVwap(a){const d0=Math.floor(a[a.length-1].t/864e5)*864e5,w=a.filter(x=>x.t>=d0);if(w.length<6)return null;const pv=w.reduce((t,x)=>t+(x.h+x.l+x.c)/3*x.v,0),vv=w.reduce((t,x)=>t+x.v,0);return vv>0?pv/vv:null}
function takerDelta(a,n){const w=a.slice(-n);if(!w.length||!w.every(x=>Number.isFinite(x.tb)))return null;const v=w.reduce((t,x)=>t+x.v,0);return v>0?w.reduce((t,x)=>t+(2*x.tb-x.v),0)/v:null}
// موتور اسکنر؛ دقیقاً هم‌ارز نسخه‌ی صفحه (خانواده‌ی قیمت + خانواده‌ی مستقل) + دامیننس تتر + سقف/کف RSI
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
  const c1h=D.h1.a.map(x=>x.c),n1=c1h.length-1,r1h=rsi(c1h);
  if(Number.isFinite(r1h)&&(d>0?r1h>75:r1h<25))rej(d>0?'اشباع خرید در ۱ساعته؛ ورود دیر':'اشباع فروش در ۱ساعته؛ ورود دیر');
  const den1=c1h.slice(n1-19).reduce((t,x,i,arr)=>i?t+Math.abs(x-arr[i-1]):t,0),er1=den1>0?Math.abs(c1h[n1]-c1h[n1-19])/den1:0;
  if(er1<.2)rej('بازار ۱ساعته رنج است (ER='+fa(er1,2)+')');
  if((price-c[n])*d>.8*A)rej('قیمت در جهت معامله پریده؛ منتظر پولبک یا کندل بعدی');
  let ps=Math.max(0,t4*d)*25+Math.max(0,t1*d)*15;
  if(trendOk)o.reasons.push('روند '+(d>0?'صعودی':'نزولی')+' در ۱ساعته و ۴ساعته');
  const dist=(price-e20[n])*d/A;
  if(dist<=.3&&dist>=-1.2){ps+=15;o.reasons.push('قیمت نزدیک EMA20 (پولبک سالم)')}
  else if(dist>1.5){ps-=10;o.warns.push('قیمت از EMA20 دور شده؛ احتمال تعقیب')}
  const st1=swingStruct(D.h1.a.slice(-150),3),st15=swingStruct(a.slice(-120),3);
  if(st1.dir*d>0){ps+=10;o.reasons.push('ساختار ۱ساعته: '+(d>0?'سقف و کف بالاتر (HH/HL)':'سقف و کف پایین‌تر (LH/LL)')+(st15.bos*d>0?' + شکست ساختار ۱۵دقیقه':''))}
  else if(st1.dir*d<0){ps-=10;o.warns.push('ساختار ۱ساعته خلاف جهت است')}
  if(H[n]*d>0&&(H[n]-H[n-1])*d>0){ps+=15;o.reasons.push('MACD هم‌جهت و در حال تقویت')}
  else if(H[n]*d>0)ps+=7;
  else{ps-=5;o.warns.push('مومنتوم ۱۵ دقیقه هنوز هم‌جهت نیست')}
  if(d>0?(r>=40&&r<=62):(r>=38&&r<=60)){ps+=10;o.reasons.push('RSI در محدوده سالم ('+fa(r,0)+')')}
  else if(d>0?r>66:r<34){ps-=5;o.warns.push('RSI نزدیک '+(d>0?'سقف':'کف')+' است ('+fa(r,0)+')؛ جا برای ادامه کم است')}
  const vw=dayVwap(a);if(vw){if((price-vw)*d>0){ps+=5;o.reasons.push('قیمت سمت درست VWAP روزانه')}else{ps-=5;o.warns.push('قیمت سمت غلط VWAP روزانه')}}
  ps=Math.min(ps,60);
  let ns=0,indep=0;
  const vAvg=a.slice(-21,-1).reduce((t,x)=>t+x.v,0)/20,vr=vAvg>0?a[n].v/vAvg:0;
  if(vr>=1.2){ns+=10;indep++;o.reasons.push('حجم بالاتر از میانگین ('+fa(vr,1)+' برابر)')}
  else if(vr<.6){ns-=5;o.warns.push('حجم ضعیف')}
  const td=takerDelta(a,8);
  if(td!=null){if(td*d>=.08){ns+=15;indep++;o.reasons.push('دلتای خریدار/فروشنده‌ی تهاجمی هم‌جهت ('+pctS(td*100)+')')}else if(td*d<=-.08){ns-=15;o.warns.push('جریان سفارش اجراشده خلاف جهت ('+pctS(td*100)+')')}}
  if(sym!=='BTCUSDT'){
    if(btcBias*d>=.4){ns+=10;o.reasons.push('بیت‌کوین هم‌جهت است')}
    else if(btcBias*d<=-.4){ns-=15;o.warns.push('بیت‌کوین خلاف جهت است')}
  }
  const fr=SC.fund[sym];
  if(Number.isFinite(fr)){
    const f=fr*100*d;
    if(f>.05){ns-=10;o.warns.push('فاندینگ در جهت معامله بالاست (ازدحام)')}
    else if(f<-.01){ns+=5;indep++;o.reasons.push('فاندینگ به نفع معامله')}
  }
  /* دامیننس تتر: زمینه‌ی کل بازار؛ فقط امتیاز کوچک، هرگز تأیید مستقل یا گیت نیست */
  const dm=SC.dom&&SC.dom.l;
  if(dm){
    if(dm*d>0){ns+=6;o.reasons.push('دامیننس تتر '+(dm>0?'در حال کاهش (ورود نقدینگی)':'در حال افزایش (فرار به تتر)')+'؛ هم‌جهت')}
    else{ns-=8;o.warns.push('دامیننس تتر '+(dm>0?'در حال کاهش':'در حال افزایش')+'؛ خلاف جهت')}
  }
  if(trendOk&&indep===0)rej('هیچ تأیید مستقل از قیمت نیست (حجم، جریان سفارش یا فاندینگ)');
  o.fam={price:ps,other:ns};
  const sc=ps+Math.max(ns,-40);
  o.score=Math.max(0,Math.min(100,Math.round(sc)));
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
  o.ctx={ap5:ap,er:er1,rsi:r,m2:null};
  o.setup={entry:price,maxEntry:price+d*.3*A,sl:price-d*risk,tp1,tp2,rr1,rr2,atrPct:ap,capped,level:Number.isFinite(near)?near:null,rsi:r,rsi1h:Number.isFinite(r1h)?r1h:null};
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
function sigMsg(kind, sym, dir, score, s, note, why) {
  const sc = kind === 'scalp', dv = SC.dom ? (sc ? SC.dom.s : SC.dom.l) : 0;
  const rs = Number.isFinite(s.rsi)
    ? '\n📉 RSI ' + Math.round(s.rsi) + (dir > 0
        ? ' | خروج: اگر RSI به ' + (sc ? 75 : 78) + ' یا بالاتر رسید و قیمت نزدیک هدف بود، سود را حفظ کن'
        : ' | خروج: اگر RSI به ' + (sc ? 25 : 22) + ' یا پایین‌تر رسید و قیمت نزدیک هدف بود، سود را حفظ کن') : '';
  const dm = dv ? '\n💵 دامیننس تتر ' + (dv > 0 ? 'در حال کاهش' : 'در حال افزایش') + ' (' + (dv * dir > 0 ? 'هم‌جهت' : 'خلاف جهت') + ')' : '';
  return (sc ? '⚡ اسکالپ' : '📈 اسکنر') + ' · ' + (dir > 0 ? '🟢 LONG' : '🔴 SHORT') + ' · ' + nm(sym) + '\n' +
    '🕒 ساعت تهران: ' + hm() + '\n' +
    '🎯 ورود: ' + pp(s.entry) + (s.maxEntry ? ' (حداکثر ورود ' + pp(s.maxEntry) + ')' : '') + '\n' +
    '🛑 SL: ' + pp(s.sl) + ' (' + pc(s.sl, s.entry) + ')\n' +
    '✅ TP1: ' + pp(s.tp1) + ' (' + pc(s.tp1, s.entry) + ')' + (s.tp2 ? ' | TP2: ' + pp(s.tp2) + ' (' + pc(s.tp2, s.entry) + ')' : '') + '\n' +
    '📊 امتیاز ' + score + (s.rr2 != null ? ' | RR ' + Number(s.rr2).toFixed(2) : '') + rs + dm +
    (why && why.length ? '\n🧠 ' + why.slice(0, 3).join(' · ') : '') + '\n' + note;
}


// ---------- کرون: اسکن + ارزیابی + ثبت ----------
async function cron(env) {
  if (!env.SIG) return { error: 'KV binding SIG تنظیم نشده' };
  const st = JSON.parse((await env.SIG.get('journal')) || '{"entries":[]}');
  const E = st.entries; let dirty = false; const msgs = [], pubs = [];
  for (const e of E.filter((x) => x.status === 'open')) {
    try {
      const d = await bj(`/api/v3/klines?symbol=${e.sym}&interval=15m&startTime=${e.t}&limit=1000`);
      for (const k of d) {
        const h = +k[2], l = +k[3];
        e.mfe = Math.max(e.mfe || 0, (e.side > 0 ? h - e.entry : e.entry - l) / e.entry * 100);
        e.mae = Math.max(e.mae || 0, (e.side > 0 ? e.entry - l : h - e.entry) / e.entry * 100);
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
  const SCL = await coinsOf(env, 'scan'), CH = 8, nch = Math.ceil(SCL.length / CH), rot = nch > 1 ? Math.floor(Date.now() / 300000) : 0;
  const chunk = SCL.filter((_, i) => Math.floor(i / CH) === rot % nch);
  try { const fr = await fetch('https://fapi.binance.com/fapi/v1/premiumIndex', { headers: { 'User-Agent': 'Mozilla/5.0' } }); if (fr.ok) (await fr.json()).forEach((x) => { SC.fund[x.symbol] = +x.lastFundingRate; }); } catch (_) {}
  SC.dom = await domUpdate(env);
  const res = await Promise.allSettled(chunk.map(async (s) => ({ s, m15: await kl(s, '15m', 200), h1: await kl(s, '1h', 210), h4: await kl(s, '4h', 210) })));
  const D = {}; res.forEach((r, i) => { if (r.status === 'fulfilled') D[chunk[i]] = r.value; });
  if (chunk.length && !Object.keys(D).length) await alertAdmin(env, 'scan-data', 'داده‌ی بازار (بایننس) برای اسکنر دریافت نمی‌شود؛ اسکنر فعلاً کور است.', 21600);
  let BT = D.BTCUSDT; if (!BT) { try { BT = { h1: await kl('BTCUSDT', '1h', 210), h4: await kl('BTCUSDT', '4h', 210) }; } catch (_) {} }
  const bb = BT ? 0.6 * tfTrend(BT.h4.a) + 0.4 * tfTrend(BT.h1.a) : 0;
  const ev = chunk.filter((s) => D[s]).map((s) => evalCoin(s, D[s], bb));
  if (env.SIG) for (const x of ev) if (!x.reject && x.score >= SC_MIN) { try { await env.SIG.put('sg:' + x.sym, JSON.stringify({ dir: x.dir, score: x.score, e: x.setup && x.setup.entry, t1: x.setup && x.setup.tp1, sl: x.setup && x.setup.sl, ts: Date.now() }), { expirationTtl: 10800 }); } catch (_) {} }
  const best = ev.filter((x) => !x.reject && x.score >= SC_MIN).sort((a, b) => b.score - a.score)[0];
  let opened = null;
  if (best && !E.some((e) => e.status === 'open' && e.sym === best.sym)) {
    const last = [...E].reverse().find((e) => e.sym === best.sym);
    if (!(last && last.side === best.dir && Date.now() - (last.closeT || last.t) < 15 * 60000)) {
      const s = best.setup;
      opened = { id: Date.now(), t: Date.now(), sym: best.sym, side: best.dir, entry: s.entry, tp: s.tp1, sl: s.sl, src: 'scan', ttl: 0, score: best.score, status: 'open', ctx: Object.assign({}, best.ctx, { dom: SC.dom.l }) };
      E.push(opened); dirty = true;
      let gm = '';
      try { const sg = env.SIG ? JSON.parse((await env.SIG.get('sc:' + best.sym + best.dir)) || 'null') : null; if (sg && typeof sg === 'object' && sg.e && best.score >= 70 && Date.now() - sg.ts < 20 * 60000 && coherePair(s, sg.e, best.dir) && (await goldOnce(env, best.sym, best.dir))) gm = '🌟🌟 پیشنهاد طلایی: اسکنر (' + best.score + ') و اسکالپ (' + sg.score + ') هم‌جهت 🌟🌟\n'; } catch (_) {}
      pubs.push(gm + sigMsg('scan', best.sym, best.dir, best.score, s, '⏳ اعتبار: تا رسیدن به TP/SL (حداکثر ۳ روز)', best.reasons));
    }
  }
  if (dirty) { st.entries = E.slice(-500); st.ts = Date.now(); await env.SIG.put('journal', JSON.stringify(st)); }
  if (msgs.length) await notifyAll(env, msgs.join('\n\n'));
  for (const m of pubs) await notifyAll(env, m);
  return { scanned: Object.keys(D).length, opened: !!opened, changed: dirty, scores: ev.map((x) => [x.sym, x.score, x.reject || 'OK']) };
}


// ============================================================
// اسکالپ هوشمند سمت سرور (وقتی برنامه بسته یا در پس‌زمینه است هم کار می‌کند)
// داده از REST بایننس: کندل ۱دقیقه‌ای با حجم خریدار تهاجمی (taker)، کندل ۵دقیقه‌ای و ۱ساعته، و عمق ۲۰ سطحی.
// هر دقیقه نیمی از ارزها بررسی می‌شوند (سقف ۵۰ درخواست در پلن رایگان)؛ هر ارز هر ۲ دقیقه یک بار.
// ============================================================
const SCALP = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','LINKUSDT'];
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
function scalpEvalS(sym, K1, K5, H1, dp, fr, costPct, dom) {
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
  add('دامیننس تتر (زمینه)', 3, dom ? dom.s : 0, 'ctx');
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
    { const m2 = (mid / c5[Math.max(0, n5 - 24)] - 1) * 100 * dd, rs = rsi(c5), ap = A5 / mid * 100, ext = m2 > 10 * ap || (rs != null && (dd < 0 ? rs < 30 : rs > 70));
      R.rsi = rs; gate('بدون کشیدگی (حرکت بزرگ هم‌جهت یا RSI اشباع)', !ext, (m2 >= 0 ? '+' : '') + m2.toFixed(2) + '% در ۲ساعت | RSI ' + (rs == null ? '—' : Math.round(rs))); }
    R.gateOk = R.gate.every((x) => x.ok); }
  const d = R.dir, l8 = a1.slice(-8), sw = d > 0 ? Math.min(...l8.map((x) => x.l)) : Math.max(...l8.map((x) => x.h));
  let risk = d > 0 ? mid - (sw - .1 * A5) : (sw + .1 * A5) - mid; risk = Math.max(risk, .8 * A5);
  const cost = mid * (costPct / 100), rr2 = (2.5 * risk - cost) / (risk + cost);
  const lv = sigLevels(a5.slice(-96), 3, A5, 1); lv.hi.push(Math.max(...a5.slice(-96).map((x) => x.h))); lv.lo.push(Math.min(...a5.slice(-96).map((x) => x.l))); const near = d > 0 ? Math.min(Infinity, ...lv.hi.filter((x) => x > mid * 1.0002)) : Math.max(-Infinity, ...lv.lo.filter((x) => x < mid * .9998)), room = Number.isFinite(near) ? (d > 0 ? near - mid : mid - near) : Infinity;
  if (risk > 1.6 * A5) R.why = 'حد ضرر منطقی دور است (ورود دیر)';
  else if (room < 1.2 * risk) R.why = (d > 0 ? 'مقاومت' : 'حمایت') + ' نزدیک است';
  else if (rr2 < 1.5) R.why = 'حرکت قابل‌انتظار نسبت به کارمزد کوچک است';
  let t1 = mid + d * 1.5 * risk; if (Number.isFinite(room) && room < 1.5 * risk) t1 = mid + d * (room - .1 * A5);
  R.setup = { entry: mid, maxEntry: mid + d * .15 * A5, sl: mid - d * risk, tp1: t1, tp2: mid + d * 2.5 * risk, rr2, rsi: R.rsi };
  if (!R.gateOk) R.why = 'گیت رد شد: ' + R.gate.filter((x) => !x.ok).map((x) => x.name).join('، ');
  else if (R.score < SCALP_MIN_SCORE) R.why = 'قدرت سیگنال کمتر از ' + SCALP_MIN_SCORE;
  R.ok = R.gateOk && R.score >= SCALP_MIN_SCORE && !R.why;
  return R;
}
async function scalpCron(env, all) {
  if (env.SIG && env.TG_TOKEN) { try { await tgDrain(env, 10); } catch (_) {} }
  const SL = await coinsOf(env, 'scalp');
  const nslot = SL.length > 8 ? 3 : 2, slot = Math.floor(Date.now() / 60000) % nslot;
  const list = all ? SL : SL.filter((_, i) => i % nslot === slot);
  const costPct = parseFloat(env.SCALP_COST) || .12;
  const fund = {};
  try { const r = await fetch('https://fapi.binance.com/fapi/v1/premiumIndex', { headers: { 'User-Agent': 'Mozilla/5.0' } }); if (r.ok) (await r.json()).forEach((x) => { fund[x.symbol] = +x.lastFundingRate * 100; }); } catch (e) {}
  const dom = await domUpdate(env); SC.dom = dom;
  const out = [];
  await Promise.allSettled(list.map(async (sym) => {
    try {
      const [K1, K5, H1, dp] = await Promise.all([klr(sym, '1m', 100), klr(sym, '5m', 100), klr(sym, '1h', 100), bj(`/api/v3/depth?symbol=${sym}&limit=20`)]);
      out.push(scalpEvalS(sym, K1, K5, H1, dp, fund[sym], costPct, dom));
    } catch (e) { out.push({ sym, ok: false, score: 0, why: 'داده دریافت نشد' }); }
  }));
  if (out.length && out.every((x) => x.why === 'داده دریافت نشد')) await alertAdmin(env, 'data', 'داده‌ی بازار (بایننس) دریافت نمی‌شود. موتور اسکالپ فعلاً کور است.', 21600);
  const sent = [];
  for (const R of out.filter((x) => x.ok && x.score >= 65).sort((a, b) => b.score - a.score)) {
    const key = 'sc:' + R.sym + R.dir;
    if (env.SIG) { if (await env.SIG.get(key)) continue; await env.SIG.put(key, JSON.stringify({ e: R.setup.entry, sl: R.setup.sl, t1: R.setup.tp1, ts: Date.now(), score: R.score }), { expirationTtl: 900 }); }
    const s = R.setup;
    let gold = null;
    if (env.SIG) { try { const g = JSON.parse((await env.SIG.get('sg:' + R.sym)) || 'null'); if (g && g.dir === R.dir && g.score >= 70 && cohere(g, R)) gold = g; } catch (_) {} }
    if (gold && (await goldOnce(env, R.sym, R.dir))) await notifyAll(env, '🌟🌟 پیشنهاد طلایی: اسکنر (' + gold.score + ') و اسکالپ (' + R.score + ') هم‌جهت 🌟🌟\n' + sigMsg('scalp', R.sym, R.dir, R.score, s, '⏳ ورود اسکالپ: ۲۰ دقیقه از همین ساعت'));
    sent.push(R.sym);
  }
  return { scanned: list.length, signals: sent, dom: dom, scores: out.map((x) => [x.sym, x.score, x.dir, x.ok ? 'OK' : x.why]) };
}

const ONL = new Map(); // شمارنده‌ی آنلاین (تقریبی؛ در حافظه‌ی Worker)
// ---------- مسیرها ----------
// ===== اشتراک: ۲۴ ساعت رایگان، بعد پرداخت USDT (TRC20) با تأیید خودکار از روی بلاک‌چین =====
// پلن‌ها و آدرس کیف پول پایین هستند. متغیرهای اختیاری Worker: LIC_WALLET، TRIAL_H، TRONGRID_KEY، ADMIN_KEY (یا NOTIFY_KEY).
const WALLET_DEFAULT = 'TMiRbjMb4dwzcwmZcbC5hfuDnwctRY2aAN';
const PLANS = { m1: { price: 9.99, days: 30 }, m3: { price: 26.99, days: 90 }, y1: { price: 89.99, days: 365 } };
const USDT_TRC20 = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
// ===== تلگرام کاربران، کد مهمان، حضور آنلاین (D1) =====
const hexSha = async (s) => {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
};
let BOTNAME = null, DBREADY = false;
const expOf = (rec) => (rec.admin ? 4e12 : Math.max(rec.paidUntil || 0, rec.trialEnd || 0));
const coherePair = (A, p, dir) => !!(A && A.entry && p && Math.abs(p / A.entry - 1) <= 0.012 && (dir > 0 ? p < A.tp1 && p > A.sl : p > A.tp1 && p < A.sl));
async function botName(env) {
  if (env.TG_BOT) return String(env.TG_BOT).replace(/^@/, '');
  if (BOTNAME) return BOTNAME;
  if (!env.TG_TOKEN) return '';
  try { const r = await (await fetch('https://api.telegram.org/bot' + env.TG_TOKEN + '/getMe')).json(); BOTNAME = (r.result && r.result.username) || ''; } catch (_) {}
  return BOTNAME || '';
}
const tgIdx = async (env) => { try { return JSON.parse((await env.SIG.get('tgi')) || '{}'); } catch (_) { return {}; } };
async function tgSync(env, uid, rec) {
  try { const I = await tgIdx(env); if (I[uid]) { I[uid].e = expOf(rec); await env.SIG.put('tgi', JSON.stringify(I)); } } catch (_) {}
}
const sendTo = (env, chat, text) =>
  fetch('https://api.telegram.org/bot' + env.TG_TOKEN + '/sendMessage', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text: String(text).slice(0, 3500), disable_web_page_preview: true }),
  }).catch(() => null);
const TGQ = 'tgq';
async function tgPrune(env, chats) {
  try {
    if (!chats.length) return;
    const I = await tgIdx(env); let ch = false;
    for (const k of Object.keys(I)) if (chats.includes(String(I[k].c))) { delete I[k]; await env.SIG.delete('tg:' + k); ch = true; }
    if (ch) await env.SIG.put('tgi', JSON.stringify(I));
  } catch (_) {}
}
async function tgSendBatch(env, chats, text) {
  const dead = [];
  await Promise.allSettled(chats.map(async (c) => { const r = await sendTo(env, c, text); if (r && r.status === 403) dead.push(String(c)); }));
  if (dead.length) await tgPrune(env, dead);
}
// ۶ نفر اول همان لحظه، بقیه در صف (هر دقیقه ۱۰ نفر)؛ محدودیت ۵۰ درخواست در پلن رایگان رعایت می‌شود
async function tgUsers(env, text) {
  if (!env.SIG || !env.TG_TOKEN) return;
  const I = await tgIdx(env), now = Date.now();
  const ids = [...new Set(Object.values(I).filter((x) => x.e > now).map((x) => x.c))];
  if (!ids.length) return;
  await tgSendBatch(env, ids.slice(0, 6), text);
  const rest = ids.slice(6);
  if (rest.length) {
    let q = []; try { q = JSON.parse((await env.SIG.get(TGQ)) || '[]'); } catch (_) {}
    q.push({ r: rest, x: String(text).slice(0, 3500), t: now });
    await env.SIG.put(TGQ, JSON.stringify(q.slice(-20)), { expirationTtl: 3600 });
  }
}
async function tgDrain(env, max) {
  let q = []; try { q = JSON.parse((await env.SIG.get(TGQ)) || '[]'); } catch (_) {}
  if (!q.length) return;
  const now = Date.now(); q = q.filter((it) => now - it.t <= 1800000 && it.r.length);
  let left = max;
  for (const it of q) { if (left <= 0) break; const take = it.r.splice(0, left); left -= take.length; await tgSendBatch(env, take, it.x); }
  q = q.filter((it) => it.r.length);
  await env.SIG.put(TGQ, JSON.stringify(q), { expirationTtl: 3600 });
}
async function notifyAll(env, text) { await tg(env, text); await tgUsers(env, text); }
// هشدار خطا فقط برای مدیر؛ هر نوع خطا در بازه‌ی ttl یک‌بار
async function alertAdmin(env, key, text, ttl) {
  try {
    if (env.SIG) { if (await env.SIG.get('al:' + key)) return; await env.SIG.put('al:' + key, '1', { expirationTtl: Math.max(60, ttl || 21600) }); }
    await tg(env, '⚠️ ' + text);
  } catch (_) {}
}
async function goldOnce(env, sym, dir) {
  if (!env.SIG) return true;
  const k = 'gd:' + sym + dir;
  if (await env.SIG.get(k)) return false;
  await env.SIG.put(k, '1', { expirationTtl: 1800 });
  return true;
}
// ===== دامیننس تتر (USDT.D): زمینه‌ی کل بازار. کاهش = ورود نقدینگی (به نفع لانگ)، افزایش = فرار به تتر (به نفع شورت)
let DOMC = null;
function domCtxOf(h, now) {
  const cur = h[h.length - 1];
  if (!cur || now - cur.t > 30 * 60000) return { s: 0, l: 0, u: null };
  const pick = (a, b) => h.find((x) => now - x.t >= a && now - x.t <= b);
  const rs = pick(40 * 60000, 100 * 60000), rl = pick(150 * 60000, 260 * 60000);
  const s = rs ? (cur.u - rs.u <= -0.05 ? 1 : cur.u - rs.u >= 0.05 ? -1 : 0) : 0;
  const l = rl ? (cur.u - rl.u <= -0.08 ? 1 : cur.u - rl.u >= 0.08 ? -1 : 0) : 0;
  return { s, l, u: cur.u };
}
async function domUpdate(env) {
  const now = Date.now();
  if (DOMC && now - DOMC.t < 120000) return DOMC.v;
  let st = { h: [] };
  try { if (env.SIG) st = JSON.parse((await env.SIG.get('dom')) || '{"h":[]}'); } catch (_) {}
  if (!Array.isArray(st.h)) st.h = [];
  const last = st.h[st.h.length - 1];
  if (env.SIG && (!last || now - last.t > 10 * 60000)) {
    try {
      const r = await fetch('https://api.coingecko.com/api/v3/global', { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } });
      if (r.ok) {
        const g = (await r.json()).data, u = g && g.market_cap_percentage && g.market_cap_percentage.usdt;
        if (Number.isFinite(u)) { st.h.push({ t: now, u }); st.h = st.h.filter((x) => now - x.t < 6 * 36e5).slice(-50); await env.SIG.put('dom', JSON.stringify(st)); }
      }
    } catch (_) {}
  }
  const v = domCtxOf(st.h, now);
  DOMC = { t: now, v };
  return v;
}
async function adminGate(req, u, env, kv, ip) {
  const fk = 'af:' + ip, fails = parseInt((await kv.get(fk)) || '0', 10), ak = env.ADMIN_KEY || env.NOTIFY_KEY;
  if (!ak) return out({ error: 'رمز مدیر در Worker تنظیم نشده (ADMIN_KEY)' }, 403, 0);
  if (fails >= 8) return out({ error: 'تلاش بیش از حد؛ ۱۰ دقیقه بعد دوباره امتحان کن' }, 429, 0);
  if (!safeEq(req.headers.get('X-Key') || u.searchParams.get('key'), ak)) { await kv.put(fk, String(fails + 1), { expirationTtl: 600 }); return out({ error: 'رمز اشتباه است' }, 401, 0); }
  return null;
}
async function tgRoutes(p, u, req, env) {
  const kv = env.SIG;
  if (!kv) return out({ error: 'KV تنظیم نشده' }, 500, 0);
  const ip = req.headers.get('CF-Connecting-IP') || 'x';
  const uidOf = (x) => { x = String(x || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 32); return x.length >= 12 ? x : ''; };
  if (p === '/tg/info') return out({ bot: await botName(env) }, 200, 60);
  if (p === '/tg/status') { const uid = uidOf(u.searchParams.get('uid')); if (!uid) return out({ error: 'کد نامعتبر' }, 400, 0); return out({ linked: !!(await kv.get('tg:' + uid)) }, 200, 0); }
  if (p === '/tg/unlink') {
    const uid = uidOf(u.searchParams.get('uid')); if (!uid) return out({ error: 'کد نامعتبر' }, 400, 0);
    const I = await tgIdx(env); delete I[uid]; await kv.put('tgi', JSON.stringify(I)); await kv.delete('tg:' + uid);
    return out({ ok: true }, 200, 0);
  }
  if (p === '/tg/test') {
    const uid = uidOf(u.searchParams.get('uid')); if (!uid) return out({ error: 'کد نامعتبر' }, 400, 0);
    const c = await kv.get('tg:' + uid); if (!c) return out({ ok: false, error: 'تلگرام وصل نیست' }, 200, 0);
    const rk = 'tt:' + uid; if (await kv.get(rk)) return out({ ok: false, error: 'چند دقیقه بعد دوباره امتحان کن' }, 200, 0);
    await kv.put(rk, '1', { expirationTtl: 120 });
    await sendTo(env, c, '✅ پیام آزمایشی GOLBIT: اتصال تلگرام درست کار می‌کند.');
    return out({ ok: true }, 200, 0);
  }
  if (p === '/tg/setup') {
    const bad = await adminGate(req, u, env, kv, ip); if (bad) return bad;
    if (!env.TG_TOKEN) return out({ error: 'TG_TOKEN تنظیم نشده' }, 400, 0);
    const secret = (await hexSha(env.TG_TOKEN + ':wh')).slice(0, 40);
    const r = await (await fetch('https://api.telegram.org/bot' + env.TG_TOKEN + '/setWebhook', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: u.origin + '/tg/webhook', secret_token: secret, allowed_updates: ['message'] }) })).json();
    return out({ webhook: r, bot: await botName(env) }, 200, 0);
  }
  if (p === '/tg/webhook' && req.method === 'POST') {
    if (!env.TG_TOKEN) return out({ error: 'no token' }, 400, 0);
    const secret = (await hexSha(env.TG_TOKEN + ':wh')).slice(0, 40);
    if (!safeEq(req.headers.get('X-Telegram-Bot-Api-Secret-Token') || '', secret)) return out({ error: 'forbidden' }, 403, 0);
    let up = {}; try { up = await req.json(); } catch (_) {}
    const m = up.message;
    if (!m || !m.chat || typeof m.text !== 'string') return out({ ok: true }, 200, 0);
    const chat = m.chat.id, txt = m.text.trim();
    if (txt.startsWith('/start')) {
      const code = uidOf(txt.split(/\s+/)[1]);
      if (!code) { await sendTo(env, chat, 'سلام 👋 به GOLBIT خوش آمدی.\nبرای دریافت هشدار، از داخل برنامه دکمه‌ی «اتصال تلگرام» را بزن تا همین‌جا باز شود.'); return out({ ok: true }, 200, 0); }
      const rec = JSON.parse((await kv.get('u:' + code)) || 'null');
      if (!rec) { await sendTo(env, chat, 'این کد معتبر نیست. برنامه را باز کن و دوباره از دکمه‌ی «اتصال تلگرام» استفاده کن.'); return out({ ok: true }, 200, 0); }
      await kv.put('tg:' + code, String(chat));
      const I = await tgIdx(env); I[code] = { c: chat, e: expOf(rec) };
      const ks = Object.keys(I); if (ks.length > 3000) delete I[ks[0]];
      await kv.put('tgi', JSON.stringify(I));
      await sendTo(env, chat, '✅ وصل شد!\nاز این به بعد «پیشنهاد طلایی» و سیگنال‌های «اسکنر فرصت» اینجا برایت می‌آید.\nبرای قطع کردن: /stop');
    } else if (txt.startsWith('/stop')) {
      const I = await tgIdx(env); let n = 0;
      for (const k of Object.keys(I)) if (String(I[k].c) === String(chat)) { delete I[k]; await kv.delete('tg:' + k); n++; }
      await kv.put('tgi', JSON.stringify(I));
      await sendTo(env, chat, n ? 'قطع شد. هر وقت خواستی دوباره از برنامه وصل کن.' : 'این حساب به برنامه وصل نبود.');
    }
    return out({ ok: true }, 200, 0);
  }
  return out({ error: 'مسیر ناشناخته' }, 404, 0);
}

async function lic(p, u, req, env) {
  if (p === '/lic/acct' || p === '/lic/login') return acctRoutes(p, u, req, env);
  const uid = String(u.searchParams.get('uid') || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 32);
  if (uid.length < 12) return out({ error: 'کد نامعتبر' }, 400, 0);
  const kv = env.SIG, now = Date.now(), WALLET = env.LIC_WALLET || WALLET_DEFAULT, TH = parseFloat(env.TRIAL_H || '24');
  const rec = JSON.parse((await kv.get('u:' + uid)) || 'null') || {};
  const save = () => kv.put('u:' + uid, JSON.stringify(rec));
  const state = () => {
    const paid = rec.paidUntil && rec.paidUntil > now, trial = rec.trialEnd && rec.trialEnd > now;
    return { state: paid ? 'paid' : trial ? 'trial' : rec.trialEnd || rec.paidUntil ? 'expired' : 'new', until: paid ? rec.paidUntil : trial ? rec.trialEnd : 0, now, admin: !!rec.admin };
  };
  // محدودیت ۲ دستگاه برای هر کد اشتراک (جلوگیری از اشتراک‌گذاری کد)
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
    // چند کاربر ایرانی پشت یک IP مشترک (اینترنت موبایل) هستند؛ پس تا ۵ دوره‌ی رایگان در ماه برای هر IP مجاز است
    const ik = 'tc:' + (req.headers.get('CF-Connecting-IP') || 'x'), cnt = parseInt((await kv.get(ik)) || '0', 10);
    if (cnt >= 5) { rec.trialEnd = 1; await save(); return out({ ...state(), reason: 'ip' }, 200, 0); }
    rec.trialEnd = now + TH * 3600e3;
    await save();
    await kv.put(ik, String(cnt + 1), { expirationTtl: 30 * 86400 });
    return out(state(), 200, 0);
  }
  if (p === '/lic/admin') {
    const ak = env.ADMIN_KEY || env.NOTIFY_KEY, ip = req.headers.get('CF-Connecting-IP') || 'x', fk = 'af:' + ip;
    if (!ak) return out({ error: 'رمز مدیر در Worker تنظیم نشده (متغیر ADMIN_KEY یا NOTIFY_KEY)' }, 403, 0);
    const fails = parseInt((await kv.get(fk)) || '0', 10);
    if (fails >= 8) return out({ error: 'تلاش بیش از حد؛ ۱۰ دقیقه بعد دوباره امتحان کن' }, 429, 0);
    if (!safeEq(req.headers.get('X-Key') || u.searchParams.get('key'), ak)) { await kv.put(fk, String(fails + 1), { expirationTtl: 600 }); return out({ error: 'رمز اشتباه است' }, 401, 0); }
    rec.paidUntil = now + 3650 * 864e5; rec.admin = true;
    await save(); await tgSync(env, uid, rec);
    return out({ ...state(), admin: true }, 200, 0);
  }
  // ---- کد مهمان (ورود موقت) ----
  const ipx = req.headers.get('CF-Connecting-IP') || 'x';
  if (p === '/lic/gift') {
    const bad = await adminGate(req, u, env, kv, ipx); if (bad) return bad;
    const op = u.searchParams.get('op') || 'list';
    const readI = async () => { try { return JSON.parse((await kv.get('gci')) || '[]'); } catch (_) { return []; } };
    if (op === 'create') {
      const days = Math.min(Math.max(parseInt(u.searchParams.get('days') || '7', 10) || 7, 1), 365);
      const name = String(u.searchParams.get('name') || '').replace(/[<>\u0000-\u001f]/g, ' ').trim().slice(0, 30);
      const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; let code = 'G';
      crypto.getRandomValues(new Uint8Array(7)).forEach((b) => { code += A[b % A.length]; });
      await kv.put('gc:' + code, JSON.stringify({ name, days, t: now }), { expirationTtl: 60 * 86400 });
      const I = await readI(); I.unshift({ code, name, days, t: now }); await kv.put('gci', JSON.stringify(I.slice(0, 60)));
      return out({ ok: true, code, days, name }, 200, 0);
    }
    if (op === 'list') {
      const I = (await readI()).slice(0, 25);
      const list = await Promise.all(I.map(async (x) => { let g = null; try { g = JSON.parse((await kv.get('gc:' + x.code)) || 'null'); } catch (_) {} return { ...x, status: !g ? 'expired' : g.revoked ? 'revoked' : g.used ? 'used' : 'new', until: (g && g.until) || 0 }; }));
      return out({ list }, 200, 0);
    }
    if (op === 'revoke') {
      const code = String(u.searchParams.get('code') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
      const g = JSON.parse((await kv.get('gc:' + code)) || 'null');
      if (g) {
        g.revoked = true;
        if (g.used) { const r2 = JSON.parse((await kv.get('u:' + g.used)) || 'null'); if (r2) { r2.paidUntil = now - 1; await kv.put('u:' + g.used, JSON.stringify(r2)); await tgSync(env, g.used, r2); } }
        await kv.put('gc:' + code, JSON.stringify(g), { expirationTtl: 60 * 86400 });
      }
      return out({ ok: true }, 200, 0);
    }
    return out({ error: 'عملیات ناشناخته' }, 400, 0);
  }
  if (p === '/lic/redeem') {
    const rk = 'rr:' + ipx, tries = parseInt((await kv.get(rk)) || '0', 10);
    if (tries >= 10) return out({ error: 'تلاش بیش از حد؛ بعداً دوباره امتحان کن' }, 429, 0);
    const code = String(u.searchParams.get('code') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
    const g = code ? JSON.parse((await kv.get('gc:' + code)) || 'null') : null;
    if (!g || g.used || g.revoked) { await kv.put(rk, String(tries + 1), { expirationTtl: 3600 }); return out({ error: 'کد نامعتبر است یا قبلاً استفاده شده' }, 200, 0); }
    rec.paidUntil = Math.max(now, rec.paidUntil || 0) + g.days * 86400e3; rec.gift = g.name || 'guest';
    g.used = uid; g.usedAt = now; g.until = rec.paidUntil;
    await kv.put('gc:' + code, JSON.stringify(g), { expirationTtl: 60 * 86400 });
    await save(); await tgSync(env, uid, rec);
    return out({ ...state(), redeemed: true, days: g.days }, 200, 0);
  }
  if (p === '/lic/start') {
    const plan = PLANS[u.searchParams.get('plan')] ? u.searchParams.get('plan') : 'm1', P = PLANS[plan];
    let micro = rec.plan === plan && rec.pay && rec.payTs && now - rec.payTs < 72 * 3600e3 ? rec.pay : 0;
    if (!micro) {
      if (rec.pay) await kv.delete('pm:' + rec.pay);
      for (let i = 0; i < 40 && !micro; i++) {
        const m = Math.round(P.price * 1e6) + (1 + Math.floor(Math.random() * 999)) * 100, holder = await kv.get('pm:' + m);
        if (!holder || holder === uid) { micro = m; await kv.put('pm:' + m, uid, { expirationTtl: 72 * 3600 }); }
      }
      if (!micro) return out({ error: 'شلوغ است؛ دوباره تلاش کن' }, 503, 0);
      rec.pay = micro; rec.payTs = now; rec.plan = plan; await save();
    }
    return out({ wallet: WALLET, network: 'TRC20', amount: micro / 1e6, price: P.price, days: P.days, plan }, 200, 0);
  }
  if (p === '/lic/check') {
    if (!rec.pay) return out({ ...state(), paid: false }, 200, 0);
    const r = await fetch('https://api.trongrid.io/v1/accounts/' + WALLET + '/transactions/trc20?only_to=true&only_confirmed=true&limit=200&contract_address=' + USDT_TRC20 + '&min_timestamp=' + (now - 96 * 3600e3),
      { headers: env.TRONGRID_KEY ? { 'TRON-PRO-API-KEY': env.TRONGRID_KEY } : {} });
    if (!r.ok) { await alertAdmin(env, 'tron', 'TronGrid پاسخ نداد (HTTP ' + r.status + ')؛ تأیید خودکار پرداخت‌ها کار نمی‌کند. متغیر TRONGRID_KEY را بررسی کن.', 21600); return out({ ...state(), paid: false, error: 'خطا در خواندن بلاک‌چین (HTTP ' + r.status + ')' }, 200, 0); }
    const list = (await r.json()).data || [];
    const hit = list.find((t) => t.to === WALLET && t.token_info && t.token_info.address === USDT_TRC20 && Number(t.value) === rec.pay && t.block_timestamp >= rec.payTs - 3600e3);
    if (!hit) return out({ ...state(), paid: false }, 200, 0);
    const used = await kv.get('x:' + hit.transaction_id);
    if (used && used !== uid) return out({ ...state(), paid: false, error: 'این تراکنش برای کد دیگری ثبت شده' }, 200, 0);
    if (!used) {
      await kv.put('x:' + hit.transaction_id, uid);
      rec.paidUntil = Math.max(now, rec.paidUntil || 0) + (PLANS[rec.plan] || PLANS.m1).days * 86400e3;
      await kv.delete('pm:' + rec.pay);
      rec.pay = 0;
      await save(); await tgSync(env, uid, rec);
    }
    return out({ ...state(), paid: true }, 200, 0);
  }
  return out({ error: 'مسیر ناشناخته' }, 404, 0);
}

// ===== حساب کاربر موقت: نام کاربری + رمز + مهلت (از اولین ورود شروع می‌شود) =====
async function acctRoutes(p, u, req, env) {
  const kv = env.SIG, now = Date.now(), ip = req.headers.get('CF-Connecting-IP') || 'x';
  if (!kv) return out({ error: 'KV تنظیم نشده' }, 500, 0);
  let body = {}; if (req.method === 'POST') { try { body = await req.json(); } catch (_) {} }
  const SAFE = 'abcdefghjkmnpqrstuvwxyz23456789', IDS = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const rnd = (n, set) => { let t = ''; crypto.getRandomValues(new Uint8Array(n)).forEach((b) => { t += set[b % set.length]; }); return t; };
  const uname = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9_.-]/g, '').slice(0, 20);
  const pbk = async (pass, salt) => {
    const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveBits']);
    const b = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(salt), iterations: 20000 }, k, 256);
    return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
  };
  const readI = async () => { try { return JSON.parse((await kv.get('aci')) || '[]'); } catch (_) { return []; } };
  const getA = async (user) => { try { return JSON.parse((await kv.get('ua:' + user)) || 'null'); } catch (_) { return null; } };
  if (p === '/lic/acct') {
    const bad = await adminGate(req, u, env, kv, ip); if (bad) return bad;
    const op = String(body.op || u.searchParams.get('op') || 'list');
    if (op === 'create') {
      const days = Math.min(Math.max(parseInt(body.days || '7', 10) || 7, 1), 365);
      const name = String(body.name || '').replace(/[<>\u0000-\u001f]/g, ' ').trim().slice(0, 30);
      let user = uname(body.user); const explicit = !!user;
      if (!user) { for (let i = 0; i < 6; i++) { const t = 'g' + rnd(5, SAFE); if (!(await kv.get('ua:' + t))) { user = t; break; } } }
      if (!user) return out({ error: 'ساخت نام کاربری ناموفق بود؛ دوباره امتحان کن' }, 500, 0);
      if (explicit && (await kv.get('ua:' + user))) return out({ error: 'این نام کاربری قبلاً وجود دارد' }, 200, 0);
      let pass = String(body.pass || '').trim().slice(0, 40);
      if (pass && pass.length < 6) return out({ error: 'رمز دست‌کم ۶ نویسه باشد' }, 200, 0);
      if (!pass) pass = rnd(8, SAFE);
      const salt = rnd(14, IDS);
      const ac = { h: await pbk(pass, salt), s: salt, days, name, t: now, uid: rnd(20, IDS), first: 0, until: 0 };
      await kv.put('ua:' + user, JSON.stringify(ac));
      const I = await readI(); I.unshift({ user, name, days, t: now }); await kv.put('aci', JSON.stringify(I.slice(0, 80)));
      return out({ ok: true, user, pass, days, name }, 200, 0);
    }
    if (op === 'list') {
      const I = (await readI()).slice(0, 25);
      const list = await Promise.all(I.map(async (x) => {
        const a = await getA(x.user);
        const status = !a ? 'deleted' : a.revoked ? 'revoked' : !a.first ? 'new' : a.until > now ? 'active' : 'expired';
        return { user: x.user, name: x.name, days: x.days, t: x.t, status, until: (a && a.until) || 0, first: (a && a.first) || 0 };
      }));
      return out({ list }, 200, 0);
    }
    if (op === 'revoke' || op === 'extend') {
      const user = uname(body.user), ac = await getA(user);
      if (!ac) return out({ error: 'پیدا نشد' }, 200, 0);
      if (op === 'revoke') { ac.revoked = true; ac.until = now - 1; }
      else { const d = Math.min(Math.max(parseInt(body.days || '7', 10) || 7, 1), 365); if (ac.first) ac.until = Math.max(ac.until, now) + d * 864e5; else ac.days += d; ac.revoked = false; }
      await kv.put('ua:' + user, JSON.stringify(ac));
      const rec = JSON.parse((await kv.get('u:' + ac.uid)) || 'null');
      if (rec) { rec.paidUntil = ac.until; await kv.put('u:' + ac.uid, JSON.stringify(rec)); await tgSync(env, ac.uid, rec); }
      return out({ ok: true }, 200, 0);
    }
    return out({ error: 'عملیات ناشناخته' }, 400, 0);
  }
  // ورود کاربر
  const rk = 'lg:' + ip, tries = parseInt((await kv.get(rk)) || '0', 10);
  if (tries >= 8) return out({ error: 'تلاش بیش از حد؛ یک ساعت بعد دوباره امتحان کن' }, 429, 0);
  const fail = async (m) => { await kv.put(rk, String(tries + 1), { expirationTtl: 3600 }); return out({ error: m || 'نام کاربری یا رمز اشتباه است' }, 200, 0); };
  const user = uname(body.user), pass = String(body.pass || '').slice(0, 60);
  if (!user || !pass) return fail();
  const ac = await getA(user);
  if (!ac || ac.revoked) return fail();
  if (!safeEq(await pbk(pass, ac.s), ac.h)) return fail();
  if (!ac.first) { ac.first = now; ac.until = now + ac.days * 864e5; await kv.put('ua:' + user, JSON.stringify(ac)); }
  if (ac.until <= now) return out({ error: 'مهلت این حساب تمام شده است' }, 200, 0);
  const dev = String(u.searchParams.get('dev') || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 24);
  const rec = JSON.parse((await kv.get('u:' + ac.uid)) || 'null') || {};
  rec.devs = rec.devs || [];
  if (dev && !rec.devs.includes(dev)) { if (rec.devs.length >= 2) return out({ error: 'این حساب روی ۲ دستگاه فعال است' }, 200, 0); rec.devs.push(dev); }
  rec.paidUntil = ac.until; rec.gift = 'acct:' + user;
  await kv.put('u:' + ac.uid, JSON.stringify(rec)); await tgSync(env, ac.uid, rec);
  return out({ ok: true, uid: ac.uid, until: ac.until, days: ac.days }, 200, 0);
}

// ===== فهرست ارزها (از داشبورد تنظیم می‌شود) و چرخش اسکنر =====
let CC = null;
async function coinsOf(env, kind) {
  try {
    if (!CC || Date.now() - CC.t > 300000) CC = { t: Date.now(), d: env.SIG ? JSON.parse((await env.SIG.get('coins')) || 'null') : null };
    const a = CC.d && CC.d[kind];
    if (Array.isArray(a)) { const ok = a.filter((s) => /^[A-Z0-9]{2,12}USDT$/.test(s)).slice(0, 15); if (ok.length) return ok; }
  } catch (_) {}
  return kind === 'scan' ? SCAN : SCALP;
}
async function rotate(env, key) {
  if (!env.SIG) return 0;
  const n = (parseInt(await env.SIG.get(key), 10) || 0) + 1;
  await env.SIG.put(key, String(n));
  return n;
}

// ===== امنیت و گفتگو با مدیر =====
const safeEq = (a, b) => {
  a = String(a || ''); b = String(b || '');
  if (!b) return false;
  let d = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return d === 0;
};
const cohere = (g, R) => {
  const p = R.setup && R.setup.entry;
  if (!p || !g.e || !g.t1 || !g.sl || Date.now() - (g.ts || 0) > 90 * 60000) return false;
  if (Math.abs(p / g.e - 1) > 0.012) return false;
  return R.dir > 0 ? p < g.t1 && p > g.sl : p > g.t1 && p < g.sl;
};
async function chat(p, u, req, env) {
  if (parseInt(req.headers.get('content-length') || '0', 10) > 4000) return out({ error: 'پیام خیلی بزرگ است' }, 413, 0);
  const kv = env.SIG;
  if (!kv) return out({ error: 'KV تنظیم نشده' }, 500, 0);
  const now = Date.now(), ip = req.headers.get('CF-Connecting-IP') || 'x';
  const clean = (t) => String(t || '').replace(/[\u0000-\u001f\u007f<>]/g, ' ').trim().slice(0, 500);
  const okUid = (x) => { x = String(x || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 32); return x.length >= 12 ? x : ''; };
  const getT = async (uid) => { try { return JSON.parse((await kv.get('ct:' + uid)) || '[]'); } catch (_) { return []; } };
  const putT = (uid, m) => kv.put('ct:' + uid, JSON.stringify(m.slice(-40)), { expirationTtl: 90 * 86400 });
  const getI = async () => { try { return JSON.parse((await kv.get('ci')) || '{}'); } catch (_) { return {}; } };
  const putI = async (I) => {
    const ks = Object.keys(I).sort((a, b) => I[b].t - I[a].t).slice(0, 300), o = {};
    ks.forEach((k) => (o[k] = I[k]));
    await kv.put('ci', JSON.stringify(o));
  };
  if (p === '/chat/thread') {
    const uid = okUid(u.searchParams.get('uid'));
    if (!uid) return out({ error: 'کد نامعتبر' }, 400, 0);
    return out({ m: await getT(uid) }, 200, 0);
  }
  let body = {};
  if (req.method === 'POST') { try { body = await req.json(); } catch (_) {} }
  if (p === '/chat/send' && req.method === 'POST') {
    const uid = okUid(body.uid), text = clean(body.text);
    if (!uid || !text) return out({ error: 'پیام یا کد نامعتبر' }, 400, 0);
    if (!(await kv.get('u:' + uid))) return out({ error: 'ابتدا برنامه را باز کن تا دورهٔ رایگان شروع شود' }, 403, 0);
    const rk = 'rc:' + uid, c = parseInt((await kv.get(rk)) || '0', 10);
    if (c >= 8) return out({ error: 'تعداد پیام‌ها در یک ساعت زیاد است؛ بعداً دوباره بفرست' }, 429, 0);
    await kv.put(rk, String(c + 1), { expirationTtl: 3600 });
    const m = await getT(uid);
    m.push({ r: 'u', x: text, t: now });
    await putT(uid, m);
    const I = await getI();
    I[uid] = { t: now, n: ((I[uid] && I[uid].n) || 0) + 1, l: text.slice(0, 60) };
    await putI(I);
    try { await tg(env, '💬 پیام جدید از کاربر ' + uid.slice(0, 6) + '…\n' + text + '\n\n(پاسخ: برنامه → تب پیام → پنل مدیر)'); } catch (_) {}
    return out({ ok: true, m }, 200, 0);
  }
  if (p === '/chat/admin' && req.method === 'POST') {
    const fk = 'af:' + ip, fails = parseInt((await kv.get(fk)) || '0', 10);
    if (fails >= 8) return out({ error: 'تلاش بیش از حد؛ بعداً' }, 429, 0);
    if (!safeEq(req.headers.get('X-Key') || '', env.ADMIN_KEY || env.NOTIFY_KEY)) {
      await kv.put(fk, String(fails + 1), { expirationTtl: 600 });
      return out({ error: 'unauthorized' }, 401, 0);
    }
    const op = String(body.op || ''), uid = okUid(body.uid);
    if (op === 'list') {
      const I = await getI();
      return out({ list: Object.keys(I).sort((a, b) => I[b].t - I[a].t).slice(0, 50).map((k) => ({ uid: k, ...I[k] })) }, 200, 0);
    }
    if (!uid) return out({ error: 'کد نامعتبر' }, 400, 0);
    if (op === 'thread') {
      const I = await getI();
      if (I[uid]) { I[uid].n = 0; await putI(I); }
      return out({ m: await getT(uid) }, 200, 0);
    }
    if (op === 'reply') {
      const text = clean(body.text);
      if (!text) return out({ error: 'پیام خالی' }, 400, 0);
      const m = await getT(uid);
      m.push({ r: 'a', x: text, t: now });
      await putT(uid, m);
      const I = await getI();
      I[uid] = { t: now, n: 0, l: text.slice(0, 60) };
      await putI(I);
      return out({ ok: true, m }, 200, 0);
    }
  }
  return out({ error: 'مسیر ناشناخته' }, 404, 0);
}

export default {
  async fetch(req, env) {
    if (env.ALLOWED_ORIGIN) CORS['Access-Control-Allow-Origin'] = env.ALLOWED_ORIGIN; // امنیت: فقط سایت خودت (مثلاً https://golijoon68.github.io)
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const u = new URL(req.url);
    const p = u.pathname.replace(/\/+$/, '') || '/';
    if (p === '/coins') {
      const sc = u.searchParams.get('scan'), sl = u.searchParams.get('scalp'), ak = env.ADMIN_KEY || env.NOTIFY_KEY;
      if (sc != null || sl != null) {
        if (!ak || !safeEq(req.headers.get('X-Key') || u.searchParams.get('key'), ak)) return out({ error: 'unauthorized' }, 401, 0);
        const f = (s, m) => String(s || '').split(',').map((x) => x.trim().toUpperCase()).filter((x) => /^[A-Z0-9]{2,12}USDT$/.test(x)).slice(0, m);
        const d = { scan: f(sc, 15), scalp: f(sl, 15) };
        await env.SIG.put('coins', JSON.stringify(d)); CC = null;
        return out({ ok: true, ...d }, 200, 0);
      }
      return out({ scan: await coinsOf(env, 'scan'), scalp: await coinsOf(env, 'scalp') }, 200, 0);
    }
    if (p.startsWith('/tg/')) {
      try { return await tgRoutes(p, u, req, env); } catch (e) { await alertAdmin(env, 'route-' + p.slice(0, 10), 'خطای Worker در ' + p + ': ' + String((e && e.message) || e).slice(0, 150), 10800); return out({ error: String((e && e.message) || e) }, 500, 0); }
    }
    if (p.startsWith('/chat/')) {
      try { return await chat(p, u, req, env); } catch (e) { await alertAdmin(env, 'route-' + p.slice(0, 10), 'خطای Worker در ' + p + ': ' + String((e && e.message) || e).slice(0, 150), 10800); return out({ error: String((e && e.message) || e) }, 500, 0); }
    }
    if (p.startsWith('/lic/')) {
      try { return await lic(p, u, req, env); } catch (e) { await alertAdmin(env, 'route-' + p.slice(0, 10), 'خطای Worker در ' + p + ': ' + String((e && e.message) || e).slice(0, 150), 10800); return out({ error: String((e && e.message) || e) }, 500, 0); }
    }
    if (p === '/health') {
      let kvOk = false;
      try { if (env.SIG) { await env.SIG.get('coins'); kvOk = true; } } catch (_) {}
      return out({ ok: true, kv: kvOk, tg: !!(env.TG_TOKEN && env.TG_CHAT), wallet: !!env.LIC_WALLET, admin: !!(env.ADMIN_KEY || env.NOTIFY_KEY), origin: !!env.ALLOWED_ORIGIN, db: !!env.DB, bot: !!env.TG_TOKEN, t: Date.now(), v: 'v13' }, 200, 0);
    }
    if (p === '/ping') {
      const id = String(u.searchParams.get('id') || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 40), now = Date.now();
      let n = null, src = 'mem';
      if (env.DB && id) {
        try {
          if (!DBREADY) { await env.DB.prepare('CREATE TABLE IF NOT EXISTS presence (id TEXT PRIMARY KEY, t INTEGER)').run(); DBREADY = true; }
          await env.DB.prepare('INSERT INTO presence (id, t) VALUES (?1, ?2) ON CONFLICT(id) DO UPDATE SET t = ?2').bind(id, now).run();
          const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM presence WHERE t > ?1').bind(now - 200000).first();
          if (r && Number.isFinite(r.n)) { n = r.n; src = 'db'; }
          if (Math.random() < 0.02) await env.DB.prepare('DELETE FROM presence WHERE t < ?1').bind(now - 86400000).run();
        } catch (_) {}
      }
      if (n == null) { if (id) ONL.set(id, now); for (const [k, t] of ONL) if (now - t > 200000) ONL.delete(k); n = ONL.size; }
      return out({ n, src }, 200, 0);
    }
    if (p === '/journal') {
      if (!env.SIG) return out({ error: 'KV binding SIG تنظیم نشده', entries: [] }, 200, 0);
      const raw = (await env.SIG.get('journal')) || '{"entries":[]}';
      return new Response(raw, { headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=20' } });
    }
    if (p === '/notify') return out({ ok: true, skipped: 'پیام اسکالپ از برنامه غیرفعال است' }, 200, 0);
    if (p === '/report' && req.method === 'POST') {
      let b = {}; try { b = await req.json(); } catch (_) {}
      const m = String(b.m || '').replace(/[\u0000-\u001f<>]/g, ' ').trim().slice(0, 160);
      if (!m || !env.SIG) return out({ ok: true }, 200, 0);
      const dk = 'rpd:' + new Date().toISOString().slice(0, 10), n = parseInt((await env.SIG.get(dk)) || '0', 10);
      if (n >= 15) return out({ ok: true }, 200, 0);
      const key = 'cl-' + (await hexSha(m)).slice(0, 10);
      if (!(await env.SIG.get('al:' + key))) await env.SIG.put(dk, String(n + 1), { expirationTtl: 90000 });
      await alertAdmin(env, key, '🐞 خطای برنامه روی دستگاه کاربر\n' + m + '\n(' + String(b.l || '').slice(0, 12) + ' | ' + String(b.v || '').slice(0, 10) + ')', 21600);
      return out({ ok: true }, 200, 0);
    }
    if (p === '/test') {
      if (!safeEq(req.headers.get('X-Key') || u.searchParams.get('key'), env.NOTIFY_KEY)) return out({ error: 'unauthorized' }, 401, 0);
      await tg(env, '✅ تست اتصال: اگر این پیام را می‌بینی، هشدار تلگرام درست کار می‌کند');
      return out({ ok: true, telegram: !!(env.TG_TOKEN && env.TG_CHAT), ntfy: !!env.NTFY_TOPIC, kv: !!env.SIG }, 200, 0);
    }
    if (p === '/run-scalp') {
      if (!safeEq(req.headers.get('X-Key') || u.searchParams.get('key'), env.NOTIFY_KEY)) return out({ error: 'unauthorized' }, 401, 0);
      return out(await scalpCron(env, u.searchParams.get('all') === '1'), 200, 0);
    }
    if (p === '/run') {
      if (!safeEq(req.headers.get('X-Key') || u.searchParams.get('key'), env.NOTIFY_KEY)) return out({ error: 'unauthorized' }, 401, 0);
      return out(await cron(env), 200, 0);
    }
    return out(await iran(u.searchParams.get('debug')));
  },
  async scheduled(event, env, ctx) {
    const job = event.cron === '* * * * *' ? scalpCron(env, false) : cron(env);
    ctx.waitUntil(job.catch((e) => alertAdmin(env, 'cron-' + String(event.cron).slice(0, 4), 'خطای زمان‌بند (' + event.cron + '): ' + String((e && e.message) || e).slice(0, 200), 10800)));
  },
};
