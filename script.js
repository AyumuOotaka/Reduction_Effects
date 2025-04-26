
import SunCalc from "https://cdn.jsdelivr.net/npm/suncalc/+esm";

/* ----------------------------------------------
   CONFIG
---------------------------------------------- */
const UPDATE_INTERVAL_SEC = 1;      // update every second
const CO2_PER_KWH = 0.453;          // kg / kWh
const NOISE_RANGE = 0.004;          // ±0.4 % visual noise
const HOUSE_KWH_PER_DAY = 10;       // 1世帯10kWh/日で換算
const CO2_PER_TREE = 15;            // 15kg/年 = 1本の年間吸収量

// 月別 1kW あたり平均発電量 (kWh/日)
const monthlyIrr = [2.86,3.28,3.50,3.90,3.90,3.29,3.48,3.76,3.40,3.20,2.70,2.65];

/* ----------------------------------------------
   STATE
---------------------------------------------- */
let records = [];
let totalGen = 0;          // 累計kWh
let totalCapacityKW = 0;   // 全パネル容量

/* ---------- number formatter ---------- */
function fmt(val, dec, unit=""){
  const num = parseFloat(val).toLocaleString('en-US',
        {minimumFractionDigits:dec, maximumFractionDigits:dec});
  return unit ? `${num} ${unit}` : num;
}

/* ----------------------------------------------
   CSV LOAD
---------------------------------------------- */
fetch('ref.csv')
  .then(r=>r.text())
  .then(parseCsv)
  .then(data=>{
    records = data;
    totalCapacityKW = records.reduce((s,r)=>s + (r.panel_capacity_kw||0),0);
    calcInitialTotals();
    initSiteList();
    update();
    setInterval(update, UPDATE_INTERVAL_SEC*1000);
  });

function parseCsv(txt){
  const [header,...lines] = txt.trim().split(/\r?\n/);
  const headers = header.split(',');
  return lines.map(l=>{
    const c = l.split(',');
    return headers.reduce((o,h,i)=>{
      const v = c[i];
      o[h] = (h==='location'||h==='start_date')?v:Number(v);
      return o;
    },{});
  });
}

/* ----------------------------------------------
   INITIAL TOTAL (start_date -> now)
---------------------------------------------- */
function calcInitialTotals(){
  const now = new Date();
  const today0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  records.forEach(rec=>{
    const start = new Date(rec.start_date);
    if(start > now) return;

    // 月単位加算
    let p = new Date(start.getFullYear(), start.getMonth(), 1);
    while(p < today0){
      const y = p.getFullYear(), m = p.getMonth();
      const daysInMonth = new Date(y,m+1,0).getDate();
      const from = (y===start.getFullYear()&&m===start.getMonth())? start.getDate():1;
      const to   = (y===now.getFullYear()&&m===now.getMonth())? now.getDate()-1:daysInMonth;
      const d = Math.max(0,to-from+1);
      if(d) totalGen += rec.panel_capacity_kw * monthlyIrr[m] * d;
      p.setMonth(p.getMonth()+1);
    }

    // 今日分
    const factors = getHourlyFactor(rec.lat,rec.lon,now);
    const mIdx = now.getMonth();
    const kwhPerF = rec.panel_capacity_kw * (monthlyIrr[mIdx]/24);
    let eToday = 0;
    for(let h=0;h<now.getHours();h++) eToday += kwhPerF * factors[h];
    const sec = now.getMinutes()*60 + now.getSeconds();
    eToday += kwhPerF * factors[now.getHours()] * (sec/3600);
    totalGen += eToday;
  });
}

/* ----------------------------------------------
   PER‑SECOND UPDATE
---------------------------------------------- */
function update(){
  const now = new Date();
  const hour = now.getHours();
  const frac = (now.getMinutes()*60 + now.getSeconds())/3600;
  const monthIdx = now.getMonth();

  let currentKW_det = 0;

  records.forEach(rec=>{
    const fArr = getHourlyFactor(rec.lat,rec.lon,now);
    const interp = fArr[hour] + (fArr[(hour+1)%24]-fArr[hour])*frac;
    const kW = rec.panel_capacity_kw * (interp * (monthlyIrr[monthIdx]/24));
    rec._lastGenKW = kW;
    currentKW_det += kW;
  });

  // energy accumulation
  totalGen += currentKW_det * (UPDATE_INTERVAL_SEC/3600);
  const co2 = totalGen * CO2_PER_KWH;

  // visual noise
  const dispKW = currentKW_det * (1 + (Math.random()-0.5)*NOISE_RANGE);

  // --- UI update ---
  document.getElementById('now-time')?.textContent = now.toLocaleTimeString();
  document.getElementById('current-generation').textContent = fmt(dispKW,3,'kW');
  document.getElementById('total-generation').textContent  = fmt(totalGen,2,'kWh');
  document.getElementById('co2-reduction').textContent     = fmt(co2,2,'kg');

  // equivalence
  document.getElementById('house-days').textContent = Math.round(totalGen/HOUSE_KWH_PER_DAY).toLocaleString('en-US');
  document.getElementById('tree-equiv').textContent = Math.round(co2/CO2_PER_TREE).toLocaleString('en-US');
  const cap = totalCapacityKW? ((currentKW_det/totalCapacityKW)*100).toFixed(1):0;
  document.getElementById('cap-factor').textContent = cap;

  updateSiteList();
  updateBackground(now);
}

/* ----------------------------------------------
   HOURLY FACTOR
---------------------------------------------- */
const factorCache = new Map();
function getHourlyFactor(lat,lon,ref){
  const key = lat+','+lon+','+ref.getMonth();
  if(factorCache.has(key)) return factorCache.get(key);
  const mid = new Date(ref.getFullYear(),ref.getMonth(),15);
  const {sunrise,sunset} = SunCalc.getTimes(mid,lat,lon);
  const sH = sunrise.getHours()+sunrise.getMinutes()/60;
  const eH = sunset.getHours()+sunset.getMinutes()/60;
  const peak = (sH+eH)/2, span=eH-sH;
  let arr = Array(24).fill(0), sum=0;
  for(let h=0;h<24;h++){
    const c=h+0.5;
    if(c<sH||c>eH) continue;
    const rel = 1-Math.abs(c-peak)/(span/2);
    arr[h]=Math.max(0,rel); sum+=arr[h];
  }
  arr=arr.map(v=>v*24/sum);
  factorCache.set(key,arr);
  return arr;
}

/* ---------------------------------------------- */
function updateBackground(now){
  /* body class handled in host page */
}

/* ----------------------------------------------
   SITE LIST
---------------------------------------------- */
function initSiteList(){
  const ul=document.getElementById('site-list');
  if(!ul) return;
  records.forEach(rec=>{
    const li=document.createElement('li');
    li.id='site-'+rec.id;
    li.textContent=`${rec.location}: -- kW`;
    ul.appendChild(li);
  });
}
function updateSiteList(){
  const ul=document.getElementById('site-list');
  if(!ul) return;
  records.forEach(rec=>{
    const li=document.getElementById('site-'+rec.id);
    if(li){
      const noise = 1 + (Math.random()-0.5)*NOISE_RANGE;
      li.textContent=`${rec.location}: ${fmt(rec._lastGenKW*noise,3,'kW')}`;
    }
  });
}
