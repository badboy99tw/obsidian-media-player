---
title: Obsidian Media Player
tags:
  - project
  - obsidian
aliases: []
scope: personal
status: active
---

# Obsidian Media Player

Obsidian 本機音訊／影片播放器，支援可點擊與可寫回的文字時間點、變速和區段循環。執行階段不依賴第三方套件。

## 功能

- 播放 vault 內的音訊或影片。
- 點歌詞跳到時間點。
- 0.25× 至 2× 變速，慢速區間提供較細級距，並要求瀏覽器保持音高；選擇會寫入筆記的 `media_speed` property。
- 影片大小可選小（50%）、中（75%）或大（100%）；選擇會寫入筆記的 `media_size` property，儲存時間標記或重開 Obsidian 後仍會恢復。
- 前後跳五秒。
- A–B 區段循環：用「設 A」「設 B」選擇任意時間範圍，不依賴歌詞；循環關閉時拖曳會把 A–B 更新為新位置所在的歌詞，循環開啟時拖到區段外也會關閉循環並進行同樣的更新。
- 循環控制靠齊工具列右側，「設 A」「設 B」與「循環」收在同一個有邊框的功能群組。
- 單句循環：點歌詞就會選定該句到下一個較晚時間點的區段，之後開啟循環即重複該句；循環開啟時也可直接點別句切換，最後一句循環到媒體結尾。
- 連續標記時間：播放時可連續點各句記錄時間，最後一次寫回 Markdown code block。
- 「標記時間」與循環使用帶文字標籤的切換開關，開啟狀態由滑動圓點及 accent 色顯示。「標記時間」旁固定顯示「儲存標記（筆數）」按鈕；沒有待存內容時停用，有新標記時以 accent 色強調。關閉「標記時間」仍會自動儲存，避免誤關遺失。
- 分段標題：code block 裡的 `# 唱`、`# 口白` 等行會顯示在歌詞列表中，但不參與時間標記、跳轉或循環。

## Markdown 格式

````markdown
```media-player
title: Song
# Verse
--:-- | First lyric line
00:12.50 | Second lyric line
```
````

媒體預設從筆記的 `media_source` property 讀取，也可在 code block 裡以 `media:` 覆寫。音訊與影片共用格式，由副檔名自動決定播放器類型。

## 安裝

### BRAT

1. 在 Obsidian 安裝並啟用 [BRAT](https://github.com/TfTHacker/obsidian42-brat)。
2. 執行 **BRAT: Add a beta plugin for testing**。
3. 輸入 `badboy99tw/obsidian-media-player`。
4. 啟用 **Media Player**。

### 手動安裝

從 [GitHub Releases](https://github.com/badboy99tw/obsidian-media-player/releases) 下載 `main.js`、`manifest.json` 與 `styles.css`，放入 vault 的 `.obsidian/plugins/local-media-player/`，再於 Obsidian 啟用 **Media Player**。

## 開發與部署

這個資料夾是唯一原始碼正本：

- 原始碼：`projects/Obsidian Media Player/`
- Obsidian 執行中的部署副本：`.obsidian/plugins/local-media-player/`
- 不直接修改部署副本；所有變更先改原始碼並測試。

```sh
npm test
npm run deploy
```

也可以在 vault 根目錄執行：

```sh
make media-player-test
make media-player-deploy
```

`npm run deploy` 會先執行測試，再尋找上層包含 `.obsidian/` 的 vault，依 `manifest.json` 的 plugin ID 複製 `main.js`、`manifest.json` 與 `styles.css`，並核對來源與部署副本的 SHA-256。它也會在安裝目錄產生 `SOURCE.md`，提示原始碼位置與部署指令。部署後在 Obsidian 執行「Reload app without saving」。`lib.js` 只供測試使用。

影片大小與速度偏好保存在播放筆記的 YAML properties：`media_size: small`、`medium` 或 `large`，以及數值型的 `media_speed`。設定會隨筆記同步，不會寫進歌詞時間碼或修改媒體檔案。寫入 property 或儲存時間標記造成播放器重建時，外掛會交接目前的時間、播放狀態與音量。

## 發布

`manifest.json`、`package.json` 與 `versions.json` 的版本需保持一致。推送同版號的 Git tag（例如 `0.1.0`）後，GitHub Actions 會執行測試，並把 `main.js`、`manifest.json` 與 `styles.css` 附加到 GitHub Release。

## 參考

開發前曾研究 [Lyrics](https://github.com/eatgrass/obsidian-lyrics) 與 [Media Extended](https://github.com/aidenlx/media-extended) 的功能與使用方式；本專案是獨立實作，未從這兩個 repository 複製原始碼。

## License

[MIT](LICENSE) © 2026 Chìnkhun Lîm
