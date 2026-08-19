// upcoming.json から、日付ごとに区切った「発売予定カレンダー」ページ（/upcoming/index.html）を
// 生成するスクリプト。build-archive.mjs と同じ見た目のカード形式を流用する。

import { readFile, writeFile, mkdir } from "node:fs/promises";

const SITE_URL = "https://shinkandana.jp";
const ACCENTS = ["var(--tag-a)", "var(--tag-b)", "var(--tag-c)", "var(--tag-d)"];
const DOW = ["日", "月", "火", "水", "木", "金", "土"];

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (s) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[s]));
}

function formatDateLabel(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日（${DOW[d.getDay()]}）`;
}

function renderCards(pub, accent) {
  return pub.titles.map((t) => `
        <div class="card" style="--accent:${accent}">
          <div class="thumb">
            ${t.image
              ? `<img src="${t.image}" alt="${escapeHtml(t.title)}の表紙" loading="lazy">`
              : `<span class="thumb-fallback">${escapeHtml((t.title || "?").charAt(0))}</span>`}
          </div>
          <div class="body">
            <div class="title">${escapeHtml(t.title)}</div>
            <div class="author">${escapeHtml(t.author || "")}</div>
            <div class="links">
              ${t.rakuten ? `<a href="${t.rakuten}" target="_blank" rel="nofollow sponsored noopener">楽天で見る</a>` : ""}
            </div>
          </div>
        </div>`).join("");
}

function renderDaySection(day, dayIndex) {
  const dateLabel = formatDateLabel(day.date);
  const pubSections = (day.publishers ?? [])
    .map((pub, i) => {
      const accent = ACCENTS[i % ACCENTS.length];
      return `
      <div class="publisher-head" style="--accent:${accent}">
        <span class="bar"></span>
        <h3 style="margin:0;">${escapeHtml(pub.name)}</h3>
        <span class="count">${pub.titles.length}冊</span>
      </div>
      <div class="titles">${renderCards(pub, accent)}
      </div>`;
    })
    .join("\n");

  return `
  <section class="publisher" id="day-${dayIndex}">
    <h2 style="font-family:'Noto Serif JP',serif; border-bottom:2px solid var(--ink); padding-bottom:8px;">${dateLabel}</h2>
    ${pubSections}
  </section>`;
}

function renderUpcomingPage(data) {
  const title = "発売予定カレンダー | 今日の新刊棚";
  const description = `向こう${data.rangeDays}日分のコミック新刊発売予定を、日付ごとにまとめています。`;

  const tocHtml = (data.days ?? [])
    .map((d, i) => `<a href="#day-${i}">${d.date.slice(5)}</a>`)
    .join("\n    ");

  const bodyMain = (data.days ?? []).length > 0
    ? data.days.map((d, i) => renderDaySection(d, i)).join("\n")
    : `<div class="empty">発売予定の情報がまだありません。</div>`;

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<link rel="canonical" href="${SITE_URL}/upcoming/">
<meta property="og:type" content="website">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:url" content="${SITE_URL}/upcoming/">
<meta property="og:site_name" content="今日の新刊棚">
<meta property="og:locale" content="ja_JP">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Noto+Serif+JP:wght@500;700;900&family=Noto+Sans+JP:wght@400;500;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/assets/style.css">
</head>
<body>

  <div class="disclosure">
    本サイトはAmazonアソシエイト・プログラム及び楽天アフィリエイトの参加者であり、商品の購入により収益を得ることがあります。
  </div>

  <div class="back-link"><a href="/">← 今日の新刊棚トップへ</a></div>

  <header>
    <p class="site-sub">今日の新刊棚</p>
    <h1 class="site-title">発売予定カレンダー</h1>
    <p class="site-sub" style="margin-top:8px;">向こう${data.rangeDays}日分の発売予定（予約段階の情報のため、変更されることがあります）</p>
  </header>

  <nav class="toc">
    ${tocHtml}
  </nav>

  <main>
    ${bodyMain}
  </main>

  <footer>
    <div class="inner">
      <h3>アフィリエイト表記</h3>
      <p>当サイトは、Amazon.co.jpを宣伝しリンクすることによって収入を得ることができる仕組みである、Amazonアソシエイト・プログラムの参加者です。また、楽天グループ株式会社が運営する「楽天アフィリエイト」の参加者でもあります。掲載されている商品リンクを経由して商品が購入された場合、当サイトに紹介料が支払われることがあります。</p>
      <p style="text-align:center; margin-top:24px;"><a href="/" style="text-decoration:underline;">今日の新刊棚トップへ</a></p>
      <p class="copyright">&copy; ${new Date().getFullYear()} 今日の新刊棚</p>
    </div>
  </footer>
</body>
</html>
`;
}

async function main() {
  const dataPath = new URL("../upcoming.json", import.meta.url);
  const data = JSON.parse(await readFile(dataPath, "utf-8"));

  const upcomingDir = new URL("../upcoming/", import.meta.url);
  await mkdir(upcomingDir, { recursive: true });

  const html = renderUpcomingPage(data);
  await writeFile(new URL("index.html", upcomingDir), html, "utf-8");
  console.log(`upcoming/index.html を書き出しました（${data.days.length}日分）`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
