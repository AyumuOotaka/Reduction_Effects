import SunCalc from "https://cdn.jsdelivr.net/npm/suncalc/+esm";

/* ----------------------------------------------
   コンフィグ
---------------------------------------------- */
const UPDATE_INTERVAL_SEC = 1;      // 1秒ごとに更新
const CO2_PER_KWH = 0.453;          // kg / kWh (国内平均係数)

// 月別 1kW あたり平均発電量 (kWh/日)
const monthlyIrr = [2.86,3.28,3.50,3.90,3.90,3.29,3.48,3.76,3.40,3.20,2.70,2.65];

/* ----------------------------------------------
   グローバル変数
---------------------------------------------- */
let records = [];    // CSVの拠点一覧
let totalGen = 0;    // 累計発電量 (kWh)

/* ----------------------------------------------
   CSV 読み込み
---------------------------------------------- */
fetch('ref.csv')
  .then(r => r.text())
  .then(parseCsv)
  .then(data => {
    records = data;
    calcInitialTotals();   // ← StartDate から現在までの累積を一気に計算
    initSiteList();
    update();                        // まず1回描画
    setInterval(update, UPDATE_INTERVAL_SEC * 1000); // 秒ごと更新
  });

function parseCsv(txt){
  const [headerLine, ...lines] = txt.trim().split(/\r?\n/);
  const headers = headerLine.split(',');
  return lines.map(line => {
    const cols = line.split(',');
    return headers.reduce((obj, h, idx) => {
      const v = cols[idx];
      obj[h] = isNaN(v) || h === 'start_date' || h === 'location' ? v : Number(v);
      return obj;
    }, {});
  });
}

/* ----------------------------------------------
   初期トータル算出
---------------------------------------------- */
function calcInitialTotals(){
  const now = new Date();
  const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  records.forEach(rec => {
    const start = new Date(rec.start_date);
    if (start > now) return;   // future start

    // ① StartDate から "昨日" までを月単位一気に足す
    let ptr = new Date(start.getFullYear(), start.getMonth(), 1);
    while (ptr < todayMidnight){
      const y = ptr.getFullYear();
      const m = ptr.getMonth();
      const daysInMonth = new Date(y, m+1, 0).getDate();

      // 範囲内で何日加算するか
      const fromDay = (y === start.getFullYear() && m === start.getMonth()) ? start.getDate() : 1;
      const toDay   = (y === now.getFullYear()   && m === now.getMonth())   ? now.getDate()-1 : daysInMonth;

      const days = Math.max(0, toDay - fromDay + 1);
      if(days){
          totalGen += rec.panel_capacity_kw * monthlyIrr[m] * days;
      }

      // 次の月へ
      ptr.setMonth(ptr.getMonth()+1);
    }

    // ② 今日分（0:00〜現在時刻まで）を時間係数で加算
    const factors = getHourlyFactor(rec.lat, rec.lon, now);
    const monthIdx = now.getMonth();
    const kwhPerFactor = rec.panel_capacity_kw * (monthlyIrr[monthIdx] / 24);

    let hoursDoneEnergy = 0;
    for(let h = 0; h < now.getHours(); h++){
      hoursDoneEnergy += kwhPerFactor * factors[h];
    }
    // 現在進行中の1時間については経過率をかける
    const secInHour = now.getMinutes()*60 + now.getSeconds();
    const frac = secInHour / 3600;
    hoursDoneEnergy += kwhPerFactor * factors[now.getHours()] * frac;

    totalGen += hoursDoneEnergy;
  });
}

/* ----------------------------------------------
   1秒ごと更新処理
---------------------------------------------- */
function update(){
  const now = new Date();
  const h = now.getHours();
  const mIdx = now.getMonth();

  let currentGenKW = 0;
  records.forEach(rec => {
    const factor = getHourlyFactor(rec.lat, rec.lon, now)[h];
    const kW = rec.panel_capacity_kw * (factor * (monthlyIrr[mIdx] / 24));
    rec._lastGenKW = kW;
    currentGenKW += kW;
  });

  // エネルギー量 = 出力(kW) * 秒 / 3600
  totalGen += currentGenKW * (UPDATE_INTERVAL_SEC / 3600);
  const co2 = totalGen * CO2_PER_KWH;

  // UI
  document.getElementById('now-time').textContent        = now.toLocaleTimeString();
  document.getElementById('current-generation').textContent = currentGenKW.toFixed(3);
  document.getElementById('total-generation').textContent   = totalGen.toFixed(2);
  document.getElementById('co2-reduction').textContent      = co2.toFixed(2);

  updateSiteList();
  updateBackground(now);
}

/* ----------------------------------------------
   時間係数 (SunCalc + 三角分布)
---------------------------------------------- */
const factorCache = new Map(); // key=lat,lon,month

function getHourlyFactor(lat, lon, dateObj){
  const key = lat+','+lon+','+dateObj.getMonth();
  if(factorCache.has(key)) return factorCache.get(key);

  const midMonthDate = new Date(dateObj.getFullYear(), dateObj.getMonth(), 15);
  const { sunrise, sunset } = SunCalc.getTimes(midMonthDate, lat, lon);

  const sH = sunrise.getHours() + sunrise.getMinutes()/60;
  const eH = sunset.getHours()  + sunset.getMinutes()/60;
  const dayLen = eH - sH;
  const peak = (sH + eH) / 2;

  let arr = Array(24).fill(0);
  let sum = 0;
  for(let h=0; h<24; h++){
    const center = h + 0.5;
    if(center < sH || center > eH) continue;
    const rel = 1 - Math.abs(center - peak) / (dayLen / 2);
    arr[h] = Math.max(0, rel);
    sum += arr[h];
  }
  arr = arr.map(v => v * 24 / sum); // normalize to 24
  factorCache.set(key, arr);
  return arr;
}

/* ----------------------------------------------
   背景切替
---------------------------------------------- */
function updateBackground(now){
  const hr = now.getHours();
  document.body.className = (hr>=6 && hr<18) ? 'daytime' : 'nighttime';
}

/* ----------------------------------------------
   サイトリストUI
---------------------------------------------- */
function initSiteList(){
  const ul = document.getElementById('site-list');
  records.forEach(rec=>{
    const li = document.createElement('li');
    li.id = 'site-' + rec.id;
    li.textContent = `${rec.location}: - kW`;
    ul.appendChild(li);
  });
}

function updateSiteList(){
  records.forEach(rec=>{
    const li = document.getElementById('site-' + rec.id);
    if(li) li.textContent = `${rec.location}: ${rec._lastGenKW.toFixed(3)} kW`;
  });
}
