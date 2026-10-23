# bike-fighter API

網頁的後端，跑在 Cloudflare Workers 上，資料存在 Cloudflare D1（SQLite）。

| 路徑 | 用途 |
| --- | --- |
| `GET /stations` | 台北市＋新北市 YouBike 2.0 站點與即時車數（合併、去重） |
| `POST /anger` | 送出一批怒氣；伺服器檢查後才記錄 |
| `GET /stats?sid=&type=&device=` | 單站的怒氣統計、目前的空站魔王 |
| `GET /events?limit=` | 最近結束的空站／滿站紀錄（需求紀錄） |
| `GET /ntpc?page=` | 新北市原始資料轉發（舊版網頁用） |
| 每分鐘排程 | 依即時車數開始／結束空站、滿站紀錄 |

## 伺服器檢查的項目

`POST /anger` 會依序檢查，任何一項不過就不記錄：

1. 站點存在
2. 手速：點擊數不超過「連擊時間 ÷ 0.06 秒」
3. 冷卻：同一個裝置 30 秒內只能送一批
4. 移動速度：和上一批的位置相比，不超過每秒 30 公尺
5. 距離：在站點 100 公尺內（GPS 誤差最多再寬限 50 公尺）

通過的會記錄下來；當下站點真的是 0 輛（或 0 位）才標為「計入需求」。

已知限制：裝置代號是瀏覽器自己產生的，清掉瀏覽器資料就能換一個新代號、繞過冷卻。要擋這個需要登入帳號。

## 資料量

排程只記錄「變成 0」和「恢復」的那一刻，不存每分鐘的歷史快照，所以寫入量很小，免費方案就夠用。

排程每分鐘也會把合併好的站點清單存成一份最新快照（只有一列，覆寫），`/stations` 直接讀它，不用每次等兩個市府伺服器。快照超過 3 分鐘沒更新時，才改成即時去問市府。

## 超過 D1 每日上限時

免費方案超過每日讀寫上限後，當天剩下的 D1 查詢會失敗，到隔天（UTC 午夜，台灣早上 8 點）才恢復：

- 地圖車數照常顯示：`/stations` 讀不到快照時會直接去問市府；就算整個 API 掛掉，網頁也會改成直接讀市府資料。
- 送出怒氣、統計、空站魔王、需求紀錄會暫停，網頁顯示「即時資料・離線」。

`/stats`（15 秒）和 `/events`（60 秒）的結果會暫存在 Worker 記憶體，同一站的多個使用者共用同一次查詢；自己送出怒氣後，那一站的暫存會立刻清掉。workers.dev 網址不能用 Cloudflare 的 Cache API，要用的話需要自己的網域。

## 第一次部署

1. **建立資料庫**：Cloudflare 後台 → **Storage & Databases** → **D1** → **Create database**，名稱填 `bike-fighter`。
2. 複製資料庫的 **Database ID**，填進 `wrangler.toml` 的 `database_id`（已填好）。
3. **連接 GitHub 自動部署**：Workers & Pages → `bike-fighter-api` → **Settings** → **Build** → 連接 repo `patty60723/bike-fighter`：
   - Branch：`main`
   - Root directory（根目錄）：`worker`
   - Deploy command（部署指令）：`npm run deploy`
4. 之後每次推到 `main`，Cloudflare 會自動套用資料庫變更（`migrations/`）並部署。

## 本機開發

```sh
cd worker
npm install
npm run migrate:local
npx wrangler dev --test-scheduled
```

沒有網路可以抓市府資料時，在 `worker/.dev.vars` 放一行 `STATION_FIXTURE='[...]'`（站點陣列，格式同 `/stations` 的 `stations`），API 就會改用這份假資料。這個檔案不會被提交。
