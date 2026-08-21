// サムネイルをクリック（タップ）すると、重なっているリンクボタンを表示する。
// もう一度サムネをクリック、リンク以外の場所をクリック、または別のサムネを開くと閉じる。
// index.html・archiveページ・upcomingページのすべてで共通して読み込まれる。

document.addEventListener("click", (e) => {
  const link = e.target.closest(".card .links a");
  if (link) {
    // リンク自体のクリックはそのまま遷移させる（トグル処理はしない）
    return;
  }

  const thumb = e.target.closest(".card .thumb");

  // 他に開いているサムネがあれば閉じる（同時に1つだけ開く）
  document.querySelectorAll(".card .thumb.show-links").forEach((t) => {
    if (t !== thumb) t.classList.remove("show-links");
  });

  if (thumb) {
    thumb.classList.toggle("show-links");
  }
});
