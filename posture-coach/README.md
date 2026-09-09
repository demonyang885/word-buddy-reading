# Posture Coach MVP v0.2

核心目標：先驗證 iPad 攝像頭能否穩定取得孩子寫作時的姿態信號，再做完整 UI、聲音提醒和產品化。

## Public test
GitHub Pages：

`https://demonyang885.github.io/word-buddy-reading/posture-coach/`

使用 iPad Safari 開啟，允許攝像頭權限。

## 已實現
- iPad Safari 前 / 後鏡頭
- MediaPipe Pose Landmarker
- GPU 優先、CPU fallback
- 頭部側傾 / 肩線傾斜 / 軀幹側傾
- 距離過近 proxy
- 6 秒個人 baseline 校準
- 校準穩定度檢查
- EMA 平滑 + 3 秒持續異常判斷
- Pose confidence / FPS
- Session 記錄與 CSV 匯出

## Mac mini 局域網測試

先 clone 現有 repo：

```bash
git clone https://github.com/demonyang885/word-buddy-reading.git
cd word-buddy-reading/posture-coach
```

安裝 / 產生本地 HTTPS 證書：

```bash
chmod +x setup_macos_https.sh
./setup_macos_https.sh
```

如無法自動找到 Mac mini LAN IP：

```bash
./setup_macos_https.sh 192.168.1.88
```

把 `mkcert -CAROOT` 顯示資料夾內的 `rootCA.pem` 傳到 iPad，安裝後到「設定 → 一般 → 關於本機 → 證書信任設定」啟用完全信任。

啟動：

```bash
python3 serve_https.py
```

然後 iPad Safari 打開：

`https://<Mac-mini-LAN-IP>:8443`

## 第一輪測試
1. 開啟鏡頭
2. 正常坐好，校準約 6 秒
3. 左右歪頭各 5 秒
4. 左右軀幹側傾各 5 秒
5. 進入自然寫字 10–20 分鐘
6. 開始記錄並匯出 CSV

第一輪重點不是消滅所有誤報，而是確認三個 signal 是否穩定、可分離、可重複。

詳細測試步驟見 `TEST_PROTOCOL.md`。

## Privacy
影像在瀏覽器裝置端進行姿態推理；此 MVP 不保存照片或影片，也不是醫療診斷工具。
