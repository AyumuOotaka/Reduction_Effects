import SunCalc from "https://cdn.jsdelivr.net/npm/suncalc/+esm";

const CO2_PER_KWH = 0.453;   // kg / kWh
const monthlyIrr = [2.86,3.28,3.50,3.90,3.90,3.29,3.48,3.76,3.40,3.20,2.70,2.65];

let records = [];
let totalGen = 0;

fetch('ref.csv')
  .then(r=>r.text())
  .then(parseCsv)
  .then(data=>{records=data; initSiteList(); update(); setInterval(update,60*1000);});

function parseCsv(txt){
  const lines = txt.trim().split(/\r?\n/);
  const headers = lines[0].split(',');
  return lines.slice(1).map(l=>{
    const cols = l.split(',');
    return headers.reduce((obj,h,i)=>{obj[h]=isNaN(cols[i])?cols[i]:Number(cols[i]);return obj;},{});
  });
}

// ───────────────────────── update loop
function update(){
  const now = new Date();
  const month = now.getMonth();
  const hour = now.getHours();

  let currentGen = 0;
  records.forEach(rec=>{
    const hFactor = getHourlyFactor(rec.lat,rec.lon,now)[hour];
    const gen = rec.panel_capacity_kw * (monthlyIrr[month]/24) * hFactor;
    rec._lastGen = gen;
    currentGen += gen;
  });

  totalGen += currentGen/60;  // kWh per minute accumulation
  const co2 = totalGen * CO2_PER_KWH;

  // UI update
  document.getElementById('now-time').textContent = now.toLocaleTimeString();
  document.getElementById('current-generation').textContent = currentGen.toFixed(2);
  document.getElementById('total-generation').textContent = totalGen.toFixed(2);
  document.getElementById('co2-reduction').textContent   = co2.toFixed(2);
  updateSiteList();
  updateBackground(now);
}

// ───────────────────────── hourly factor builder with sunrise/sunset
const cache = new Map();  // per (lat,lon,month) -> factors

function getHourlyFactor(lat,lon,now){
  const key = lat+','+lon+','+now.getMonth();
  if(cache.has(key)) return cache.get(key);
  const date = new Date(now.getFullYear(), now.getMonth(), 15);
  const {sunrise,sunset} = SunCalc.getTimes(date,lat,lon);
  const sunH = sunrise.getHours()+sunrise.getMinutes()/60;
  const setH = sunset.getHours()+sunset.getMinutes()/60;
  const dayLen = setH - sunH;
  const peak = (sunH+setH)/2;

  let factors = Array(24).fill(0);
  let total=0;
  for(let h=0;h<24;h++){
    const center = h+0.5;
    if(center<sunH||center>setH) continue;
    const rel = 1 - Math.abs(center-peak)/(dayLen/2);
    factors[h]=Math.max(0,rel);
    total+=factors[h];
  }
  factors = factors.map(v=>v*24/total);
  cache.set(key,factors);
  return factors;
}

// ───────────────────────── background
function updateBackground(now){
  const h=now.getHours();
  document.body.className = (h>=6 && h<18)?'daytime':'nighttime';
}

// ───────────────────────── UI list
function initSiteList(){
  const ul=document.getElementById('site-list');
  records.forEach(rec=>{
    const li=document.createElement('li');
    li.id='site-'+rec.id;
    li.textContent=`${rec.location}: - kW`;
    ul.appendChild(li);
  });
}
function updateSiteList(){
  records.forEach(rec=>{
    const el=document.getElementById('site-'+rec.id);
    if(el) el.textContent=`${rec.location}: ${rec._lastGen.toFixed(2)} kW`;
  });
}
