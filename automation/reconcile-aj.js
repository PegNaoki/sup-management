// ============================================================
// アクティビティジャパン (ptn.activityjapan.com) 予約一覧 読み取り（リコンサイル用）
// ------------------------------------------------------------
// 予約一覧から体験日が今日以降の予約を読み取り、JSON出力。
//
// 画面構造（実DOM確認済み）：
//   - 予約管理 → 予約一覧 → 実施日 from(#performSt02)/to(#performEnd02) → 「条件で検索する」
//   - 結果行: tr.date-url-target（data-url に予約番号）
//     予約番号: 1列目 small / ステータス: badge（確定予約/リクエスト/キャンセル等）
//     実施日: 「2026-08-08 (土) 10:00」/ 氏名: b / 人数: 専用セル b
//
// 環境変数：
//   AJ_ID / AJ_PASSWORD / HEADLESS (既定 true)
//   OUT_PATH (既定 aj-reservations.json) / RANGE_DAYS (既定 210)
// ============================================================

import { chromium } from 'playwright';
import fs from 'fs';

const CONFIG = {
  loginUrl: 'https://ptn.activityjapan.com/login',
  id:       process.env.AJ_ID,
  password: process.env.AJ_PASSWORD,
  headless: process.env.HEADLESS !== 'false',
  outPath:  process.env.OUT_PATH || 'aj-reservations.json',
  rangeDays: parseInt(process.env.RANGE_DAYS || '210', 10),
};

function assertConfig() {
  const miss = [];
  if (!CONFIG.id)       miss.push('AJ_ID');
  if (!CONFIG.password) miss.push('AJ_PASSWORD');
  if (miss.length) throw new Error(`必須の環境変数が未設定: ${miss.join(', ')}`);
}
function log(event, data = {}) { console.log(`${new Date().toISOString()} [${event}] ${JSON.stringify(data)}`); }
function ymd(d) { return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }

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
    await page.getByRole('textbox', { name: 'ID' }).fill(CONFIG.id);
    await page.getByRole('textbox', { name: 'パスワード' }).fill(CONFIG.password);
    await page.getByRole('button', { name: 'ログインする' }).click();
    await page.waitForLoadState('networkidle');
    log('login_ok');

    // ---------- 2. 予約一覧へ ----------
    await openReservationList(page);
    // 検索フォームは折りたたまれている場合があるため「存在（attached）」で待つ
    await page.waitForSelector('#performSt02', { state: 'attached', timeout: 30000 });
    log('list_page_opened', { url: page.url() });

    // ---------- 3. 実施日 from=今日 / to=今日+RANGE_DAYS で検索 ----------
    const today = new Date();
    const to = new Date(); to.setDate(today.getDate() + CONFIG.rangeDays);
    await fillDate(page, '#performSt02', today);
    await fillDate(page, '#performEnd02', to);
    // 検索ボタンが隠れている可能性があるので force クリック
    await page.getByRole('button', { name: '条件で検索する' }).click({ force: true });
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1500);
    log('search_done');

    // ---------- 4. 結果を読み取り（ページ送り対応） ----------
    const all = [];
    for (let p = 0; p < 30; p++) {
      const rows = await page.$$eval('tr.date-url-target', (trs) => trs.map((tr) => {
        const url = tr.getAttribute('data-url') || '';
        const bookingNo = (url.match(/(\d{6,})/) || [])[1] || (tr.querySelector('small') ? tr.querySelector('small').textContent.trim() : '');
        // ステータスbadge
        const badge = tr.querySelector('.badge');
        const status = badge ? badge.textContent.replace(/\s+/g, '').trim() : '';
        // 実施日セル：「2026-08-08 (土) 10:00」を含むtd
        let perform = '';
        tr.querySelectorAll('td').forEach(td => {
          const t = td.textContent.replace(/\s+/g, ' ').trim();
          if (/\d{4}-\d{1,2}-\d{1,2}.*\d{1,2}:\d{2}/.test(t) && !perform) perform = t;
        });
        // 氏名（b要素の最初）
        const nameB = tr.querySelector('td b');
        const name = nameB ? nameB.textContent.trim() : '';
        // 人数：text-center セルの b（× N ではない単独数字）
        let people = '';
        const pc = tr.querySelector('td.text-center b.hidden-xs');
        if (pc) people = pc.textContent.trim();
        return { bookingNo, status, perform, name, people };
      }));
      rows.forEach(r => all.push(r));
      log('page_read', { page: p + 1, rows: rows.length, total: all.length });

      // 次ページ（ページネーションの「次」）
      const next = page.locator('.pagination a[rel=next], .pagination li.next a, a[aria-label="Next"]').first();
      if (await next.count() === 0 || !(await next.isVisible().catch(() => false))) break;
      await next.click();
      await page.waitForTimeout(1500);
    }

    // ---------- 5. 体験日が今日以降に整形（キャンセルは除外して有効のみ） ----------
    const todayStr = ymd(today);
    const reservations = all.map((r) => {
      const m = String(r.perform).match(/(\d{4})-(\d{1,2})-(\d{1,2}).*?(\d{1,2}:\d{2})/);
      const date = m ? `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}` : '';
      const time = m ? m[4].padStart(5, '0') : '';
      // ステータス正規化
      let status = '確定';
      if (r.status.includes('キャンセル')) status = 'キャンセル';
      else if (r.status.includes('リクエスト')) status = '仮予約';
      return { bookingNo: r.bookingNo, status, date, time, name: r.name, people: parseInt(r.people, 10) || null };
    }).filter((r) => r.date && r.date >= todayStr);

    const result = {
      fetchedAt: new Date().toISOString(), site: 'アクティビティジャパン',
      totalFetched: all.length, totalFuture: reservations.length, today: todayStr, reservations,
    };
    fs.writeFileSync(CONFIG.outPath, JSON.stringify(result, null, 2));
    log('done', { fetched: all.length, future: reservations.length, out: CONFIG.outPath });

    console.log('\n===== 今日以降の予約（アクティビティジャパン）=====');
    for (const r of reservations) console.log(`${r.date} ${r.time} [${r.status}] ${r.bookingNo} ${r.name} ${r.people}名`);
  } catch (err) {
    log('error', { message: err.message });
    console.error('❌ エラー:', err.message);
    await page.screenshot({ path: 'reconcile-aj-error.png', fullPage: true }).catch(() => {});
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

// 「予約一覧」へ遷移する。リンクは /reserve/list（メニュー内に隠れているが実URL）。
async function openReservationList(page) {
  await page.goto(new URL('/reserve/list', page.url()).href, { waitUntil: 'networkidle' });
}

// 日付入力欄に値をセット。readonly の datepicker のため JS で直接値を書き込む。
async function fillDate(page, selector, d) {
  const val = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const ok = await page.evaluate(({ sel, v }) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    el.removeAttribute('readonly');
    el.value = v;
    // datepicker/フレームワークに変更を通知
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, { sel: selector, v: val });
  log(ok ? 'date_set' : 'date_box_missing', { selector, val });
}

main();
