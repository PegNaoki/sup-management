// 読み取り済みの予約JSON（jalan / urakata / aj）から、体験日ごとの人数を出す。
// 成果物のダウンロードが使えない環境でも結果を受け取れるよう、ログに表を出す。
// 確定のみを数え、仮予約・キャンセル・却下は除く。
import fs from 'fs';

const FILES = [
  ['じゃらん', 'jalan-reservations.json'],
  ['ウラカタ', 'urakata-reservations.json'],
  ['AJ',       'aj-reservations.json'],
];
const EXCLUDE = /キャンセル|却下|仮予約|リクエスト/;

const byDate = new Map();
const perSite = {};
const skipped = [];

for (const [label, f] of FILES) {
  perSite[label] = { rows: 0, people: 0, excluded: 0 };
  if (!fs.existsSync(f)) { skipped.push(label); continue; }
  const json = JSON.parse(fs.readFileSync(f, 'utf8'));
  const list = Array.isArray(json) ? json : (json.reservations || []);
  for (const r of list) {
    if (!r.date) continue;
    const st = String(r.status || '');
    if (EXCLUDE.test(st)) { perSite[label].excluded++; continue; }
    const n = parseInt(String(r.people ?? '').replace(/[^\d]/g, ''), 10);
    const pax = Number.isFinite(n) ? n : 0;
    if (!byDate.has(r.date)) byDate.set(r.date, { rows: 0, people: 0, sites: {} });
    const d = byDate.get(r.date);
    d.rows++; d.people += pax;
    d.sites[label] = (d.sites[label] || 0) + pax;
    perSite[label].rows++; perSite[label].people += pax;
  }
}

const WD = ['日', '月', '火', '水', '木', '金', '土'];
const dates = [...byDate.keys()].sort();
console.log('=== 体験日ごとの人数（確定のみ・じゃらん/ウラカタ/AJ） ===');
console.log('日付\t曜日\t件数\t人数\tじゃらん\tウラカタ\tAJ');
let m = {};
for (const dt of dates) {
  const d = byDate.get(dt);
  const w = WD[new Date(dt + 'T00:00:00+09:00').getDay()];
  console.log([dt, w, d.rows, d.people,
    d.sites['じゃらん'] || 0, d.sites['ウラカタ'] || 0, d.sites['AJ'] || 0].join('\t'));
  const key = dt.slice(0, 7);
  if (!m[key]) m[key] = { rows: 0, people: 0 };
  m[key].rows += d.rows; m[key].people += d.people;
}
console.log('=== 月合計 ===');
for (const k of Object.keys(m).sort()) console.log(`${k}\t${m[k].rows}件\t${m[k].people}名`);
console.log('=== サイト別 ===');
for (const [k, v] of Object.entries(perSite)) {
  console.log(`${k}\t${v.rows}件\t${v.people}名\t（除外 ${v.excluded}件）`);
}
if (skipped.length) console.log(`読み取れなかったサイト: ${skipped.join(', ')}`);
