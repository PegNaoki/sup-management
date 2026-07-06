// ============================================================
// ウラカタ (urkt.in) 予約一覧 読み取りスクリプト（リコンサイル用）
// ------------------------------------------------------------
// ウラカタ＝アソビュー＝Web予約の予約を読み取り、体験日が今日以降の分をJSON出力。
// メール取りこぼし検出・在庫突合の照合源として使う。
//
// 画面構造（実DOM確認済み）：
//   - 予約検索ページ → 参加日 from/to を指定 → 「検索」
//   - 結果表: table.ui.celled ... / 各行 tr.nwigeYpcuPDbQYuZcYkD
//     列: 予約者(氏名/電話), 支払済, 支払方法, 申込日時, 参加日, コース(コース名+時間), 合計, 料金, 媒体
//   - キャンセルされた予約は検索結果に出ない想定（有効な予約のみ）
//
// 環境変数：
//   URKT_ID / URKT_PASSWORD / HEADLESS (既定 true)
//   OUT_PATH (既定 urakata-reservations.json)
//   RANGE_DAYS : 参加日 今日〜N日先まで検索（既定 210＝約7ヶ月＝シーズン網羅）
//
// 注意：ウラカタは予約番号を一覧に持たないため、突合キーは
//   「参加日 + 時間 + 氏名(カナ)」で構成する（GAS側で照合）。
// ============================================================

import { chromium } from 'playwright';
import fs from 'fs';

const CONFIG = {
  loginUrl: 'https://the-retreat-place.urkt.in/login',
  id:       process.env.URKT_ID,
  password: process.env.URKT_PASSWORD,
  headless: process.env.HEADLESS !== 'false',
  outPath:  process.env.OUT_PATH || 'urakata-reservations.json',
  rangeDays: parseInt(process.env.RANGE_DAYS || '210', 10),
};

function assertConfig() {
  const miss = [];
  if (!CONFIG.id)       miss.push('URKT_ID');
  if (!CONFIG.password) miss.push('URKT_PASSWORD');
  if (miss.length) throw new Error(`必須の環境変数が未設定: ${miss.join(', ')}`);
}
function log(event, data = {}) {
  console.log(`${new Date().toISOString()} [${event}] ${JSON.stringify(data)}`);
}
function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

