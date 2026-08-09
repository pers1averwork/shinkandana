// Amazon Creators API（PA-APIの後継、OAuth 2.0ベース）を使って、
// data.json内の各タイトルに Amazon の商品リンク（amazon欄）を紐付けるスクリプト。
//
// 実行に必要な環境変数：
//   AMAZON_CREDENTIAL_ID      … Creators APIで発行したCredential ID
//   AMAZON_CREDENTIAL_SECRET  … Creators APIで発行したCredential Secret
//   AMAZON_PARTNER_TAG        … Amazonアソシエイトのトラッキングid（例: xxxxx-22）
//
// 実行方法（ローカルで試す場合）：
//   AMAZON_CREDENTIAL_ID=xxx AMAZON_CREDENTIAL_SECRET=xxx AMAZON_PARTNER_TAG=xxx-22 node scripts/fetch-amazon.mjs

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

// 値そのものは一切表示せず、長さと「trimで変化したか」だけ診断用に出す
// （Secretsのコピペミス・改行混入・値の取り違えがないか確認するため）
const rawIdLen = process.env.AMAZON_CREDENTIAL_ID?.length ?? 0;
const rawSecretLen = process.env.AMAZON_CREDENTIAL_SECRET?.length ?? 0;
console.log(`診断: AMAZON_CREDENTIAL_ID 長さ=${CREDENTIAL_ID.length}（trim前=${rawIdLen}）`);
console.log(`診断: AMAZON_CREDENTIAL_SECRET 長さ=${CREDENTIAL_SECRET.length}（trim前=${rawSecretLen}）`);
console.log(`診断: AMAZON_PARTNER_TAG 長さ=${PARTNER_TAG.length}`);

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

// LWA(Login with Amazon)方式でアクセストークンを取得する
// 注意：エンドポイントはCredentialのVersionによって異なる
//   v3.1 (NA) → https://api.amazon.com/auth/o2/token
//   v3.2 (EU) → https://api.amazon.co.uk/auth/o2/token
//   v3.3 (FE/日本) → https://api.amazon.co.jp/auth/o2/token   ← 今回はこちら
async function getAccessToken() {
  // client_id/client_secretは本文ではなく、標準的なOAuth2のBasic認証ヘッダーに載せる
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
  const items = data.searchResult?.items ?? data.SearchResult?.Items ?? [];

  if (debugCount < 3 && items.length > 0) {
    debugCount += 1;
    console.log(`診断（${keywords}）classifications=${JSON.stringify(items.map((it) => it.itemInfo?.classifications))}`);
  }

  return items;
}
let debugCount = 0;

// 分類情報から「Kindle版」と「紙の本」に振り分ける
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

// 波ダッシュ・半角チルダ・スペースなど表記ゆれを吸収するための正規化
function normalizeForCompare(s) {
  return (s || "")
    .replace(/[〜～~]/g, "") // 波ダッシュ系はまとめて除去
    .replace(/[　\s]/g, "") // 全角/半角スペースを除去
    .replace(/[（(].*?[）)]/g, "") // カッコ書き（巻数・副題の注記など）を除去
    .replace(/[【】「」『』]/g, ""); // 装飾カッコも除去
}

function toLinks(items, title) {
  if (items.length === 0) return { amazon: "", kindle: "" };

  // シリーズ名部分（巻数の前まで）を取り出し、正規化した上で
  // 検索結果のタイトルの「先頭部分」が含まれているものだけを候補にする
  // （厳しくしすぎると表記ゆれで正しい候補まで弾いてしまうため、判定は緩め）
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

// ISBNがあれば先にISBNで検索（ほぼ一意に絞れる）。見つからなければタイトルで検索する。
async function findLinks(token, title, isbn) {
  if (isbn) {
    const isbnItems = await searchItem(token, isbn);
    const isbnResult = toLinks(isbnItems, title);
    if (isbnResult.amazon || isbnResult.kindle) {
      return isbnResult;
    }
    await sleep(1000);
  }
  const titleItems = await searchItem(token, title);
  return toLinks(titleItems, title);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const dataPath = new URL("../data.json", import.meta.url);
  const raw = await readFile(dataPath, "utf-8");
  const data = JSON.parse(raw);

  console.log("アクセストークンを取得します…");
  const token = await getAccessToken();

  let foundAmazon = 0;
  let foundKindle = 0;
  let total = 0;

  for (const pub of data.publishers ?? []) {
    for (const t of pub.titles ?? []) {
      total += 1;
      // すでに両方埋まっている場合はスキップ（無駄なAPI呼び出しを避ける）
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
      if (!amazon && !kindle) {
        console.log(`見つからず: ${t.title}`);
      }
      await sleep(1000);
    }
  }

  console.log(`Amazon(紙)リンク: ${foundAmazon}/${total} 件見つかりました`);
  console.log(`Kindleリンク: ${foundKindle}/${total} 件見つかりました`);

  await writeFile(dataPath, JSON.stringify(data, null, 2) + "\n", "utf-8");
  console.log("data.json を更新しました。");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
