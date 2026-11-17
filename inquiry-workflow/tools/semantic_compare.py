"""原票と各出力を openpyxl で読み、様式の要素ごとに「維持／変化」を調べる。

    node tools/measure.mjs          # 先に out/ を作る
    python3 tools/semantic_compare.py

方式A・Bとは別のライブラリ（openpyxl）で読むので、第三者による照合になる。
あわせて openpyxl 自身の無変更往復（方式P）も測る。
結果は results/semantic.json に書く。
"""
import datetime
import json
import pathlib
import zipfile

from openpyxl import load_workbook

ROOT = pathlib.Path(__file__).resolve().parent.parent
ANSWERS = json.loads((ROOT / "fixtures" / "answers.json").read_text(encoding="utf-8"))
LABELS = {"genpyo": "openpyxl生成", "genpyo-lo": "LibreOffice保存", "genpyo-excel": "Excel保存"}
FIXTURES = {p.stem: LABELS.get(p.stem, "追加の原票") for p in sorted((ROOT / "fixtures").glob("genpyo*.xlsx"))}
FEATURES = [
    ("cells", "セルの値・数式"),
    ("number_format", "表示形式"),
    ("font_fill_border", "フォント・塗り・罫線"),
    ("alignment", "配置・折り返し"),
    ("cell_lock", "セルのロック設定"),
    ("merges", "結合セル"),
    ("validations", "入力規則"),
    ("cond_fmt", "条件付き書式"),
    ("protection", "シート保護"),
    ("col_widths", "列幅"),
    ("row_heights", "行の高さ"),
    ("freeze", "ウィンドウ枠の固定"),
    ("print", "印刷範囲・用紙の向き"),
    ("defined_names", "名前の定義"),
    ("comments", "コメント（メモ）"),
    ("shape", "図形（テキストボックス）"),
    ("doc_props", "文書のプロパティ"),
]


def color(c):
    if c is None:
        return None
    if c.type == "rgb":
        return ("rgb", c.rgb)
    return (c.type, getattr(c, c.type), round(c.tint or 0, 3))


def snapshot(path):
    wb = load_workbook(path)
    snap = {k: {} for k, _ in FEATURES}
    for ws in wb.worksheets:
        n = ws.title
        for row in ws.iter_rows():
            for c in row:
                key = f"{n}!{c.coordinate}"
                if c.value is not None:
                    v = c.value
                    snap["cells"][key] = [type(v).__name__, v.isoformat() if hasattr(v, "isoformat") else v]
                if c.has_style:
                    snap["number_format"][key] = c.number_format
                    b = c.border
                    snap["font_fill_border"][key] = [
                        bool(c.font.b), c.font.sz, c.fill.fill_type,
                        color(c.fill.fgColor) if c.fill.fill_type else None,
                        [getattr(b, s).style for s in ("left", "right", "top", "bottom")],
                    ]
                    a = c.alignment
                    snap["alignment"][key] = [a.horizontal, a.vertical, bool(a.wrap_text)]
                    snap["cell_lock"][key] = bool(c.protection.locked)
                if c.comment is not None:
                    snap["comments"][key] = c.comment.text
        snap["merges"][n] = sorted(str(r) for r in ws.merged_cells.ranges)
        snap["validations"][n] = sorted(
            [str(dv.sqref), dv.type, dv.operator, dv.formula1, dv.formula2] for dv in ws.data_validations.dataValidation
        )
        cf = []
        for rng in ws.conditional_formatting:
            for rule in rng.rules:
                fill = rule.dxf.fill if rule.dxf is not None else None
                cf.append([str(rng.sqref), rule.type, list(rule.formula), color(fill.bgColor) if fill is not None else None])
        snap["cond_fmt"][n] = sorted(cf, key=str)
        snap["protection"][n] = [bool(ws.protection.sheet), bool(ws.protection.password)]
        snap["col_widths"][n] = {
            k: round(d.width, 1) for k, d in sorted(ws.column_dimensions.items()) if d.customWidth and d.width
        }
        snap["row_heights"][n] = {k: d.height for k, d in sorted(ws.row_dimensions.items()) if d.height}
        snap["freeze"][n] = ws.freeze_panes
        snap["print"][n] = [str(ws.print_area), ws.page_setup.orientation]
    snap["defined_names"] = {k: v.attr_text.replace("'", "") for k, v in wb.defined_names.items()}
    snap["doc_props"] = {"creator": wb.properties.creator, "title": wb.properties.title}
    with zipfile.ZipFile(path) as z:
        texts = [z.read(i).decode("utf-8", "replace") for i in z.namelist() if i.startswith("xl/drawings/") and i.endswith(".xml")]
        snap["shape"] = {"textbox": any("【図形】" in t for t in texts)}
    return snap


