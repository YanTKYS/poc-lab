# Pele 1.8.0 / 1.13.0 再検証の証跡（2026-11-01）

同じ `pele/samples.js`（変更なし）、Playwright 1.56.1、Chromium 154.0.8037.57、1400×1000、deviceScaleFactor 1、ja-JP、Noto Sans CJK JP のあるLinux環境で取得した。指定フォント列は比較UIの既定値と同じ。外部通信はすべてブロックし、ローカルUI以外へのリクエスト・404・未捕捉例外は0件だった。

`observations.json` にライブラリ／サンプルのSHA-256、SVG viewBox、入口ノードの座標、3本のエッジのpath／始終点、表示サイズ、同条件の描画時間を保存した。数字だけで見た目の良否を判定せず、PNGも目視確認した。`default` は `render()` の幅指定なし、`660` / `360` は比較UIと同じ `mount()` とフォント・CSS変数を使った分離描画。Mermaidは `render()` の出力を各幅へ縮小する。

| 条件 | Pele 1.8.0 | Pele 1.13.0 | Mermaid.js 12.1.0 |
| --- | --- | --- | --- |
| 既定幅（LR） | [画像](pele-1.8.0-default.png) / [SVG](pele-1.8.0-default.svg) | [画像](pele-1.13.0-default.png) / [SVG](pele-1.13.0-default.svg) | [画像](mermaid-12.1.0-default.png) / [SVG](mermaid-12.1.0-default.svg) |
| 660px | [画像](pele-1.8.0-660.png) / [SVG](pele-1.8.0-660.svg) | [画像](pele-1.13.0-660.png) / [SVG](pele-1.13.0-660.svg) | [画像](mermaid-12.1.0-660.png) / [SVG](mermaid-12.1.0-660.svg) |
| 360px | [画像](pele-1.8.0-360.png) / [SVG](pele-1.8.0-360.svg) | [画像](pele-1.13.0-360.png) / [SVG](pele-1.13.0-360.svg) | [画像](mermaid-12.1.0-360.png) / [SVG](mermaid-12.1.0-360.svg) |

入口部分の切り出し: [1.8.0](pele-1.8.0-entrances.png) / [1.13.0](pele-1.13.0-entrances.png) / [Mermaid](mermaid-12.1.0-entrances.png)。SVG内の1単位を1pxとして取得した既定幅画像から切り出している。

実際の比較UI（同じページでMermaidを対照に表示）も取得した。通常のフレーム実幅は652pxで、固定660pxの分離検証と区別する。

- 通常ペイン: [Pele 1.8.0 + Mermaid](ui-pele-1.8.0-normal.png) / [Pele 1.13.0 + Mermaid](ui-pele-1.13.0-normal.png)
- 360px指定: [Pele 1.8.0 + Mermaid](ui-pele-1.8.0-360.png) / [Pele 1.13.0 + Mermaid](ui-pele-1.13.0-360.png)

## 再取得

リポジトリ直下で実行する。旧版配布物はnpmから固定版を取得する（ここで保存したライブラリSHA-256をスクリプトでも検証する）。旧版ライブラリ自体はこの証跡に同梱していない。

```sh
npm ci --no-audit --no-fund
npm run build
mkdir -p /tmp/poc-lab-pele-baseline
npm pack pele@1.8.0 --pack-destination /tmp/poc-lab-pele-baseline
tar -xzf /tmp/poc-lab-pele-baseline/pele-1.8.0.tgz -C /tmp/poc-lab-pele-baseline
node scripts/compare-pele.mjs /tmp/poc-lab-pele-baseline/package/dist/pele.global.js /usr/bin/chromium
```

Chromiumの実行ファイルを省略した場合はPlaywrightのインストール済みブラウザを使う。比較UIの取得にはローカルの4189番ポートが空いていることが必要。スクリプトが起動したサーバーだけを終了する。再取得はこのフォルダの生成物を上書きするので、差分をレビューする。描画時間は3回ウォームアップ後10回の中央値・最小・最大で、既定幅のSVG文字列生成だけを測る。DOM反映・通信・初回描画時間を含まない。両Pele版を同じ環境で順に1回ずつ測った参考値で、タイマー分解能・GC・実行順等の影響を含む。

証跡はPagesの `dist/` ビルド対象外。結果・採用判断・未検証事項は [pele/README.md](../../pele/README.md) に記録している。
