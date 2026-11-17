# あかり クラウド（akari-cloud）

居酒屋レジ「あかり」の **端末連携（クラウド）** で使う置き場所です。
Cloudflare Workers と Durable Objects（SQLite）で動きます。Cloudflare の無料プラン（Workers Free）で使えます。

## 設置のしかた

### ボタンで設置する

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/kusakawad/izakaya-reji-v2/tree/main/cloud)

1. 上のボタンを押し、Cloudflare と GitHub にログインします。
2. 名前は `akari-cloud` のままで「Create and deploy」を押します。
3. 表示された `https://akari-cloud.〇〇〇.workers.dev` を、あかりの「設定 › 端末連携（クラウド）」に貼り付けます。

### コマンドで設置する

```sh
cd cloud
npm install
npx wrangler login
npx wrangler deploy
```

## しくみ

- お店のキー（店舗キー）ごとに Durable Object `AkariShop` が1つでき、そのお店のデータ（テーブル・会計・設定）を持ちます。
- 端末は `/ws?key=店舗キー&dev=端末ID` に WebSocket でつなぎます。操作は1件ずつ順番に処理し、全端末へ最新の状態を配ります。
- 同じテーブルを複数の端末で同時に変えたときは、行ごとに数を足し引きしてまとめます（`mergeTable()`）。
- 会計番号はここで振ります（日ごとの連番）。
- 使用量（保存量・今日のリクエスト・今日の書き込み行数）を数えて端末に送り、あかりが上限の目安と比べて警告します。
- `/` を開くと `{"app":"akari-cloud","ok":true}` を返します（接続テスト用）。

## 無料プランの上限（目安）

| 項目 | 上限 |
|---|---|
| 保存量 | Durable Object 1つあたり 1GB（アカウント全体で 5GB） |
| リクエスト | 1日10万（WebSocket のメッセージは20通で1回） |
| 書き込み | 1日10万行 |

上限を超えると、その日の残りは操作がエラーになり（料金はかかりません）、日本時間の朝9時に戻ります。あかりは、その間は端末だけで動き、あとでまとめて送ります。