def diff(a, b, skip=()):
    """2つの辞書の違いを [キー, 原票, 出力] の一覧にする。"""
    out = []
    for k in sorted(set(a) | set(b)):
        if k in skip:
            continue
        if a.get(k) != b.get(k):
            out.append([k, a.get(k), b.get(k)])
    return out


def check_answers(path):
    wb = load_workbook(path)
    bad = []
    for w in ANSWERS:
        v = wb[w["sheet"]][w["cell"]].value
        t = w["type"]
        if t == "blank":
            ok = v is None
        elif t == "number":
            ok = isinstance(v, (int, float)) and not isinstance(v, bool) and v == w["value"]
        elif t == "date":
            ok = isinstance(v, (datetime.datetime, datetime.date)) and v.isoformat()[:10] == w["value"]
        else:
            ok = isinstance(v, str) and v == w["value"]
        if not ok:
            bad.append([f'{w["sheet"]}!{w["cell"]}', w.get("value"), repr(v)])
    return bad


def main():
    targets = {f'{w["sheet"]}!{w["cell"]}' for w in ANSWERS}
    results = {"generatedBy": "tools/semantic_compare.py", "features": dict(FEATURES), "fixtures": {}}
    for fid, label in FIXTURES.items():
        orig = ROOT / "fixtures" / f"{fid}.xlsx"
        base = snapshot(orig)
        # 方式P：openpyxl で読んでそのまま保存
        p_out = ROOT / "out" / f"{fid}.P-nochange.xlsx"
        load_workbook(orig).save(p_out)
        res = {"label": label, "outputs": {}}
        for tag in ["B-nochange", "B-writeback", "A-nochange", "A-writeback", "P-nochange"]:
            path = ROOT / "out" / f"{fid}.{tag}.xlsx"
            if not path.exists():
                res["outputs"][tag] = {"exists": False}
                continue
            snap = snapshot(path)
            wrote = tag.endswith("writeback")
            feats = {}
            for key, _ in FEATURES:
                d = diff(base[key], snap[key], skip=targets if (wrote and key == "cells") else ())
                feats[key] = {"same": not d, "diffs": len(d), "samples": d[:3]}
            entry = {"exists": True, "features": feats}
            if wrote:
                bad = check_answers(path)
                entry["answers"] = {"checked": len(ANSWERS), "mismatches": bad}
            res["outputs"][tag] = entry
        results["fixtures"][fid] = res

    (ROOT / "results" / "semantic.json").write_text(
        json.dumps(results, ensure_ascii=False, indent=1, default=str) + "\n", encoding="utf-8"
    )
    for fid, res in results["fixtures"].items():
        tags = [t for t, o in res["outputs"].items() if o["exists"]]
        print(f"\n== {fid}（{res['label']}） 維持=○ 変化=×（差の件数）")
        print("| 要素 | " + " | ".join(tags) + " |")
        print("|---|" + "---|" * len(tags))
        for key, name in FEATURES:
            cells = []
            for t in tags:
                f = res["outputs"][t]["features"][key]
                cells.append("○" if f["same"] else f"×（{f['diffs']}）")
            print(f"| {name} | " + " | ".join(cells) + " |")
        for t in tags:
            a = res["outputs"][t].get("answers")
            if a:
                print(f"  {t}: 62セルの値・型の不一致 {len(a['mismatches'])}")
        missing = [t for t, o in res["outputs"].items() if not o["exists"]]
        if missing:
            print(f"  出力なし（読み込み失敗）: {', '.join(missing)}")


if __name__ == "__main__":
    main()
