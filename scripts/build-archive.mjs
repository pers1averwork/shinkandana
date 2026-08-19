// data.json の内容から、その日専用の静的アーカイブページ（archive/YYYY-MM-DD.html）を生成し、
// あわせて一覧ページ（archive/index.html）とsitemap.xmlも更新するスクリプト。
//
// 特徴：JSでのfetchに頼らず、その日の新刊情報をHTMLに直接埋め込んだ「静的ページ」を作る。
// 検索エンジンがJSを実行しなくても中身を読み取れるようにするのが目的。

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";

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
            ${t.amazon ? `<a href="${t.amazon}" target="_blank" rel="nofollow sponsored noopener">Amazonで見る</a>` : ""}
            ${t.kindle ? `<a href="${t.kindle}" target="_blank" rel="nofollow sponsored noopener">Kindleで見る</a>` : ""}
            ${t.rakuten ? `<a href="${t.rakuten}" target="_blank" rel="nofollow sponsored noopener">楽天で見る</a>` : ""}
            ${t.kobo ? `<a href="${t.kobo}" target="_blank" rel="nofollow sponsored noopener">Koboで見る</a>` : ""}
          </div>
        </div>
      </div>`).join("");
}

function renderArchivePage(data) {
  const dateLabel = formatDateLabel(data.date);
  const title = `${dateLabel}発売のコミック新刊まとめ | 今日の新刊棚`;
  const description = `${dateLabel}に発売されたコミック新刊を出版社別にまとめています。`;

  const tocHtml = (data.publishers ?? [])
    .map((pub, i) => `<a href="#pub-${i}">${escapeHtml(pub.name)}</a>`)
    .join("\n    ");

  const sectionsHtml = (data.publishers ?? [])
    .map((pub, i) => {
      const accent = ACCENTS[i % ACCENTS.length];
      return `
    <section class="publisher" id="pub-${i}">
      <div class="publisher-head" style="--accent:${accent}">
        <span class="bar"></span>
        <h2>${escapeHtml(pub.name)}</h2>
        <span class="count">${pub.titles.length}冊</span>
      </div>
      <div class="titles">${renderCards(pub, accent)}
      </div>
    </section>`;
    })
    .join("\n");

  const bodyMain = (data.publishers ?? []).length > 0
    ? sectionsHtml
    : `<div class="empty">この日の新刊情報は登録されていません。</div>`;

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<link rel="canonical" href="${SITE_URL}/archive/${data.date}.html">

<meta property="og:type" content="article">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:url" content="${SITE_URL}/archive/${data.date}.html">
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

  <div class="back-link"><a href="/archive/">← 過去の新刊一覧に戻る</a></div>

  <header>
    <p class="site-sub">出版社別・コミック新刊まとめ</p>
    <h1 class="site-title"><a href="/">今日の新刊棚</a></h1>
    <p style="margin-top:8px; font-weight:700;">${dateLabel}発売分</p>
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

function renderIndexPage(dates) {
  const items = dates
    .slice()
    .sort((a, b) => (a < b ? 1 : -1)) // 新しい日付順
    .map((d) => `<li><a href="/archive/${d}.html">${formatDateLabel(d)}</a></li>`)
    .join("\n        ");

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>過去の新刊一覧 | 今日の新刊棚</title>
<meta name="description" content="今日の新刊棚に掲載した、過去のコミック新刊まとめ一覧です。">
<link rel="canonical" href="${SITE_URL}/archive/">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Noto+Serif+JP:wght@500;700;900&family=Noto+Sans+JP:wght@400;500;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/assets/style.css">
</head>
<body>

  <div class="back-link"><a href="/">← 今日の新刊棚トップへ</a></div>

  <header>
    <p class="site-sub">今日の新刊棚</p>
    <h1 class="site-title">過去の新刊一覧</h1>
  </header>

  <div class="archive-list">
    <ul>
        ${items}
    </ul>
  </div>

  <footer>
    <div class="inner">
      <p class="copyright">&copy; ${new Date().getFullYear()} 今日の新刊棚</p>
    </div>
  </footer>
</body>
</html>
`;
}

async function buildSitemap(dates) {
  const urls = [
    `  <url>\n    <loc>${SITE_URL}/</loc>\n    <changefreq>daily</changefreq>\n    <priority>1.0</priority>\n  </url>`,
    `  <url>\n    <loc>${SITE_URL}/archive/</loc>\n    <changefreq>daily</changefreq>\n    <priority>0.5</priority>\n  </url>`,
    ...dates.map(
      (d) => `  <url>\n    <loc>${SITE_URL}/archive/${d}.html</loc>\n    <changefreq>never</changefreq>\n    <priority>0.3</priority>\n  </url>`
    ),
  ];

  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
  await writeFile(new URL("../sitemap.xml", import.meta.url), xml, "utf-8");
}

async function main() {
  const dataPath = new URL("../data.json", import.meta.url);
  const data = JSON.parse(await readFile(dataPath, "utf-8"));

  const archiveDir = new URL("../archive/", import.meta.url);
  await mkdir(archiveDir, { recursive: true });

  // その日のアーカイブページを書き出す
  const pageHtml = renderArchivePage(data);
  await writeFile(new URL(`${data.date}.html`, archiveDir), pageHtml, "utf-8");
  console.log(`archive/${data.date}.html を書き出しました`);

  // 既存のアーカイブ日付を集める（すでにあるファイル一覧から.htmlの日付部分を拾う）
  const files = await readdir(archiveDir);
  const dates = files
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.html$/.test(f))
    .map((f) => f.replace(".html", ""));

  // 一覧ページを更新
  const indexHtml = renderIndexPage(dates);
  await writeFile(new URL("index.html", archiveDir), indexHtml, "utf-8");
  console.log(`archive/index.html を更新しました（${dates.length}件）`);

  // sitemap.xmlも更新
  await buildSitemap(dates);
  console.log("sitemap.xml を更新しました");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
