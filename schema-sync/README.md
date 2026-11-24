# schema-sync

讓 `schema-sync/diagram.json` 和開著的 ChartDB 分頁保持同一張圖，走 `/schema-sync`
這個 WebSocket（`vite` 和 `vite preview` 都有）。

- **啟動（用 production build，dev 模式拖曳只有一半的 fps）：**
  `npx vite build`，再 `npx vite preview --host 100.64.0.11 --port 5180`，打開
  http://100.64.0.11:5180/ 就會載入檔案裡的圖。改了 ChartDB 的程式碼才需要重新 build。
- **從資料庫產生圖：** `node schema-sync/from-postgres.mjs [database-url]`，預設讀
  本機 teloi 的資料庫。表的位置、大小、顏色，還有你畫的 area 和 note 都會保留。
  加 `--stdout` 只印出、不寫檔，可以拿來和檔案比對，看畫面上改了什麼。
- **在畫面上改：** 0.3 秒後寫進檔案。
- **改檔案：** 每個分頁整張重新載入，undo 會清掉。
- **一次一個人改：** 同時改會互相蓋掉。

`from-postgres.mjs` 開頭的註解寫了圖怎麼畫 Teloi 的慣例。
