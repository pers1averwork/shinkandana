// 楽天ブックス書籍検索APIから「今日発売」のコミック新刊を取得し、
// data.json（出版社別）を生成するスクリプト。
//
// 実行に必要な環境変数：
//   RAKUTEN_APP_ID  … 楽天ウェブサービスで発行したアプリID
//
// 実行方法（ローカルで試す場合）：
//   RAKUTEN_APP_ID=xxxxxxxx node scripts/fetch-rakuten.mjs

import { writeFile } from "node:fs/promises";
import https from "node:https";

const APP_ID = process.env.RAKUTEN_APP_ID;
const ACCESS_KEY = process.env.RAKUTEN_ACCESS_KEY;
const AFFILIATE_ID = process.env.RAKUTEN_AFFILIATE_ID;
if (!APP_ID) {
  console.error("環境変数 RAKUTEN_APP_ID が設定されていません。");
  process.exit(1);
}
if (!ACCESS_KEY) {
  console.error("環境変数 RAKUTEN_ACCESS_KEY が設定されていません。");
  process.exit(1);
}
if (!AFFILIATE_ID) {
  console.error("環境変数 RAKUTEN_AFFILIATE_ID が設定されていません。");
  process.exit(1);
}

// 楽天ブックスの「コミック」ジャンルID（コミック全体）
const COMIC_GENRE_ID = "001001";

// 今日の日付（JST）を YYYY-MM-DD 形式で取得
function todayJST() {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 10);
}

// 楽天APIのsalesDateは「2026年08月08日」のような表記なので、
// YYYY-MM-DD と比較できる形に変換する
function normalizeSalesDate(salesDate) {
  const m = salesDate.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (!m) return null;
  const [, y, mo, d] = m;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

// fetch()はブラウザ仕様に合わせてRefererヘッダーの手動指定を無視してしまうため、
// Node標準のhttpsモジュールを使って直接リクエストを送る
function httpsGet(url, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      { method: "GET", headers },
      (res) => {
        let body = "";
        res.setEncoding("utf-8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      }
    );
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
  url.searchParams.set("sort", "-releaseDate"); // 発売日が新しい順
  url.searchParams.set("hits", "30");
  url.searchParams.set("page", String(page));

  const { status, body } = await httpsGet(url, {
    // 「許可されたWebサイト」に登録したドメインと一致させる（Refererだけでは通らずOriginも必要）
    Referer: "https://shinkandana.jp/",
    Origin: "https://shinkandana.jp",
  });

  // リクエストが立て込んで429(レート制限)が返ってきた場合は、少し待って数回まで再試行する
  if (status === 429 && retry < 5) {
    const waitMs = 3000 * (retry + 1);
    console.log(`429が返ってきたため ${waitMs}ms 待って再試行します (${retry + 1}回目)`);
    await new Promise((r) => setTimeout(r, waitMs));
    return fetchPage(page, retry + 1);
  }

  if (status < 200 || status >= 300) {
    throw new Error(`楽天API呼び出し失敗: ${status} ${body}`);
  }
  return JSON.parse(body);
}

async function fetchKoboLink(title, retry = 0) {
  const url = new URL("https://openapi.rakuten.co.jp/services/api/Kobo/EbookSearch/20170426");
  url.searchParams.set("format", "json");
  url.searchParams.set("applicationId", APP_ID);
  url.searchParams.set("accessKey", ACCESS_KEY);
  url.searchParams.set("affiliateId", AFFILIATE_ID);
  url.searchParams.set("title", title);
  url.searchParams.set("hits", "1");

  const { status, body } = await httpsGet(url, {
    Referer: "https://shinkandana.jp/",
    Origin: "https://shinkandana.jp",
  });

  if (status === 429 && retry < 5) {
    const waitMs = 3000 * (retry + 1);
    await sleep(waitMs);
    return fetchKoboLink(title, retry + 1);
  }

  if (status < 200 || status >= 300) {
    console.log(`Kobo検索失敗（${title}）: ${status}`);
    return "";
  }

  const data = JSON.parse(body);
  const item = data.Items?.[0]?.Item;
  return item ? (item.affiliateUrl || item.itemUrl || "") : "";
}

async function main() {
  const target = todayJST();
  console.log("対象日:", target);

  // 1回目：ページ数の全体像をつかむ
  const first = await fetchPage(1);
  await sleep(1500);
  const pageCount = first.pageCount ?? 1;
  console.log("総ページ数:", pageCount, "（全体件数:", first.count, "）");

  // ページ内の先頭アイテムの発売日を取得するヘルパー
  function firstDateOnPage(data) {
    const item = data.Items?.[0]?.Item;
    return item ? normalizeSalesDate(item.salesDate || "") : null;
  }

  // 二分探索で「発売日が対象日以下になる、最初のページ」を探す
  // （-releaseDateで新しい順＝未来の予約分も含めて日付が大きい順に並んでいるため）
  let lo = 1;
  let hi = pageCount;
  let firstPageData = first;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const data = mid === 1 ? firstPageData : await fetchPage(mid);
    if (mid !== 1) await sleep(1500);
    const d = firstDateOnPage(data);
    if (d && d <= target) {
      hi = mid;
    } else {
      lo = mid + 1;
    }
  }
  console.log("境界ページ:", lo);

  // 境界ページから前後数ページを実際に見て、対象日に一致するものを集める
  const collected = [];
  let page = Math.max(1, lo - 1);
  let sawTarget = false;
  let pastTarget = false;

  while (page <= Math.min(pageCount, lo + 20) && !pastTarget) {
    const data = await fetchPage(page);
    await sleep(1500);

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

    // 対象日のアイテムを既に見つけたあと、このページが全部対象日より古いなら打ち切り
    if (sawTarget && allOlderOnThisPage) {
      pastTarget = true;
    }
    page += 1;
  }

  console.log("取得件数:", collected.length);

  // それぞれのタイトルについて、楽天KoboのeBookリンクも検索して紐付ける
  console.log("Koboリンクを検索します…");
  const koboLinks = [];
  for (const item of collected) {
    const link = await fetchKoboLink(item.title);
    koboLinks.push(link);
    await sleep(1500);
  }

  // 出版社ごとにグループ化
  const byPublisher = new Map();
  collected.forEach((item, i) => {
    const pub = item.publisherName || "その他";
    if (!byPublisher.has(pub)) byPublisher.set(pub, []);
    byPublisher.get(pub).push({
      title: item.title,
      author: item.author || "",
      image: item.largeImageUrl || item.mediumImageUrl || "",
      amazon: "",
      rakuten: item.affiliateUrl || item.itemUrl || "",
      kindle: "",
      kobo: koboLinks[i] || "",
    });
  });

  const publishers = Array.from(byPublisher.entries()).map(([name, titles]) => ({
    name,
    titles,
  }));

  const koboFound = koboLinks.filter(Boolean).length;
  console.log(`Koboリンク: ${koboFound}/${collected.length} 件見つかりました`);

  const data = { date: target, publishers };

  await writeFile(new URL("../data.json", import.meta.url), JSON.stringify(data, null, 2) + "\n", "utf-8");
  console.log("data.json を更新しました。出版社数:", publishers.length);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
