"""書き戻した .xlsx を LibreOffice で開いて保存し直し、数式の計算結果を確かめる。

    node tools/measure.mjs          # 先に out/ を作る
    python3 tools/lo_check.py       # LibreOffice（soffice）が必要

Excelの代わりにLibreOfficeで「開ける・再計算される・値が読める」を見る参考試験。
Excel実機での確認の代わりにはならない。結果は results/lo-check.json に書く。
"""
import json
import pathlib
import shutil
import subprocess
import tempfile

from openpyxl import load_workbook

ROOT = pathlib.Path(__file__).resolve().parent.parent
# 期待値（fixtures/answers.json の値から手計算）
EXPECT = {
    "基本情報!D11": "記入済",
    "基本情報!D12": 3,
    "取組状況!C19": 3,
    "施設別実績!C13": 255811,
    "施設別実績!D13": 2302,
    "施設別実績!E13": 63317,
    "施設別実績!F13": 139750.5,
}


def formula_results(path):
    wb = load_workbook(path, data_only=True)  # 数式ではなく、保存されている計算結果を読む
    out = {}
    for key in EXPECT:
        sheet, cell = key.split("!")
        out[key] = wb[sheet][cell].value
    return out


def match(got):
    return all(
        (abs(got[k] - v) < 1e-9 if isinstance(v, (int, float)) and isinstance(got[k], (int, float)) else got[k] == v)
        for k, v in EXPECT.items()
    )


def main():
    soffice = shutil.which("soffice")
    if not soffice:
        raise SystemExit("soffice が見つかりません")
    version = subprocess.run([soffice, "--version"], capture_output=True, text=True).stdout.strip()
    results = {"generatedBy": "tools/lo_check.py", "libreoffice": version, "expected": EXPECT, "files": {}}
    for fid in sorted(p.stem for p in (ROOT / "fixtures").glob("genpyo*.xlsx")):
        for tag in ["B-writeback", "B-writeback-keepresults"]:
            src = ROOT / "out" / f"{fid}.{tag}.xlsx"
            stored = formula_results(src)
            with tempfile.TemporaryDirectory() as tmp:
                p = subprocess.run(
                    [soffice, "--headless", "--convert-to", "xlsx:Calc MS Excel 2007 XML", "--outdir", tmp, str(src)],
                    capture_output=True, text=True, timeout=180,
                )
                conv = pathlib.Path(tmp) / src.name
                opened = conv.exists()
                after = formula_results(conv) if opened else None
            results["files"][f"{fid}.{tag}"] = {
                "stored_in_file": stored,  # 書き戻し直後のファイルに残っている計算結果
                "stored_matches": match(stored) if all(v is not None for v in stored.values()) else False,
                "opened_by_libreoffice": opened,
                "after_libreoffice": after,
                "after_matches": bool(opened and match(after)),
            }
    (ROOT / "results" / "lo-check.json").write_text(
        json.dumps(results, ensure_ascii=False, indent=1) + "\n", encoding="utf-8"
    )
    print(version)
    for name, r in results["files"].items():
        print(f"{name}: 直後のファイル内の計算結果={'正' if r['stored_matches'] else '古い/なし'} "
              f"{list(r['stored_in_file'].values())} / LibreOfficeで開けた={r['opened_by_libreoffice']} "
              f"/ 開いて保存後={'正' if r['after_matches'] else '不一致'} {list((r['after_libreoffice'] or {}).values())}")


if __name__ == "__main__":
    main()
