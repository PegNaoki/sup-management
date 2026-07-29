// ============================================================
// 3サイトの枠モード監査結果（audit-*-mode.json）を1枚の一覧表にまとめる。
// 出力：
//   audit-mode-summary.json … 統合データ
//   audit-mode-summary.md   … Markdown表（Actionsサマリにも出力）
// ============================================================

import fs from 'fs';

const SITES = [
  { key: 'jalan',   label: 'じゃらん',        file: 'audit-jalan-mode.json' },
  { key: 'urakata', label: 'ウラカタ',        file: 'audit-urakata-mode.json' },
  { key: 'aj',      label: 'アクティビティJP', file: 'audit-aj-mode.json' },
];

const MODE_JA = {
  immediate:   '即予約',
  request:     'リクエスト',
  combination: '併用',
  closed:      '開催なし',
  not_found:   '—（枠なし）',
  unknown:     '不明',
};

function load(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return []; }
}

// key: "date time" -> { date, time, jalan, urakata, aj }
const grid = new Map();
const allRows = [];

for (const site of SITES) {
  const rows = load(site.file);
  for (const r of rows) {
    allRows.push({ ...r, siteLabel: site.label });
    const k = `${r.date} ${r.time}`;
    if (!grid.has(k)) grid.set(k, { date: r.date, time: r.time });
    grid.get(k)[site.key] = r.mode;
  }
}

const keys = [...grid.keys()].sort();

// Markdown 表（枠×サイト）
let md = '# OTA 枠モード監査（即予約／リクエスト）\n\n';
md += `監査日時: ${new Date().toISOString()}\n\n`;
md += '| 日付 | 時間 | じゃらん | ウラカタ | アクティビティJP |\n';
md += '|---|---|---|---|---|\n';
for (const k of keys) {
  const g = grid.get(k);
  const cell = (v) => (v ? MODE_JA[v] || v : '—');
  md += `| ${g.date} | ${g.time} | ${cell(g.jalan)} | ${cell(g.urakata)} | ${cell(g.aj)} |\n`;
}

md += '\n**凡例**: 即予約=自動確定 / リクエスト=承認待ち / 併用=在庫内は即時+超過はリクエスト / —=その枠は当該OTAに無し\n';
md += '\n_ウラカタは専用の予約方式UIを持たず、即時販売在庫 `(n)` が n>0 なら即予約・0 ならリクエスト受付として判定しています。_\n';

fs.writeFileSync('audit-mode-summary.md', md);
fs.writeFileSync('audit-mode-summary.json', JSON.stringify({
  auditedAt: new Date().toISOString(),
  grid: keys.map(k => grid.get(k)),
  rows: allRows,
}, null, 2));

// コンソール & GitHub Actions サマリ
console.log(md);
if (process.env.GITHUB_STEP_SUMMARY) {
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
}