async function main() {
  assertConfig();
  log('start');
  const browser = await chromium.launch({
    headless: CONFIG.headless,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
  });
  const page = await browser.newPage();

  try {
    // ---------- 1. ログイン ----------
    await page.goto(CONFIG.loginUrl, { waitUntil: 'networkidle' });
    await page.getByRole('textbox', { name: 'ログインID' }).fill(CONFIG.id);
    await page.getByRole('textbox', { name: 'パスワード' }).fill(CONFIG.password);
    await page.getByRole('button', { name: 'ログイン' }).click();
    await page.waitForLoadState('networkidle');
    log('login_ok');

    // ---------- 2. 予約検索ページへ ----------
    await page.getByRole('link', { name: '予約検索' }).click();
    await page.waitForLoadState('networkidle');
    log('search_page_opened');

    // ---------- 3. 参加日 from=今日 / to=今日+RANGE_DAYS で検索 ----------
    const today = new Date();
    const to = new Date(); to.setDate(today.getDate() + CONFIG.rangeDays);
    await setDateRange(page, today, to);
    await page.getByRole('button', { name: '検索' }).click();
    await page.waitForLoadState('networkidle');
    await page.waitForSelector('table.ui.celled tbody tr', { timeout: 20000 }).catch(() => null);
    log('search_done');

    // ---------- 4. 結果テーブルを読み取り ----------
    const rows = await page.$$eval('table.ui.celled tbody tr', (trs) => trs.map((tr) => {
      const tds = [...tr.querySelectorAll('td')];
      const txt = (el) => el ? el.textContent.replace(/\s+/g, ' ').trim() : '';
      // 列順: 0=展開, 1=予約者(氏名/電話), 2=支払済, 3=支払方法, 4=申込日時,
      //       5=参加日, 6=コース(コース名+時間), 7=合計, 8=料金, 9=媒体
      const nameCell = tds[1];
      const name  = nameCell ? txt(nameCell.querySelector('div')) : '';
      const phone = nameCell && nameCell.querySelectorAll('div')[1] ? txt(nameCell.querySelectorAll('div')[1]) : '';
      const applied = txt(tds[4]);
      const joinDate = txt(tds[5]);
      const courseCell = tds[6];
      const course = courseCell ? txt(courseCell.querySelector('div')) : '';
      const timeMatch = courseCell ? (courseCell.textContent.match(/(\d{1,2}:\d{2})/) || [])[1] : '';
      const people = txt(tds[7]);
      const price  = txt(tds[8]);
      const media  = txt(tds[9]);
      return { name, phone, applied, joinDate, course, time: timeMatch || '', people, price, media };
    }));
    log('rows_read', { count: rows.length });

    // ---------- 5. 体験日が今日以降のものに整形して出力 ----------
    const todayStr = ymd(today);
    const reservations = rows.map((r) => {
      const m = String(r.joinDate).match(/(\d{4})\/(\d{1,2})\/(\d{1,2})/);
      const date = m ? `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}` : '';
      return {
        date, time: r.time,
        name: r.name, phone: r.phone,
        people: parseInt(r.people, 10) || null,
        course: r.course, price: r.price, media: r.media,
      };
    }).filter((r) => r.date && r.date >= todayStr);

    const result = {
      fetchedAt: new Date().toISOString(),
      site: 'ウラカタ',
      totalFetched: rows.length,
      totalFuture: reservations.length,
      today: todayStr,
      reservations,
    };
    fs.writeFileSync(CONFIG.outPath, JSON.stringify(result, null, 2));
    log('done', { fetched: rows.length, future: reservations.length, out: CONFIG.outPath });

    console.log('\n===== 今日以降の予約（ウラカタ）=====');
    for (const r of reservations) {
      console.log(`${r.date} ${r.time} ${r.name} ${r.people}名 [${r.media}]`);
    }
  } catch (err) {
    log('error', { message: err.message });
    console.error('❌ エラー:', err.message);
    await page.screenshot({ path: 'reconcile-urakata-error.png', fullPage: true }).catch(() => {});
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

// 参加日 from/to を datepicker で設定する。
// ウラカタの検索フォームは「申込日(from,to)」「参加日(from,to)」の順で
// テキストボックスが並ぶ。参加日は録画上 4,5番目（0始まり）。
// 環境変数 DATE_BOX_FROM / DATE_BOX_TO で番号を上書き可能。
async function setDateRange(page, fromDate, toDate) {
  // 全テキストボックスの直前ラベルをログ出力（番号確認用のデバッグ）
  const labels = await page.$$eval('input[type=text], input:not([type])', (els) => els.map((el, i) => {
    // 近くの見出しテキストを拾う
    let lbl = '';
    const wrap = el.closest('.field, .column, form > div, div');
    if (wrap) lbl = (wrap.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 30);
    return `${i}:${lbl}`;
  }));
  log('textbox_labels', { labels });

  const fromIdx = parseInt(process.env.DATE_BOX_FROM || '4', 10);
  const toIdx   = parseInt(process.env.DATE_BOX_TO   || '5', 10);
  const boxes = page.getByRole('textbox');

  for (const [idx, t, which] of [[fromIdx, fromDate, 'from'], [toIdx, toDate, 'to']]) {
    await boxes.nth(idx).click();
    const nextBtn = page.getByRole('button', { name: 'Next Month' });
    if (!(await nextBtn.first().isVisible().catch(() => false))) {
      log('date_box_no_calendar', { which, idx });
      continue;
    }
    const y = t.getFullYear(), m = t.getMonth() + 1, d = t.getDate();
    let ok = false;
    for (let hop = 0; hop < 24; hop++) {
      const opt = page.getByRole('option', { name: new RegExp(`Choose ${y}年${m}月${d}日`) });
      if (await opt.count() > 0 && await opt.first().isVisible().catch(() => false)) {
        await opt.first().click();
        await page.waitForTimeout(600);
        ok = true; break;
      }
      await nextBtn.first().click();
      await page.waitForTimeout(300);
    }
    log(ok ? 'date_set' : 'date_set_fail', { which, ymd: ymd(t), viaTextbox: idx });
  }
}

main();
