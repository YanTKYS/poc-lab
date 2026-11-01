# Flovia X検索接続 PoC

Issue [#4](https://github.com/YanTKYS/poc-lab/issues/4) の独立したサーバー側 PoC。定期実行や他リポジトリへの展開はしない。GitHub Pages のビルド対象にも含めない。

**判定: 検証終了・X提供終了につき採用見送り（2026-11-01）。** 当初目的はFlovia経由のX公開投稿検索だったが、サービス側のXデータ提供終了の報告を受け、検証を終了する。`tools/list`・X投稿検索は未実施。以下のコード・手順・実測は検証記録として保持し、追加のAPI実行は行わない。

## 最終判断の根拠

[Issue #4 の最終状況報告](https://github.com/YanTKYS/poc-lab/issues/4#issuecomment-6553951409) によると、利用者が受信したFloviaの案内メール（共同創業者・CEO名義）に **「We’ve had to end X (Twitter) data on Flovia.」** と記載されていた。根拠は利用者提供のメール画像についての報告であり、メールの掲載日・発信元認証を別途検証したものではない。2026-11-01は本PoCの判断日である。

案内では代替措置として全ユーザーの無料利用量をリセットし、当面の無料枠を3.5倍に引き上げ、他のデータソースは継続・追加予定とされている。X提供の再開予定は示されていない。無料枠の増量は、X提供の再開や購入残高へのフォールバック防止を保証するものではない。

サービス側の提供終了により当初目的を達成できなくなったため、X検索PoCは採用見送りとする。過去に確認したのは状態応答と契約不一致による安全停止までであり、**「互換性問題でX取得に失敗した」とは記録しない**。X検索自体を試していないため、検索品質も未評価のままである。X以外のFloviaサービスは評価対象外で、Flovia全体の不採用を意味しない。

## 検証時の仕様確認と安全停止（過去の記録）

2026-10-31 に npm の `latest` が公式 `@flovialabs/sdk` **0.1.15** であることを確認し、README、型定義、実装を照合した。SDK は Node.js 20 以上をサポートし、この PoC は既存 CI と同じ Node.js 22 で動かす。

- `status()` は `flovia_status`、`listTools()` は `tools/list` を呼ぶ。状態確認とツール一覧はデータ検索ではない。
- 検証当時のSDK READMEにあったX検索の例は `flovia_x`、`action: search_recent`、`query`、`max_results: 10`、`request_text`、`purpose`、保存済み `operation_id` を使う。直近7日の1ページを読む形式である。
- SDK README はデータ検索が **無料枠または購入残高を使う** と説明している。無料枠の残りがあること、購入残高がゼロであることだけでは、リクエストが無料枠内に収まる保証にならない。
- 確認した SDK 仕様にサーバー側で有料利用を禁止する指定は見つからない。このため **この版にはデータ検索を送るコードを入れていない**。`free_only` 等の未確認の引数を創作しない。
- `free_pending`、停止、同意未確認、無料枠不明・枯渇、契約バージョン不一致等では最初の状態確認直後に停止する。条件を満たしても検索は `free_only_not_guaranteed` としてスキップする。停止理由は SDK の公表済みフィールドに基づく保守的な判定であり、検索可能性の認定ではない。
- API の再送、ページ送り、同意への自動回答、課金・購入・有料残高へのフォールバックはしない。SDK のリトライは明示的に無効化する。

2026-10-31 に公式 [Quickstart](https://docs.flovia.dev/get-started/quickstart/)、[接続確認](https://docs.flovia.dev/connect/check/)、[最初の検索](https://docs.flovia.dev/get-started/first-lookup/)、[無料／有料](https://docs.flovia.dev/usage/)、[他クライアント](https://docs.flovia.dev/connect/other-clients/)、[公式全文](https://docs.flovia.dev/llms-full.txt) を確認した。接続確認はデータソースへ問い合わせず、無料枠で全体を賄えない照会には購入残高が使われるという説明は SDK README と一致する。確認した資料に無料限定を強制する正式な指定は見つからず、当時のデータ検索は見送った。

SDK の `StatusReply.contract_version` は文字列で、`EXPECTED_CONTRACT_VERSION` は `2026-10-07.151`。SDK の `status()` は不一致時に警告するが、互換性を保証する処理ではない。この PoC はそれより厳しく不一致で停止する。2026-10-31 の公式資料・SDK調査では異なる契約との互換性を確定する対応表は見つからず、後述の2回目の実測でサーバー契約 `.164` を観測した。互換性は未確認のままで、依存バージョン・期待契約は変更していない。PoC終了に伴い、追加の互換性調査は行わない。

## 過去の実行方法（検証記録・再実行しない）

リポジトリの Actions Secret `FLOVIA_API_KEY` を使う。下記の実測では状態応答を取得できた。開発環境から Secret 一覧を読む権限はなく、値・一覧を取得する必要はない。値をチャット、コード、コマンド引数、ログに貼らない。

1. PR #6 で、GitHub Actions の **Flovia manual PoC → Run workflow** から `mode=status-only`（初期値）を指定する経路を用意し、下記の2回目の実測に利用した。登録済みの Actions Secret を使う設計だった。PoC終了後は両モードとも再実行しない。
2. ジョブの `Read the selected status mode without a data lookup` ステップだけに `FLOVIA_KEY: ${{ secrets.FLOVIA_API_KEY }}` を注入する。インストール・テストには渡さない。`status-only` は専用の `status-only.mjs` を呼び、`flovia_status` だけを最大1回実行する。
3. `flovia-poc-<run_id>-<attempt>` アーティファクト内の `report.json` を確認する。保存期間は7日。成果物は公開リポジトリの閲覧者にも読まれ得るものとして扱い、アカウントIDや任意文字列を保存しない。
4. `checked_status_only` は状態確認だけで終了、`stopped` は契約不一致等で停止、`error` は異常終了を意味する。`mode=status-only` では契約が一致しても一覧取得せず、`after=null`・`x_offered=null` のままである。`mode=check` は契約一致と利用条件の確認後に一覧取得へ進む実装だが、このPoCでは未実行。`checked_search_skipped` なら状態・一覧確認済みで検索は未実行。成功終了を「検索成功」と解釈しない。エラー時も勝手に再実行せず、原因を確認する。

ローカル開発ではキーなしでオフラインテストだけを行える:

```sh
cd flovia
npm ci --ignore-scripts --no-audit --no-fund
npm test                          # 全件モック、Floviaへ通信しない
```

SDK のキーファイルへの自動フォールバックは使わない。実行ステップで `FLOVIA_KEY` が得られなければネットワーク呼出し前に停止する。両モードとも、共通のキー処理・エラーフィルター・ファイル保存処理を使い、`flovia/results/report.json` に0600で書いてから同じパスをアーティファクトへ保存する。起動時に Secret を表示するコマンド、シェルのトレース、SDK の生レスポンス出力を使わない。

## statusだけの契約診断（過去の記録・実行済み）

公式の [接続確認](https://docs.flovia.dev/connect/check/) によれば `flovia_status` はデータソースへの照会を伴わない。この性質に基づき、契約不一致の原因を診断するために手動1回の再実行を行った。`mode=status-only`（初期値）では `npm run status-only` が専用スクリプトを起動し、サニタイズ済みの診断結果をアーティファクトに残す。既存の Actions Secret を再利用し、利用者にキーの取得・ローカルへのコピーを求めない。

不一致・欠落・不正値なら `contract_mismatch` で停止し、`tools/list`・X検索・再送は行わない。一致してもこのモードはstatusだけで終了する。公開用フィルターを通した契約番号または診断分類を記録する設計で、サーバー実契約 `.164` の観測に利用した。キー・生レスポンス・購入残高は出さない。使用率は出力されるので公開範囲に留意する。

`mode=check` を含む診断コードは検証記録として保持する。追加の一覧確認・状態確認は行わない。このモードでも従来の契約一致・利用条件の検査と安全停止を維持し、実データ検索はしない。キー未設定時は両モードとも通信前に停止し、401/403・429・タイムアウト等を自動リトライしない。初期値へフォールバックするのはモード未指定時だけで、未知のモード指定は処理を開始せず失敗させる。

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

### 初回: 状態応答で安全停止

[Issue の実行報告](https://github.com/YanTKYS/poc-lab/issues/4#issuecomment-6542098589) と [Actions run #41191707740](https://github.com/YanTKYS/poc-lab/actions/runs/41191707740) を記録する。対象は PR #5 マージ後の main `8b214680118c6b9ed6f739fbeccfb2ef301fb47d`、SDK 0.1.15。実行メタデータの成功・対象SHAを照合し、以下の応答内容は Issue に記載されたレポート抜粋に基づく。

- ワークフローは成功、モック38件成功。`flovia_status` の応答は約615ms。
- `outcome=stopped`、`stop_reason=contract_mismatch`、`phase=status_before`。
- `contract_matches_sdk=false`、SDK期待契約 `2026-10-07.151`。旧レポートにはサーバーの実契約番号・項目の有無を残していないため、番号差・欠落・不正値のどれかは判定不能。今回追加した診断を過去の実測結果として扱わない。
- 報告された状態は `stage=alpha`、5時間／週間の使用率はともに0%、`free_pending=false`、`stopped=false`、`data_consent_needed=false`、`data_consent_answer=y`、`x_disabled=false`。
- `tools/list` は未実行、`x_offered=null`。`x_disabled=false` はキーに `flovia_x` が提供されることの確認にはならない。検索・有料照会・再送は未実行。

初回は接続・認証を状態応答を受け取れる範囲で一部確認できたが、不一致の原因を区別できなかった。契約不一致は API利用不可・無料枠なしの証拠ではない。

### 2回目: 契約番号の相違を確認

[追加の実測報告](https://github.com/YanTKYS/poc-lab/issues/4#issuecomment-6543759774) と [Actions run #41203977385](https://github.com/YanTKYS/poc-lab/actions/runs/41203977385) による記録。対象は PR #6 反映済みの main `2c761f678494291f4e2921998b8f94facb0b9384`、SDK 0.1.15、`mode=status-only`。応答内容は利用者が確認した `report.json` の報告に基づく。

- ワークフロー成功、モック68件成功。`flovia_status` の実呼出しは1回、609ms。
- `outcome=stopped`、`stop_reason=contract_mismatch`、`contract_version_state=different_version`。
- SDK期待契約 `2026-10-07.151`、観測したサーバー契約 `2026-10-07.164`。不一致の原因は契約番号の相違と特定できたが、番号の大小で互換性は認定していない。
- `stage=alpha`、5時間／週間使用率はともに0%、`free_pending=false`、`stopped=false`、`data_consent_answer=y`、`x_disabled=false`。無料利用の保証やXツール提供の証明ではない。
- `tools/list`・X検索は未実行。生レスポンス・APIキーの公開、自動再送は行っていない。

実測で確認したのは状態応答と契約診断までである。その後のX提供終了報告を受けて検証を終了した。SDK互換性の調査継続、追加の状態・一覧確認、X検索実装、運営への問い合わせは行わない。

## 検証結果

| 項目 | 状態 |
| --- | --- |
| SDKの実際の通信処理をモックした status → tools/list → status | ローカルテスト成功（実通信ではない） |
| 無料枠残量あり・購入残高ありでも検索しない | テスト成功 |
| pending、停止、同意未確認、5時間／週間枯渇、契約変更 | 最初の状態確認後に停止するテスト成功 |
| 401/403、429、無料枠エラー、タイムアウト、通知・同意要求 | 分類・再送なしのテスト成功 |
| Secretを含む任意のエラー・状態文字列 | レポートへ出さないテスト成功 |
| 購入残高（ゼロ・正数・未知の形式・未取得）、前後で異なる残高 | 実額・残高フィールドをレポートへ出さないテスト成功 |
| 手動ワークフローの起動 | PR #5 マージ前は404。その後の run #41191707740 / #41203977385 は成功 |
| GitHub Actions上の状態応答 | 上記実測で応答あり。契約不一致で安全停止。Xツール一覧は未確認 |
| 契約診断と停止 | モックテスト成功。2回目の実測で SDK `.151` / サーバー `.164` の相違を観測し安全停止 |
| Actions用 status-only CLI | 一致・不一致・不正値でもstatusだけ最大1回。キー未設定では0回、401/429で再送なし、サニタイズ済みファイル保存を実SDKモックで確認 |
| X投稿取得、ID、公開日時、URL、日本語検索、レスポンス構造・品質 | 未実施・未評価。サービス側のX提供終了を受け、PoC検証終了・採用見送り |

ネットワーク不要のテストだけを `Flovia offline tests` で PR／main push 時に実行する。このワークフローには Secret 注入も実行用スクリプト呼出しもない。既存 Pages ワークフローとルートの依存関係・ビルド対象は変更しない。

## 終了後の扱い

判定は **検証終了・X提供終了につき採用見送り**。`ai-watch` / `news-watch` へのX検索導入は行わない。過去の診断コード・モックテスト・実測記録は保持する。手動ワークフローも記録として残すが、このPoCの追加実行には使わない。

追加のSDK互換性調査、API再実行、X検索の実装、Flovia運営への問い合わせは行わない。先に整理した問い合わせ案も送信しない。X以外のFloviaサービスの採否は、このPoCの結論に含めない。

文書整理PRのマージ後に Issue #4 をクローズする。提供終了の報告を受けた採否判断と、実測で確認できた範囲を分けて記録し、未実施のX検索を失敗・成功のどちらにも数えない。

## 参考

- [X提供終了の報告・最終判断](https://github.com/YanTKYS/poc-lab/issues/4#issuecomment-6553951409)

- [公式 SDK 0.1.15（npm）](https://www.npmjs.com/package/@flovialabs/sdk/v/0.1.15)
- [Quickstart](https://docs.flovia.dev/get-started/quickstart/)
- [接続確認](https://docs.flovia.dev/connect/check/)
- [最初の検索](https://docs.flovia.dev/get-started/first-lookup/)
- [使用量・無料／有料](https://docs.flovia.dev/usage/)
- [他クライアント](https://docs.flovia.dev/connect/other-clients/)
