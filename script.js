import SunCalc from "https://cdn.jsdelivr.net/npm/suncalc/+esm";

/* ----------------------------------------------
   CONFIG
---------------------------------------------- */
const UPDATE_INTERVAL_SEC = 1;      // update every second
const CO2_PER_KWH = 0.453;          // kg / kWh (national avg)
const NOISE_RANGE = 0.004;          // ±0.4 % visual noise 

// monthly average daily generation for 1 kW array (kWh/day)
const monthlyIrr = [2.86,3.28,3.50,3.90,3.90,3.29,3.48,3.76,3.40,3.20,2.70,2.65];

/* ----------------------------------------------
   STATE
---------------------------------------------- */
let records = [];          // site records from CSV
let totalGen = 0;          // cumulative kWh (deterministic)

/* ----------------------------------------------
   Helper : number formatting with thousand separators + optional unit (no parentheses)
---------------------------------------------- */
function fmt(val, dec, unit=""){
  const num = parseFloat(val).toLocaleString('en-US',
              {minimumFractionDigits:dec, maximumFractionDigits:dec});
  return unit ? `${num} ${unit}` : num;
}

/* ----------------------------------------------
   CSV LOAD
---------------------------------------------- */
fetch('ref.csv')
  .then(r => r.text())
  .then(parseCsv)
  .then(data => {
    records = data;
    calcInitialTotals();
    initSiteList();
    update();                             // first paint
    setInterval(update, UPDATE_INTERVAL_SEC * 1000);
  });

function parseCsv(txt){
  const [headerLine, ...lines] = txt.trim().split(/\r?\n/);
  const headers = headerLine.split(',');
  return lines.map(line=>{
    const cols = line.split(',');
    return headers.reduce((o,h,i)=>{
      const v = cols[i];
      // numeric except location and start_date
      o[h] = (h==='location' || h==='start_date') ? v : Number(v);
      return o;
    },{});
  });
}

/* ----------------------------------------------
   INITIAL TOTAL (start_date -> now)
   fast monthly accumulation + today's partial
---------------------------------------------- */
function calcInitialTotals(){
  const now = new Date();
  const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  records.forEach(rec=>{
    const start = new Date(rec.start_date);
    if(start > now) return;

    // Month-wise accumulate
    let ptr = new Date(start.getFullYear(), start.getMonth(), 1);
    while(ptr < todayMidnight){
      const y = ptr.getFullYear();
      const m = ptr.getMonth();
      const daysInMonth = new Date(y, m+1, 0).getDate();

      const fromDay = (y===start.getFullYear() && m===start.getMonth()) ? start.getDate() : 1;
      const toDay   = (y===now.getFullYear() && m===now.getMonth())     ? now.getDate()-1 : daysInMonth;
      const days = Math.max(0, toDay - fromDay + 1);

      if(days){
        totalGen += rec.panel_capacity_kw * monthlyIrr[m] * days;
      }
      ptr.setMonth(ptr.getMonth()+1);
    }

    // Today's partial using hourly factors
    const f = getHourlyFactor(rec.lat, rec.lon, now);
    const mIdx = now.getMonth();
    const kwhPerFactor = rec.panel_capacity_kw * (monthlyIrr[mIdx] / 24);

    let energyToday = 0;
    for(let h=0; h<now.getHours(); h++){
      energyToday += kwhPerFactor * f[h];
    }
    const secInHour = now.getMinutes()*60 + now.getSeconds();
    const frac = secInHour / 3600;
    energyToday += kwhPerFactor * f[now.getHours()] * frac;

    totalGen += energyToday;
  });
}

/* ----------------------------------------------
   PER‑SECOND UPDATE
---------------------------------------------- */
function update(){
  const now   = new Date();
  const hour  = now.getHours();
  const frac  = (now.getMinutes()*60 + now.getSeconds()) / 3600;   // position within the hour
  const monthIdx = now.getMonth();

  let currentKW_det = 0;   // deterministic output

  records.forEach(rec=>{
    const factors = getHourlyFactor(rec.lat, rec.lon, now);
    const fNow  = factors[hour];
    const fNext = factors[(hour+1)%24];
    const interp = fNow + (fNext - fNow) * frac;                  // ① linear interpolation

    const kW = rec.panel_capacity_kw * (interp * (monthlyIrr[monthIdx] / 24));
    rec._lastGenKW_det = kW;
    currentKW_det += kW;
  });

  /* accumulate deterministic energy */
  totalGen += currentKW_det * (UPDATE_INTERVAL_SEC / 3600);
  const co2 = totalGen * CO2_PER_KWH;

  /* -------- visual noise (②) ---------- */
  const noiseFactor = 1 + (Math.random() - 0.5) * NOISE_RANGE;  // ±NOISE_RANGE/2
  const displayKW   = currentKW_det * noiseFactor;

  /* -------- UI update ---------- */
  document.getElementById('now-time').textContent          = now.toLocaleTimeString();
  document.getElementById('current-generation').textContent= fmt(displayKW, 3, 'kW');
  document.getElementById('total-generation').textContent  = fmt(totalGen, 2, 'kWh');
  document.getElementById('co2-reduction').textContent     = fmt(co2, 2, 'kg');

  updateSiteList();      // with noise
  updateBackground(now);
}

/* ----------------------------------------------
   HOURLY FACTOR (SunCalc + triangular)
---------------------------------------------- */
const factorCache = new Map();

function getHourlyFactor(lat, lon, refDate){
  const key = lat + ',' + lon + ',' + refDate.getMonth();
  if(factorCache.has(key)) return factorCache.get(key);

  const mid = new Date(refDate.getFullYear(), refDate.getMonth(), 15);
  const { sunrise, sunset } = SunCalc.getTimes(mid, lat, lon);
  const sH = sunrise.getHours() + sunrise.getMinutes()/60;
  const eH = sunset.getHours()  + sunset.getMinutes()/60;
  const peak = (sH + eH) / 2;
  const span = eH - sH;

  let arr = Array(24).fill(0);
  let sum = 0;
  for(let h=0; h<24; h++){
    const center = h + 0.5;
    if(center < sH || center > eH) continue;
    const rel = 1 - Math.abs(center - peak) / (span / 2);
    arr[h] = Math.max(0, rel);
    sum += arr[h];
  }
  arr = arr.map(v => v * 24 / sum);  // normalize
  factorCache.set(key, arr);
  return arr;
}

/* ----------------------------------------------
   BACKGROUND DAY / NIGHT
---------------------------------------------- */
function updateBackground(now){
  const h = now.getHours();
  document.body.className = (h>=6 && h<18) ? 'daytime' : 'nighttime';
}

/* ----------------------------------------------
   SITE LIST
---------------------------------------------- */
function initSiteList(){
  const ul = document.getElementById('site-list');
  records.forEach(rec=>{
    const li = document.createElement('li');
    li.id = 'site-'+rec.id;
    li.textContent = `${rec.location}: -- kW`;
    ul.appendChild(li);
  });
}

function updateSiteList(){
  records.forEach(rec=>{
    const li = document.getElementById('site-'+rec.id);
    if(li){
      const noise = 1 + (Math.random() - 0.5) * NOISE_RANGE;
      li.textContent = `${rec.location}: ${fmt(rec._lastGenKW_det * noise, 3, 'kW')}`;
    }
  });
}
