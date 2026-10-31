# Flovia X検索接続 PoC

Issue [#4](https://github.com/YanTKYS/poc-lab/issues/4) の独立したサーバー側 PoC。定期実行や他リポジトリへの展開はしない。GitHub Pages のビルド対象にも含めない。

**判定: 保留。実サービスの状態応答は確認されたが、SDK契約の整合性とXツール提供可否は未確認。投稿取得・検索品質は未検証。** モックの成功は実測の成功として扱わない。

## 現時点の安全上の判断

2026-10-31 に npm の `latest` が公式 `@flovialabs/sdk` **0.1.15** であることを確認し、README、型定義、実装を照合した。SDK は Node.js 20 以上をサポートし、この PoC は既存 CI と同じ Node.js 22 で動かす。

- `status()` は `flovia_status`、`listTools()` は `tools/list` を呼ぶ。状態確認とツール一覧はデータ検索ではない。
- X検索の正式な例は `flovia_x`、`action: search_recent`、`query`、`max_results: 10`、`request_text`、`purpose`、保存済み `operation_id` を使う。直近7日の1ページを読む形式である。
- SDK README はデータ検索が **無料枠または購入残高を使う** と説明している。無料枠の残りがあること、購入残高がゼロであることだけでは、リクエストが無料枠内に収まる保証にならない。
- 確認した SDK 仕様にサーバー側で有料利用を禁止する指定は見つからない。このため **この版にはデータ検索を送るコードを入れていない**。`free_only` 等の未確認の引数を創作しない。
- `free_pending`、停止、同意未確認、無料枠不明・枯渇、契約バージョン不一致等では最初の状態確認直後に停止する。条件を満たしても検索は `free_only_not_guaranteed` としてスキップする。停止理由は SDK の公表済みフィールドに基づく保守的な判定であり、検索可能性の認定ではない。
- API の再送、ページ送り、同意への自動回答、課金・購入・有料残高へのフォールバックはしない。SDK のリトライは明示的に無効化する。

2026-10-31 に公式 [Quickstart](https://docs.flovia.dev/get-started/quickstart/)、[接続確認](https://docs.flovia.dev/connect/check/)、[最初の検索](https://docs.flovia.dev/get-started/first-lookup/)、[無料／有料](https://docs.flovia.dev/usage/)、[他クライアント](https://docs.flovia.dev/connect/other-clients/)、[公式全文](https://docs.flovia.dev/llms-full.txt) を確認した。接続確認はデータソースへ問い合わせず、無料枠で全体を賄えない照会には購入残高が使われるという説明は SDK README と一致する。確認した資料に無料限定を強制する正式な指定は見つからず、検索は引き続きスキップする。

SDK の `StatusReply.contract_version` は文字列で、`EXPECTED_CONTRACT_VERSION` は `2026-10-07.151`。SDK の `status()` は不一致時に警告するが、互換性を保証する処理ではない。この PoC はそれより厳しく不一致で停止する。公式 Web ドキュメントと現行 SDK を照合した範囲では、今回のサーバー実契約番号や、異なる契約との互換性を確定する対応表は見つからなかった。最新版も同じ SDK のため、依存バージョン・期待契約を根拠なく変更しない。

## 実行方法

リポジトリの Actions Secret `FLOVIA_API_KEY` を使う。下記の実測では状態応答を取得できた。開発環境から Secret 一覧を読む権限はなく、値・一覧を取得する必要はない。値をチャット、コード、コマンド引数、ログに貼らない。

1. `Flovia manual PoC` は PR #5 のマージで既定ブランチに登録済み。現在は下記の契約不一致を調査中のため再実行していない。現行仕様との整合が確認できた場合に限り、GitHub Actions の **Run workflow** から状態・一覧確認を **手動1回だけ**実行する。実行のために PR を自動マージしない。
2. ジョブの `Read status without performing a data lookup` ステップだけに `FLOVIA_KEY: ${{ secrets.FLOVIA_API_KEY }}` を注入する。インストール・テストには渡さない。
3. `flovia-poc-<run_id>-<attempt>` アーティファクト内の `report.json` を確認する。保存期間は7日。成果物は公開リポジトリの閲覧者にも読まれ得るものとして扱い、アカウントIDや任意文字列を保存しない。
4. `error` は異常終了、`stopped` は利用条件の確認段階で停止、`checked_search_skipped` は状態確認・一覧確認済みで検索は未実行を意味する。成功終了を「検索成功」と解釈しない。エラー時も勝手に再実行せず、原因を確認する。

実行可能な接続がある場合のローカル手順:

```sh
cd flovia
npm ci --ignore-scripts --no-audit --no-fund
npm test                          # 全件モック、Floviaへ通信しない
# FLOVIA_KEY が安全に注入されている場合だけ:
npm run check
```

SDK のキーファイルへの自動フォールバックは使わない。`FLOVIA_KEY` がなければネットワーク呼出し前に停止する。結果は Git 無視対象の `flovia/results/report.json` に書く。起動時に Secret を表示するコマンド、シェルのトレース、SDK の生レスポンス出力を使わない。

## 記録する項目と停止条件

`report.json` には実行時刻、各呼出しの所要時間、SDK契約一致の真偽と下記の契約診断、許可済みの状態ラベル、5時間／週間の使用率・リセット日時、X提供の真偽を記録する。未取得・判読不能は `null` または `unrecognized`。購入残高は停止判定に使わないため、実額も残高の有無もレポートに含めない。5時間／週間の使用率も公開アーティファクトから閲覧され得る情報である。この使用率はアカウント全体の期間状態であり、この実行の課金額を示すものではない。データ検索は行わないため投稿件数は `null`（0件取得とは異なる）、品質は `unverified`。

レポートには生の本文、Authorizationヘッダー、環境変数、任意のエラーメッセージ、通知文、ツール説明・スキーマを出さない。未知のエラーコードも固定の `unclassified_error` に置き換える。401、403、429、無料枠の枯渇、ツール無効、ネットワークエラー、人による操作が必要な状態を区別する。`executed: unknown` を「未実行」とみなさない。通知・同意が必要な場合は停止し、Console で正式な通知を読んで本人が対応する。エージェントが同意を代行しない。

## 契約不一致の診断

`contract_matches_sdk` は SDK の期待値との完全一致だけで判定し、不一致・欠落・不正値では従来どおり `contract_mismatch` で停止する。診断を追加しても一覧取得に進める契約を増やさない。SDK の任意文字列を含む警告もログには出さない。

| `contract_version_state` | 意味 | `observed_contract_version` |
| --- | --- | --- |
| `matches_sdk` | SDK期待値と完全一致 | 形式検証済みの値 |
| `different_version` | 公開用の形式には合うがSDK期待値と異なる | 形式検証済みの値 |
| `missing` | 項目が存在しない | `null` |
| `null` | 項目が明示的にnull | `null` |
| `invalid_type` | 文字列以外 | `null` |
| `invalid_format` | 空文字、任意文字列、不正な日付・形式など | `null` |

公開用の形式は `20YY-MM-DD.N`（実在する日付、Nは先頭ゼロなしの1〜6桁）に限定し、文字列全体を検査する。前後の空白・改行、ヘッダー・キー等の任意文字列を切り取って公開することもしない。これはこのレポートの公開制約であり、Flovia公式の契約番号文法・互換性を認定するルールではない。形式が正しい別バージョンも停止対象である。テストの `2026-10-31.152` は架空の入力例で、観測したサーバー番号ではない。

## 実測（2026-10-31）

[Issue の実行報告](https://github.com/YanTKYS/poc-lab/issues/4#issuecomment-6542098589) と [Actions run #41191707740](https://github.com/YanTKYS/poc-lab/actions/runs/41191707740) を記録する。対象は PR #5 マージ後の main `8b214680118c6b9ed6f739fbeccfb2ef301fb47d`、SDK 0.1.15。実行メタデータの成功・対象SHAを照合し、以下の応答内容は Issue に記載されたレポート抜粋に基づく。

- ワークフローは成功、モック38件成功。`flovia_status` の応答は約615ms。
- `outcome=stopped`、`stop_reason=contract_mismatch`、`phase=status_before`。
- `contract_matches_sdk=false`、SDK期待契約 `2026-10-07.151`。旧レポートにはサーバーの実契約番号・項目の有無を残していないため、番号差・欠落・不正値のどれかは判定不能。今回追加した診断を過去の実測結果として扱わない。
- 報告された状態は `stage=alpha`、5時間／週間の使用率はともに0%、`free_pending=false`、`stopped=false`、`data_consent_needed=false`、`data_consent_answer=y`、`x_disabled=false`。
- `tools/list` は未実行、`x_offered=null`。`x_disabled=false` はキーに `flovia_x` が提供されることの確認にはならない。検索・有料照会・再送は未実行。

接続・認証は状態応答を受け取れる範囲で一部確認できた。契約不一致は API利用不可・無料枠なしの証拠ではない。SDK／サーバーの整合性が未確認のため、今回の調査では新たな手動実行は行わず、Xデータ検索も行っていない。Issue #4 は継続する。

## 検証結果

| 項目 | 状態 |
| --- | --- |
| SDKの実際の通信処理をモックした status → tools/list → status | ローカルテスト成功（実通信ではない） |
| 無料枠残量あり・購入残高ありでも検索しない | テスト成功 |
| pending、停止、同意未確認、5時間／週間枯渇、契約変更 | 最初の状態確認後に停止するテスト成功 |
| 401/403、429、無料枠エラー、タイムアウト、通知・同意要求 | 分類・再送なしのテスト成功 |
| Secretを含む任意のエラー・状態文字列 | レポートへ出さないテスト成功 |
| 購入残高（ゼロ・正数・未知の形式・未取得）、前後で異なる残高 | 実額・残高フィールドをレポートへ出さないテスト成功 |
| 手動ワークフローの起動 | PR #5 マージ前は404。マージ後の run #41191707740 は成功 |
| GitHub Actions上の状態応答 | 上記実測で応答あり。契約不一致で安全停止。Xツール一覧は未確認 |
| 契約診断と停止 | 欠落・null・型不正・不正形式・異なる版で一覧取得に進まないモックテスト成功。新診断による実測は未実行 |
| X投稿取得、ID、公開日時、URL、日本語検索、レスポンス構造・品質 | 未検証（無料限定を保証できず検索機能を停止） |

ネットワーク不要のテストだけを `Flovia offline tests` で PR／main push 時に実行する。このワークフローには Secret 注入も実行用スクリプト呼出しもない。既存 Pages ワークフローとルートの依存関係・ビルド対象は変更しない。

## 次の判断

まず契約診断を含む別PRをレビューする。必要な診断実行の進め方を決め、サーバー実契約・公式仕様・SDKとの整合を確認するまでは状態・ツール一覧確認を再実行しない。整合が確認できた場合に限り手動1回の確認に進み、勝手な再送はしない。無料限定を保証する正式な仕組みがない場合、この条件ではX検索PoCの採否は **保留** とする。`ai-watch` / `news-watch` にはまだ採用しない。

保証できる正式仕様が確認された場合に限り、別の変更でライブスキーマ／カタログの引数を確認し、保存済み operation ID を使った直近7日・日本語の生成AI関連公開投稿の最小1ページ検索を1回実装・実行する。必要なID・日時・返却URLだけを許可リストで抽出し、投稿本文・ユーザー情報を保存しない。今の版に検索を有効化するスイッチはない。

## 参考

- [公式 SDK 0.1.15（npm）](https://www.npmjs.com/package/@flovialabs/sdk/v/0.1.15)
- [Quickstart](https://docs.flovia.dev/get-started/quickstart/)
- [接続確認](https://docs.flovia.dev/connect/check/)
- [最初の検索](https://docs.flovia.dev/get-started/first-lookup/)
- [使用量・無料／有料](https://docs.flovia.dev/usage/)
- [他クライアント](https://docs.flovia.dev/connect/other-clients/)
