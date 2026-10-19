# 新北市資料轉發服務

新北市的 YouBike 即時資料伺服器不允許其他網站直接讀取（跨網域 CORS 限制），所以網頁會顯示「瀏覽器讀不到」。`worker.js` 是一個 Cloudflare Worker：它替網頁去抓新北市的資料，再加上允許讀取的標頭轉給網頁。

- 只轉發新北市 YouBike 這一份資料，不能拿來轉發其他網址。
- 只允許 `https://patty60723.github.io` 和本機測試用的 `http://localhost:8000` 讀取。
- 每頁資料在 Cloudflare 快取 60 秒，和新北市的更新頻率一致。

## 部署步驟（免費方案即可）

1. 到 [Cloudflare](https://dash.cloudflare.com/) 註冊或登入。
2. 左側選單選 **Workers & Pages** → **Create** → **Create Worker**。
3. 名稱填 `bike-fighter-proxy`，按 **Deploy**。
4. 部署完按 **Edit code**，把 `worker.js` 的內容整個貼上取代原本的程式，再按 **Deploy**。
5. 複製這個 Worker 的網址，長得像 `https://bike-fighter-proxy.<你的帳號>.workers.dev`。
6. 在瀏覽器打開 `<Worker 網址>/ntpc?page=0`，看到一大串 JSON 就代表成功。
7. 把網址填進 `index.html` 的 `PROXY_URL`（最後不要加 `/`），或直接把網址告訴 Claude 代填。
