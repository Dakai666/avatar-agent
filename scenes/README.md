# scenes/

把自訂背景圖放在這個資料夾（png / jpg / webp，檔名只能用英數、空白、`-`、`_`、`.`）。
這裡的圖片不會進版控（`.gitignore`），只有這份說明會。

- 除錯面板「場景」的下拉選單會列出這裡的圖片
- agent 用 `avatar_set_scene({ scene: "image", image: "檔名.png" })` 切換
- hub 只提供這個資料夾裡的圖片，不會讀其他路徑
