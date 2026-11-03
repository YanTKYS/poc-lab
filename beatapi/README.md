# BeatAPI 無料テキストモデル比較 PoC

`news-watch` / `ai-watch` の要約・分類候補を評価する独立した PoC です。両リポジトリへの導入は行いません。Node.js 22 以上の標準 `fetch` と `node:test` だけを使い、外部依存・インストール処理はありません。既存のビルド、Pages、他の PoC は変更しません。

**2026-11-03 に無料専用モデル 3 種を各 1 回ライブ検証し、全モデルで HTTP 200 と応答モデル ID の一致を確認しました。固定タスクの簡易判定に合格したのは DeepSeek のみです。** 詳細は下記の初回実測結果に記載しています。実請求額・残高変化は未確認で、採用は引き続き保留です。

## 対象と公式仕様

対象は利用者が Allowed models 画面で確認した次の 3 ID だけです。アカウント全体の無料カタログから自動追加しません。

- `deepseek-v4.1-flash-free`（手動 Actions の初期値）
- `glm-5.3-flash-free`
- `minimax-m3.1-flash-free`

公式資料確認日: **2026-11-03**。この節は公式資料の要約です。下記の実測結果とは区別して扱います。

- [`Free models`](https://docs.beatapi.io/free-models): `-free` はトークン単価のない別 ID。有料版の ID は別の課金対象で、大文字小文字も区別されます。
- 初回チャージ前は **アカウント全体で成功 1 回/分**、チャージ後は最大 10 回/分。無料モデルは制限・提供終了の可能性があり、速度・継続提供・本番可用性は保証されません。**この PoC のためにチャージする必要はありません。**
- 無料版のコンテキスト長・出力上限は公表・保証されていません。有料版の能力や JSON mode、推論設定を無料版へ当てはめません。MiniMax の初回トークンが数十秒かかる場合もあると記載されています。
- 無料 GLM / MiniMax は `/v1/responses` 非対応。3 モデル共通で [`Chat Completions`](https://docs.beatapi.io/api-reference/text-api/deepseek-chat-completions) の `POST https://direct.beatapi.io/v1/chat/completions` に固定します。[日本語の Text API 概要](https://docs.beatapi.io/ja/text-api)も参照しています。

## 固定タスクと判定

1 回のリクエストで、日本語短文の要約とカテゴリ分類を行います。送信するのは次の**公開可能な架空テキストだけ**です。自治体の非公開情報・個人情報・外部ファイルは受け付けません。

> 架空の青空市は11月15日午前10時から中央公園で防災訓練を開きます。参加者は避難経路の確認と消火器の使い方を学びます。参加費は無料で、事前申込は不要です。

プロンプトは [`poc.mjs`](poc.mjs) に固定しています。日本語 80 文字以内、日付・場所・防災訓練を含む要約と、`防災` / `子育て` / `観光` / `その他` からの分類を要求します。期待する形式の例（実測した回答ではありません）:

```json
{"summary":"11月15日、中央公園で防災訓練を実施。参加無料、事前申込不要。","category":"防災"}
```

追加キーや Markdown 囲みは許容せず、JSON を補修しません。`response_format` は指定せず、JSON 出力はプロンプトで依頼するだけです。`stream: false`、`max_tokens: 512` を共通設定にします。これは PoC の要求値であり、モデルの保証上限ではありません。

成功には HTTP 成功、応答 `model` の完全一致、`finish_reason: stop`、JSON パース・スキーマの妥当性、次の簡易品質条件をすべて要求します。

- 要約が 1〜80 Unicode コードポイントで日本語を含む。
- 要約に `11月15日`、`中央公園`、`防災訓練` の文字列がある。
- カテゴリが `防災`。

判定名は `heuristic_pass` です。語の一致を使う粗い指標なので、自然な別表記を落とすことがあり、誤情報や不自然な日本語を完全には検知できません。日本語の流暢さ、網羅的な事実整合性、一般的な分類精度は未検証として扱います。

## オフラインテスト

リポジトリのルートで実行します。API キーも `npm install` も不要です。

```sh
node --test beatapi/test/*.test.mjs
```

通常の PR / main への push では [`beatapi-tests.yml`](../.github/workflows/beatapi-tests.yml) がモックテストだけを実行します。許可 3 モデル、未知・有料・別無料 ID の拒否、キーなし、401/403/429、リダイレクト禁止、通信エラー、ヘッダー取得後も含むタイムアウト、モデル不一致、JSON 不正・空回答、品質判定、秘密情報除外、無再送、CLI の終了コード・保存処理を確認します。テストは実 `fetch` を禁止し、インメモリの応答を注入します。

## 手動 Actions の使い方

1. `poc-lab` の Actions → **BeatAPI manual PoC** → Run workflow を開きます。
2. ブランチは `main`、`model` は上記 3 ID のうち **1 つ**を指定します。`main` 以外はジョブをスキップします。
3. 実行するとキーなしのオフラインテストの後、実通信ステップだけに登録済みの `secrets.BEAT_API_KEY` が環境変数 `BEAT_API_KEY` として渡ります。キーの値を画面やコマンドへ貼り付ける必要はありません。
4. 1 リクエストが終わったら、成功・失敗にかかわらず、その実行の artifact `beatapi-poc-<run_id>-<run_attempt>` から `report.json` を確認します。保持は **3 日**です。事前テスト失敗など、実通信ステップに到達しなかった場合はレポートがありません。
5. 別モデルの手動実行は、前の成功から **少なくとも 60 秒以上**空け、同じアカウントの他の呼び出しも考慮してください。安全のため余裕を持って待ってください。ワークフローの同時実行制御はアカウント全体の毎分制限を保証しません。

429 ではその場で停止し、自動再送しません。再確認は十分に待ってから利用者が新たに手動で実行します。401/403 は権限・設定を確認し、モデル不一致は原因を確認するまで以降の実行を停止してください。タイムアウトでサーバー側の生成が取り消されたと断定できないため、直後の再実行も避けます。

[`beatapi-poc.yml`](../.github/workflows/beatapi-poc.yml) は `workflow_dispatch` 専用で、PR / push / schedule によるライブ起動はありません。CLI の形式は `node beatapi/run.mjs --model <許可ID>` です。本 PoC のライブ検証には、レビュー済みの `main` 上の手動 Actions を利用します。キーの取得・一覧照会や、ローカルへの貼り付けは不要です。

## 安全策とレポートの扱い

- モデルは完全一致の許可リストで通信前に検証します。未知 ID、有料 ID、`-free` 欠落、空白・改行付き ID は拒否します。モデル名の補正、モデル一覧取得、有料モデル・別 API・別キーへのフォールバックはありません。
- 1 実行につき `fetch` は最大 1 回。HTTP リダイレクトも禁止し、429 やタイムアウトを含め自動リトライしません。キーなしなら通信前に停止します。
- 90 秒の期限はヘッダー受信だけでなく本文読み込みまでを含みます。本文は最大 64 KiB、ジョブは最大 5 分に制限します。
- Secret は実通信ステップにだけ注入します。テスト・インストール・PR / push では渡しません。Actions の権限は `contents: read` です。
- 出力は `beatapi/results/report.json` のみで、Git 管理対象外です。生の HTTP エラー、全ヘッダー、Authorization、キー、任意のサーバーメッセージ、残高、個人情報、推論文はログ・artifact へコピーしません。例外も定型メッセージだけで処理します。
- **プロンプト・回答全文・生成された要約文は保存・表示しません。** 入力と指示は公開固定データとしてコード・この README でレビューできます。回答はメモリ上で評価し、レポートには許可済みカテゴリ、文字数、判定の真偽値だけを残します。JSON 内へ秘密情報や余分なデータが混入しても、その文字列はコピーしません。
- レポートの文字列はローカル定数・列挙値に限定します。応答 `model` は許可済み ID の場合だけ保存し、未知の値は `null` と `response_model_state: unrecognized` に置換します。許可済みでも指定と異なる ID は失敗とし、再試行しません。

主なレポート項目:

| 項目 | 内容 |
| --- | --- |
| `requested_at`, `selected_model` | リクエスト開始時刻（UTC）、許可済み指定 ID。事前拒否なら時刻は `null` |
| `response_model`, `response_model_state` | サニタイズした応答 model と一致判定 |
| `http_status`, `elapsed_ms`, `requests_sent` | HTTP 状態、本文読取を含む経過 ms、送信試行数（0 / 1） |
| `outcome`, `reason`, `finish_reason` | 全条件通過時だけ `passed`。他は `stopped` と定型理由 |
| `output` | JSON パース可否、スキーマ判定、許可カテゴリ、要約文字数、簡易品質チェック。回答なし・不一致等は `null` |
| `usage` | `prompt_tokens`, `completion_tokens`, `total_tokens` のうち非負の安全な整数だけ。欠落値や数値文字列は補完しない |

## 初回実測結果（2026-11-03）

記録元: [Issue #10 の 3 モデル初回比較](https://github.com/YanTKYS/poc-lab/issues/10#issuecomment-6595305123)、[DeepSeek 個別結果](https://github.com/YanTKYS/poc-lab/issues/10#issuecomment-6595199400)。既存の Actions ログとサニタイズ済み `report.json` を照合した記録を反映しています。

`main` の **BeatAPI manual PoC** で、登録済み Secret を使って許可済みの `-free` モデルへ各 1 回リクエストしました。事前モックテストは全実行で **80/80 成功**。自動再試行・有料モデルへのフォールバックは行っていません。**全モデルで API 通信は成功しましたが、要約・分類タスクの成功は DeepSeek の 1 回だけです。**

| 指標 | DeepSeek V4.1 Flash Free | GLM 5.3 Flash Free | MiniMax M3.1 Flash Free |
| --- | --- | --- | --- |
| Actions run | [41575857373](https://github.com/YanTKYS/poc-lab/actions/runs/41575857373) | [41576371259](https://github.com/YanTKYS/poc-lab/actions/runs/41576371259) | [41576869582](https://github.com/YanTKYS/poc-lab/actions/runs/41576869582) |
| `selected_model` | `deepseek-v4.1-flash-free` | `glm-5.3-flash-free` | `minimax-m3.1-flash-free` |
| HTTP / 応答モデル ID | 200 / 指定と一致 | 200 / 指定と一致 | 200 / 指定と一致 |
| `requests_sent` | 1 | 1 | 1 |
| `elapsed_ms` | **13,803** | **39,256** | **3,115** |
| usage: prompt / completion / total | 182 / 417 / 599 | 175 / 512 / 687 | 329 / 26 / 355 |
| `finish_reason` | `stop` | `length` | `stop` |
| JSON パース | true | false | false |
| `outcome` / `reason` | `passed` / `null` | `stopped` / `incomplete_answer` | `stopped` / `invalid_output_json` |
| 簡易判定 | 合格（`heuristic_pass`） | 不合格 | 不合格 |

- **DeepSeek:** JSON 構造、カテゴリ `防災`、日付・場所・防災訓練の指定語、80 文字以内などの簡易基準に合格しました。生成要約は **48 文字**です。回答全文を保存していないため、人手による言語品質評価ではありません。
- **GLM:** `max_tokens: 512` と同数の completion tokens、`finish_reason: length` で出力打ち切りと JSON 不成立を確認しました。内部推論がトークン枠を消費した可能性はありますが、出力本文・推論内訳を記録していないため断定できません。
- **MiniMax:** `finish_reason: stop`、26 completion tokens でしたが、JSON パースに失敗しました。回答全文を保存しておらず、実際の返答形式と失敗原因は不明です。この結果からモデル全般の能力不足とは判断しません。

確認できたのは、登録済み Secret を用いた 3 つの無料専用 ID への正常な API 応答、各 1 回の所要時間・usage、固定タスクでの上記判定です。無料専用 ID への疎通確認と、実際の請求額の確認は区別します。

引き続き未確認の事項:

- **実請求額・残高変化**。残高や課金情報は取得・記録していません。
- **日本語の自然さ・事実整合性の人手評価**。回答全文を保持せず、`heuristic_pass` は文字数・指定語・カテゴリ・構造の簡易検査に限ります。
- **安定性・継続提供・本番可用性**。各モデル 1 回のみの観察で、速度や品質の一般的な優劣を決めるものではありません。無料版のコンテキスト長・出力上限も検証していません。

既存の `news-watch` / `ai-watch` には未導入で、3 モデルとも採用は保留です。追加検証や採用判断は別途扱います。今回の README 更新では API の再実行、Secret 参照、PoC ロジック・Actions の変更は行っていません。今後の実測記録も、短期 artifact が失効する前に必要な集計値と Actions run URL を残してください。
