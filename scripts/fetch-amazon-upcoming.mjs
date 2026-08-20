// Amazon Creators APIを使って、upcoming.json内の各タイトルに
// Amazonの商品リンク（amazon欄・kindle欄）を紐付けるスクリプト。
// ロジックはfetch-amazon.mjsと同じだが、data.jsonではなくupcoming.json
// （日付ごとにpublishersがネストした構造）を対象にする。
//
// 実行に必要な環境変数：
//   AMAZON_CREDENTIAL_ID / AMAZON_CREDENTIAL_SECRET / AMAZON_PARTNER_TAG

import { readFile, writeFile } from "node:fs/promises";
import https from "node:https";

const CREDENTIAL_ID = process.env.AMAZON_CREDENTIAL_ID?.trim();
const CREDENTIAL_SECRET = process.env.AMAZON_CREDENTIAL_SECRET?.trim();
const PARTNER_TAG = process.env.AMAZON_PARTNER_TAG?.trim();

for (const [name, value] of Object.entries({
  AMAZON_CREDENTIAL_ID: CREDENTIAL_ID,
  AMAZON_CREDENTIAL_SECRET: CREDENTIAL_SECRET,
  AMAZON_PARTNER_TAG: PARTNER_TAG,
})) {
  if (!value) {
    console.error(`環境変数 ${name} が設定されていません。`);
    process.exit(1);
  }
}

const MARKETPLACE = "www.amazon.co.jp";

function httpsRequest(url, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method, headers }, (res) => {
      let data = "";
      res.setEncoding("utf-8");
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function getAccessToken() {
  const basicAuth = Buffer.from(`${CREDENTIAL_ID}:${CREDENTIAL_SECRET}`).toString("base64");
  const payload = new URLSearchParams({
    grant_type: "client_credentials",
    scope: "creatorsapi::default",
  }).toString();

  const { status, body } = await httpsRequest("https://api.amazon.co.jp/auth/o2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      Authorization: `Basic ${basicAuth}`,
      "Content-Length": Buffer.byteLength(payload),
    },
    body: payload,
  });

  if (status < 200 || status >= 300) {
    throw new Error(`アクセストークン取得失敗: ${status} ${body}`);
  }
  const data = JSON.parse(body);
  return data.access_token;
}

async function searchItem(token, keywords, retry = 0) {
  const payload = JSON.stringify({
    keywords,
    partnerTag: PARTNER_TAG,
    partnerType: "Associates",
    marketplace: MARKETPLACE,
    resources: ["itemInfo.title", "itemInfo.classifications"],
  });

  const { status, body } = await httpsRequest("https://creatorsapi.amazon/catalog/v1/searchItems", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "x-marketplace": MARKETPLACE,
      "Content-Length": Buffer.byteLength(payload),
    },
    body: payload,
  });

  if (status === 429 && retry < 5) {
    const waitMs = 2000 * (retry + 1);
    console.log(`429が返ってきたため ${waitMs}ms 待って再試行します`);
    await sleep(waitMs);
    return searchItem(token, keywords, retry + 1);
  }

  if (status < 200 || status >= 300) {
    console.log(`Amazon検索失敗（${keywords}）: ${status} ${body}`);
    return [];
  }

  const data = JSON.parse(body);
  return data.searchResult?.items ?? data.SearchResult?.Items ?? [];
}

function isKindle(it) {
  const binding = it.itemInfo?.classifications?.binding?.displayValue || "";
  return /kindle|電子書籍/i.test(binding);
}

function pickBest(list, vol) {
  if (list.length === 0) return null;
  if (vol) {
    const sameVol = list.find((it) => {
      const t = it.itemInfo?.title?.displayValue || "";
      return new RegExp(`[（(]${vol}[）)]|(^|\\D)${vol}(\\D|$)`).test(t);
    });
    if (sameVol) return sameVol;
  }
  return list[0];
}

function normalizeForCompare(s) {
  return (s || "")
    .replace(/[〜～~]/g, "")
    .replace(/[　\s]/g, "")
    .replace(/[（(].*?[）)]/g, "")
    .replace(/[【】「」『』]/g, "");
}

function toLinks(items, title) {
  if (items.length === 0) return { amazon: "", kindle: "" };

  const seriesName = title.replace(/[（(]?\d+[）)]?\s*巻?\s*$/, "").trim();
  const normalizedSeries = normalizeForCompare(seriesName);
  const keyChunk = normalizedSeries.slice(0, Math.min(8, normalizedSeries.length));

  const relevant = items.filter((it) => {
    const t = normalizeForCompare(it.itemInfo?.title?.displayValue || "");
    return keyChunk && t.includes(keyChunk);
  });
  if (relevant.length === 0) return { amazon: "", kindle: "" };

  const volMatch = title.match(/[（(](\d+)[）)]|(\d+)\s*巻?$/);
  const vol = volMatch ? (volMatch[1] || volMatch[2]) : null;

  const kindleCandidates = relevant.filter(isKindle);
  const printCandidates = relevant.filter((it) => !isKindle(it));

  const printItem = pickBest(printCandidates.length > 0 ? printCandidates : relevant, vol);
  const kindleItem = pickBest(kindleCandidates, vol);

  return {
    amazon: printItem ? (printItem.detailPageURL || printItem.DetailPageURL || "") : "",
    kindle: kindleItem ? (kindleItem.detailPageURL || kindleItem.DetailPageURL || "") : "",
  };
}

async function findLinks(token, title, isbn) {
  let amazon = "";
  let kindle = "";

  if (isbn) {
    const isbnItems = await searchItem(token, isbn);
    const isbnResult = toLinks(isbnItems, title);
    amazon = isbnResult.amazon;
    kindle = isbnResult.kindle;
    await sleep(1000);
  }

  if (!amazon || !kindle) {
    const titleItems = await searchItem(token, title);
    const titleResult = toLinks(titleItems, title);
    if (!amazon) amazon = titleResult.amazon;
    if (!kindle) kindle = titleResult.kindle;
  }

  return { amazon, kindle };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const dataPath = new URL("../upcoming.json", import.meta.url);
  const raw = await readFile(dataPath, "utf-8");
  const data = JSON.parse(raw);

  console.log("アクセストークンを取得します…");
  const token = await getAccessToken();

  let foundAmazon = 0;
  let foundKindle = 0;
  let total = 0;

  for (const day of data.days ?? []) {
    for (const pub of day.publishers ?? []) {
      for (const t of pub.titles ?? []) {
        total += 1;
        if (t.amazon && t.kindle) continue;

        const { amazon, kindle } = await findLinks(token, t.title, t.isbn);
        if (!t.amazon && amazon) {
          t.amazon = amazon;
          foundAmazon += 1;
        }
        if (!t.kindle && kindle) {
          t.kindle = kindle;
          foundKindle += 1;
        }
        await sleep(1000);
      }
    }
  }

  console.log(`Amazon(紙)リンク: ${foundAmazon}/${total} 件見つかりました`);
  console.log(`Kindleリンク: ${foundKindle}/${total} 件見つかりました`);

  await writeFile(dataPath, JSON.stringify(data, null, 2) + "\n", "utf-8");
  console.log("upcoming.json を更新しました。");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
