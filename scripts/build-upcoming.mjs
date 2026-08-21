// upcoming.json から、
//   /upcoming/index.html … 月間カレンダーグリッドのみのページ（各日付は個別ページへリンク）
//   /upcoming/YYYY-MM-DD.html … その日だけの発売予定ページ（カレンダー付き）
// を生成するスクリプト。

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

function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const utc = new Date(Date.UTC(y, m - 1, d));
  utc.setUTCDate(utc.getUTCDate() + days);
  const yy = utc.getUTCFullYear();
  const mm = String(utc.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(utc.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

// startDateから rangeDays 日分をカバーする月ごとのカレンダーグリッドを作る。
function renderCalendar(startDate, rangeDays, releaseDates, todayStr, currentDate) {
  const endDate = addDays(startDate, rangeDays - 1);
  const startD = new Date(startDate + "T00:00:00");
  const endD = new Date(endDate + "T00:00:00");

  const months = [];
  let cursor = new Date(startD.getFullYear(), startD.getMonth(), 1);
  const last = new Date(endD.getFullYear(), endD.getMonth(), 1);
  while (cursor <= last) {
    months.push({ year: cursor.getFullYear(), month: cursor.getMonth() });
    cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
  }

  return months
    .map(({ year, month }) => {
      const dowHeader = DOW.map((d) => `<div class="cal-dow">${d}</div>`).join("");
      const firstDow = new Date(year, month, 1).getDay();
      const daysInMonth = new Date(year, month + 1, 0).getDate();
      const blanks = Array.from({ length: firstDow }, () => `<div class="cal-cell"></div>`).join("");

      const cells = Array.from({ length: daysInMonth }, (_, i) => {
        const day = i + 1;
        const dateStr = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
        const isToday = dateStr === todayStr;
        const isCurrent = dateStr === currentDate;
        const hasRelease = releaseDates.has(dateStr);
        const classes = ["cal-cell"];
        if (hasRelease) classes.push("has-release");
        if (isToday) classes.push("today");
        if (isCurrent) classes.push("current-day");

        if (hasRelease && !isCurrent) {
          return `<div class="${classes.join(" ")}"><a href="/upcoming/${dateStr}.html">${day}<span class="dot"></span></a></div>`;
        }
        if (hasRelease && isCurrent) {
          return `<div class="${classes.join(" ")}"><span>${day}<span class="dot"></span></span></div>`;
        }
        return `<div class="${classes.join(" ")}">${day}</div>`;
      }).join("");

      return `
    <div class="cal-month-title">${year}年${month + 1}月</div>
    <div class="cal-grid">
      ${dowHeader}
      ${blanks}${cells}
    </div>`;
    })
    .join("\n");
}

function renderCards(pub, accent) {
  return pub.titles.map((t) => `
        <div class="card" style="--accent:${accent}">
          <div class="thumb">
            ${t.image
              ? `<img src="${t.image}" alt="${escapeHtml(t.title)}の表紙" loading="lazy">`
              : `<span class="thumb-fallback">${escapeHtml((t.title || "?").charAt(0))}</span>`}
            <div class="links">
              ${t.amazon ? `<a href="${t.amazon}" target="_blank" rel="nofollow sponsored noopener">Amazonで見る</a>` : ""}
              ${t.kindle ? `<a href="${t.kindle}" target="_blank" rel="nofollow sponsored noopener">Kindleで見る</a>` : ""}
              ${t.rakuten ? `<a href="${t.rakuten}" target="_blank" rel="nofollow sponsored noopener">楽天で見る</a>` : ""}
            </div>
          </div>
          <div class="body">
            <div class="title">${escapeHtml(t.title)}</div>
            <div class="author">${escapeHtml(t.author || "")}</div>
          </div>
        </div>`).join("");
}

function pageShell({ title, description, canonicalPath, bodyInner }) {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<link rel="canonical" href="${SITE_URL}${canonicalPath}">
<meta property="og:type" content="website">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:url" content="${SITE_URL}${canonicalPath}">
<meta property="og:site_name" content="今日の新刊棚">
<meta property="og:locale" content="ja_JP">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Noto+Serif+JP:wght@500;700;900&family=Noto+Sans+JP:wght@400;500;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/assets/style.css">
</head>
<body>
${bodyInner}
<script src="/assets/thumb-toggle.js" defer></script>
</body>
</html>
`;
}

function footerHtml() {
  return `
  <footer>
    <div class="inner">
      <h3>アフィリエイト表記</h3>
      <p>当サイトは、Amazon.co.jpを宣伝しリンクすることによって収入を得ることができる仕組みである、Amazonアソシエイト・プログラムの参加者です。また、楽天グループ株式会社が運営する「楽天アフィリエイト」の参加者でもあります。掲載されている商品リンクを経由して商品が購入された場合、当サイトに紹介料が支払われることがあります。</p>
      <p style="text-align:center; margin-top:24px;"><a href="/" style="text-decoration:underline;">今日の新刊棚トップへ</a></p>
      <p class="copyright">&copy; ${new Date().getFullYear()} 今日の新刊棚</p>
    </div>
  </footer>`;
}

function renderIndexPage(data, releaseDates, todayStr) {
  const title = "発売予定カレンダー | 今日の新刊棚";
  const description = `向こう${data.rangeDays}日分のコミック新刊発売予定を、カレンダー形式でまとめています。`;
  const calendarHtml = data.startDate
    ? renderCalendar(data.startDate, data.rangeDays, releaseDates, todayStr, null)
    : "";

  const bodyInner = `
  <div class="disclosure">
    本サイトはAmazonアソシエイト・プログラム及び楽天アフィリエイトの参加者であり、商品の購入により収益を得ることがあります。
  </div>

  <div class="back-link"><a href="/">← 今日の新刊棚トップへ</a></div>

  <header>
    <p class="site-sub">今日の新刊棚</p>
    <h1 class="site-title">発売予定カレンダー</h1>
    <p class="site-sub" style="margin-top:8px;">向こう${data.rangeDays}日分の発売予定（予約段階の情報のため、変更されることがあります）</p>
  </header>

  <nav class="site-nav">
    <a href="/archive/">📚 過去の新刊一覧</a>
  </nav>

  <div class="cal-wrap">
    ${calendarHtml}
  </div>
  ${releaseDates.size === 0 ? '<div class="empty">発売予定の情報がまだありません。</div>' : ""}
${footerHtml()}`;

  return pageShell({ title, description, canonicalPath: "/upcoming/", bodyInner });
}

function renderDayPage(data, day, releaseDates, todayStr) {
  const dateLabel = formatDateLabel(day.date);
  const title = `${dateLabel}発売予定のコミック新刊 | 今日の新刊棚`;
  const description = `${dateLabel}に発売予定のコミック新刊を、出版社別にまとめています（予約段階の情報です）。`;

  const calendarHtml = data.startDate
    ? renderCalendar(data.startDate, data.rangeDays, releaseDates, todayStr, day.date)
    : "";

  const pubSections = (day.publishers ?? [])
    .map((pub, i) => {
      const accent = ACCENTS[i % ACCENTS.length];
      return `
    <section class="publisher">
      <div class="publisher-head" style="--accent:${accent}">
        <span class="bar"></span>
        <h2 style="margin:0;">${escapeHtml(pub.name)}</h2>
        <span class="count">${pub.titles.length}冊</span>
      </div>
      <div class="titles">${renderCards(pub, accent)}
      </div>
    </section>`;
    })
    .join("\n");

  const bodyInner = `
  <div class="disclosure">
    本サイトはAmazonアソシエイト・プログラム及び楽天アフィリエイトの参加者であり、商品の購入により収益を得ることがあります。
  </div>

  <div class="back-link"><a href="/upcoming/">← 発売予定カレンダーに戻る</a></div>

  <header>
    <p class="site-sub">今日の新刊棚 / 発売予定</p>
    <h1 class="site-title" style="font-size:1.6rem;">${dateLabel}</h1>
    <p class="site-sub" style="margin-top:8px; font-size:0.78rem;">予約段階の情報のため、内容が変更されることがあります</p>
  </header>

  <div class="cal-wrap">
    ${calendarHtml}
  </div>

  <main>
    ${pubSections}
  </main>
${footerHtml()}`;

  return pageShell({ title, description, canonicalPath: `/upcoming/${day.date}.html`, bodyInner });
}

async function main() {
  const dataPath = new URL("../upcoming.json", import.meta.url);
  const data = JSON.parse(await readFile(dataPath, "utf-8"));

  const upcomingDir = new URL("../upcoming/", import.meta.url);
  await mkdir(upcomingDir, { recursive: true });

  const days = data.days ?? [];
  const releaseDates = new Set(days.map((d) => d.date));
  const todayStr = new Date().toISOString().slice(0, 10);

  const indexHtml = renderIndexPage(data, releaseDates, todayStr);
  await writeFile(new URL("index.html", upcomingDir), indexHtml, "utf-8");
  console.log(`upcoming/index.html を書き出しました（${days.length}日分）`);

  for (const day of days) {
    const html = renderDayPage(data, day, releaseDates, todayStr);
    await writeFile(new URL(`${day.date}.html`, upcomingDir), html, "utf-8");
  }
  console.log(`upcoming/YYYY-MM-DD.html を ${days.length}件 書き出しました`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
