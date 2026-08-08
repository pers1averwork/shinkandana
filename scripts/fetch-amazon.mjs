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

const CREDENTIAL_ID = process.env.AMAZON_CREDENTIAL_ID;
const CREDENTIAL_SECRET = process.env.AMAZON_CREDENTIAL_SECRET;
const PARTNER_TAG = process.env.AMAZON_PARTNER_TAG;

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

// LWA(Login with Amazon)方式でアクセストークンを取得する
// 注意：エンドポイントはCredentialのVersionによって異なる
//   v3.1 (NA) → https://api.amazon.com/auth/o2/token
//   v3.2 (EU) → https://api.amazon.co.uk/auth/o2/token
//   v3.3 (FE/日本) → https://api.amazon.co.jp/auth/o2/token   ← 今回はこちら
async function getAccessToken() {
  const payload = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: CREDENTIAL_ID,
    client_secret: CREDENTIAL_SECRET,
    scope: "creatorsapi::default",
  }).toString();

  const { status, body } = await httpsRequest("https://api.amazon.co.jp/auth/o2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
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

async function searchItem(token, title, retry = 0) {
  const payload = JSON.stringify({
    keywords: title,
    partnerTag: PARTNER_TAG,
    partnerType: "Associates",
    marketplace: MARKETPLACE,
    resources: ["itemInfo.title"],
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
    return searchItem(token, title, retry + 1);
  }

  if (status < 200 || status >= 300) {
    console.log(`Amazon検索失敗（${title}）: ${status} ${body}`);
    return "";
  }

  const data = JSON.parse(body);
  const item = data.searchResult?.items?.[0] ?? data.SearchResult?.Items?.[0];
  return item?.detailPageUrl || item?.DetailPageURL || "";
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

  let found = 0;
  let total = 0;

  for (const pub of data.publishers ?? []) {
    for (const t of pub.titles ?? []) {
      total += 1;
      // すでにamazonリンクが入っている場合はスキップ（無駄なAPI呼び出しを避ける）
      if (t.amazon) continue;

      const link = await searchItem(token, t.title);
      if (link) {
        t.amazon = link;
        found += 1;
      }
      await sleep(1000);
    }
  }

  console.log(`Amazonリンク: ${found}/${total} 件見つかりました`);

  await writeFile(dataPath, JSON.stringify(data, null, 2) + "\n", "utf-8");
  console.log("data.json を更新しました。");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
