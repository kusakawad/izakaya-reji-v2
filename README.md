# 居酒屋レジ v2

[居酒屋レジ](https://github.com/kusakawad/izakaya-reji) の別バージョンです。機能はそのままに、画面を作り直しました。

- 画面構成は Apple Human Interface Guidelines、色・文字・部品はデジタル庁デザインシステムに沿っています。アイコンは [Lucide](https://lucide.dev)（ISC License）です。
- iPhone と iPad の両方で使えます。画面の幅が 768px 以上になると、左にサイドバー、注文と設定が2列のタブレット用の配置に自動で切り替わります。
- サーバーは不要です。データは使っている端末のブラウザの中にだけ保存されます。

## 公開（GitHub Pages）
Settings → Pages → Source を「Deploy from a branch」、Branch を `main` / `(root)` にして保存します。
数分後に `https://kusakawad.github.io/izakaya-reji-v2/` で開けます。

## iPhone・iPad でアプリとして使う
1. Safari で上の URL を開く
2. 共有ボタン →「ホーム画面に追加」
3. 以降はホーム画面のアイコンから起動する（一度開けばオフラインでも動きます）

## 元の居酒屋レジとの関係
- データの保存先は別です。こちらで操作しても、元の居酒屋レジの売上には影響しません。
- バックアップファイルの形式は同じです。元の居酒屋レジで保存したバックアップを「設定 › バックアップ › バックアップから復元」で読み込めます。逆も同じです。

## 更新するとき
`index.html` を差し替えたら、`sw.js` の `VERSION` を1つ上げてください。古い版がキャッシュに残るのを防ぎます。
