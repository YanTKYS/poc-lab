# PoC Lab

技術検証（PoC）をまとめるリポジトリです。GitHub Pages で静的サイトとして公開しています。

公開先: <https://yantkys.github.io/poc-lab/>

| PoC | フォルダ | 概要 | 検証状況 |
| --- | --- | --- | --- |
| Pele と Mermaid.js の比較 | [`pele/`](pele/README.md) | 同じ Mermaid 記法を Pele と Mermaid.js で描画し、見た目・描画時間・互換性を比較する | 検証終了・採用保留 |
| Flovia X検索接続 | [`flovia/`](flovia/README.md) | 手動Actionsで状態・無料枠を確認。無料限定を保証できないため検索は停止 | 保留・実通信未検証 |

## 方針

- 公開物は静的ファイル（HTML / CSS / JS）だけで構成する。実行時に外部の CDN や API には依存しない。
- 依存ライブラリは GitHub Actions のビルド時に npm から取得し、バージョンは固定する。
- 参照はすべて相対パスで書く。GitHub Pages のサブパス（`/poc-lab/`）や IIS の任意の仮想ディレクトリにそのまま配置できるようにする。
- 各 PoC は独立したフォルダに置き、PoC 間で共通基盤は作らない。
- 各 PoC の検証結果と採用判断は、そのフォルダの `README.md` に残し、上の一覧に検証状況を記載する。

## 構成

```
index.html              トップページ（PoC 一覧）
pele/                   Pele 比較 PoC（README.md に検証結果）
scripts/build.mjs       dist/ へ静的ファイルを出力（ライブラリを vendor/ にコピー）
scripts/serve.mjs       dist/ を /poc-lab/ のサブパスで配信するローカル確認用サーバー
tests/                  Playwright による自動テスト
.github/workflows/      ビルド・テスト・GitHub Pages デプロイ
```

## 使い方

```sh
npm ci
npx playwright install chromium   # 初回のみ
npm run build                     # dist/ を出力
npm run serve                     # http://localhost:4173/poc-lab/
npm test
```

## 新しい PoC を追加する手順

1. リポジトリ直下に新しいフォルダ（例: `foo/`）を作り、`index.html` を置く。参照は相対パスで書く。
2. `scripts/build.mjs` の `POCS` にフォルダ名を追加する。npm のライブラリを使う場合は、同じスクリプトでそのフォルダの `vendor/` にコピーする処理を追加する。
3. トップページ `index.html` の一覧にリンクを追加する。
4. 必要に応じて `tests/` にテストを追加し、`foo/README.md` に検証内容・結果・採用判断をまとめ、この README の一覧の検証状況を更新する。

## デプロイ

`.github/workflows/pages.yml` の動作:

- pull request と main への push: ビルドと Playwright テストを実行する。
- main への push のときだけ: テストが通れば GitHub Pages にデプロイする。

初回だけ、リポジトリの Settings → Pages → Build and deployment → Source を「GitHub Actions」に設定する必要があります。

IIS に置く場合は、ワークフローの成果物（`github-pages` アーティファクト内の `artifact.tar` を展開したもの）か、ローカルで `npm run build` して作った `dist/` を、そのまま静的ファイルとして配置します。
