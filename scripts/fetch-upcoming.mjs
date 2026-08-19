// 楽天ブックス書籍検索APIから「向こう数十日分」のコミック新刊予定をまとめて取得し、
// upcoming.json（日付ごと・出版社別）を生成するスクリプト。
//
// 毎日の本番更新（fetch-rakuten.mjs）とは別に、週1回程度の低頻度での実行を想定。
// 実行が長くなりすぎないよう、Kobo/Amazonのリンク付けは行わない（楽天リンクのみ）。
//
// 実行に必要な環境変数：
//   RAKUTEN_APP_ID / RAKUTEN_ACCESS_KEY / RAKUTEN_AFFILIATE_ID
//   UPCOMING_DAYS … 何日先まで取得するか（省略時は30）

import { writeFile } from "node:fs/promises";
import https from "node:https";

const APP_ID = process.env.RAKUTEN_APP_ID;
const ACCESS_KEY = process.env.RAKUTEN_ACCESS_KEY;
const AFFILIATE_ID = process.env.RAKUTEN_AFFILIATE_ID;
const UPCOMING_DAYS = parseInt(process.env.UPCOMING_DAYS || "30", 10);

if (!APP_ID || !ACCESS_KEY || !AFFILIATE_ID) {
  console.error("RAKUTEN_APP_ID / RAKUTEN_ACCESS_KEY / RAKUTEN_AFFILIATE_ID が必要です。");
  process.exit(1);
}

const COMIC_GENRE_ID = "001001";
const PRIORITY = ["集英社", "講談社", "小学館", "KADOKAWA"];

function todayJST() {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 10);
}

// YYYY-MM-DD文字列に日数を加算する。実行環境のタイムゾーンに左右されないよう、
// JST等の時刻情報を持たせず、暦日としてUTC基準で計算する
function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const utc = new Date(Date.UTC(y, m - 1, d));
  utc.setUTCDate(utc.getUTCDate() + days);
  const yy = utc.getUTCFullYear();
  const mm = String(utc.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(utc.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

function normalizeSalesDate(salesDate) {
  const m = (salesDate || "").match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (!m) return null;
  const [, y, mo, d] = m;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function httpsGet(url, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: "GET", headers }, (res) => {
      let body = "";
      res.setEncoding("utf-8");
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function fetchPage(page, retry = 0) {
  const url = new URL("https://openapi.rakuten.co.jp/services/api/BooksBook/Search/20170404");
  url.searchParams.set("format", "json");
  url.searchParams.set("applicationId", APP_ID);
  url.searchParams.set("accessKey", ACCESS_KEY);
  url.searchParams.set("affiliateId", AFFILIATE_ID);
  url.searchParams.set("booksGenreId", COMIC_GENRE_ID);
  url.searchParams.set("sort", "-releaseDate");
  url.searchParams.set("hits", "30");
  url.searchParams.set("page", String(page));

  const { status, body } = await httpsGet(url, {
    Referer: "https://shinkandana.jp/",
    Origin: "https://shinkandana.jp",
  });

  if (status === 429 && retry < 5) {
    const waitMs = 3000 * (retry + 1);
    console.log(`429が返ってきたため ${waitMs}ms 待って再試行します`);
    await sleep(waitMs);
    return fetchPage(page, retry + 1);
  }
  if (status < 200 || status >= 300) {
    throw new Error(`楽天API呼び出し失敗: ${status} ${body}`);
  }
  return JSON.parse(body);
}

// 指定した日付の新刊を探す（pageCacheを使い回して呼び出し回数を抑える）
async function findReleasesForDate(target, pageCount, pageCache) {
  async function getPage(page) {
    if (pageCache.has(page)) return pageCache.get(page);
    const data = await fetchPage(page);
    pageCache.set(page, data);
    await sleep(1200);
    return data;
  }

  function firstDateOnPage(data) {
    const item = data.Items?.[0]?.Item;
    return item ? normalizeSalesDate(item.salesDate || "") : null;
  }

  let lo = 1;
  let hi = pageCount;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const data = await getPage(mid);
    const d = firstDateOnPage(data);
    if (d && d <= target) {
      hi = mid;
    } else {
      lo = mid + 1;
    }
  }

  const collected = [];
  let page = Math.max(1, lo - 1);
  let sawTarget = false;
  let pastTarget = false;

  while (page <= Math.min(pageCount, lo + 20) && !pastTarget) {
    const data = await getPage(page);
    const items = data.Items ?? [];
    let allOlderOnThisPage = items.length > 0;

    for (const wrap of items) {
      const item = wrap.Item;
      const normalized = normalizeSalesDate(item.salesDate || "");
      if (normalized === target) {
        collected.push(item);
        sawTarget = true;
        allOlderOnThisPage = false;
      } else if (normalized && normalized > target) {
        allOlderOnThisPage = false;
      }
    }
    if (sawTarget && allOlderOnThisPage) pastTarget = true;
    page += 1;
  }

  return collected;
}

function extractVolume(title) {
  const m = title.match(/[（(](\d+)[）)]|(\d+)\s*巻?\s*$/);
  if (!m) return null;
  const n = m[1] || m[2];
  return n ? parseInt(n, 10) : null;
}

function groupAndSort(items) {
  const byPublisher = new Map();
  for (const item of items) {
    const pub = item.publisherName || "その他";
    if (!byPublisher.has(pub)) byPublisher.set(pub, []);
    byPublisher.get(pub).push({
      title: item.title,
      author: item.author || "",
      image: item.largeImageUrl || item.mediumImageUrl || "",
      rakuten: item.affiliateUrl || item.itemUrl || "",
    });
  }
  const publishers = Array.from(byPublisher.entries()).map(([name, titles]) => ({ name, titles }));

  for (const pub of publishers) {
    pub.titles.sort((a, b) => {
      const va = extractVolume(a.title);
      const vb = extractVolume(b.title);
      if (va === null && vb === null) return 0;
      if (va === null) return 1;
      if (vb === null) return -1;
      return vb - va;
    });
  }

  publishers.sort((a, b) => {
    const ai = PRIORITY.indexOf(a.name);
    const bi = PRIORITY.indexOf(b.name);
    const aRank = ai === -1 ? PRIORITY.length : ai;
    const bRank = bi === -1 ? PRIORITY.length : bi;
    return aRank - bRank;
  });

  return publishers;
}

async function main() {
  const today = todayJST();
  console.log(`対象期間: ${today} から ${UPCOMING_DAYS}日分`);

  const first = await fetchPage(1);
  await sleep(1200);
  const pageCount = first.pageCount ?? 1;
  console.log("総ページ数:", pageCount, "（全体件数:", first.count, "）");

  const pageCache = new Map();
  pageCache.set(1, first);

  const days = [];
  for (let i = 0; i < UPCOMING_DAYS; i++) {
    const target = addDays(today, i);
    const items = await findReleasesForDate(target, pageCount, pageCache);
    console.log(`${target}: ${items.length}件`);
    if (items.length > 0) {
      days.push({ date: target, publishers: groupAndSort(items) });
    }
  }

  const data = {
    generatedAt: new Date().toISOString(),
    startDate: today,
    rangeDays: UPCOMING_DAYS,
    days,
  };

  await writeFile(new URL("../upcoming.json", import.meta.url), JSON.stringify(data, null, 2) + "\n", "utf-8");
  console.log(`upcoming.json を更新しました（${days.length}日分）`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
