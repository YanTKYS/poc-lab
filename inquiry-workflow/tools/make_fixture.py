"""架空の国照会Excel（原票）と期待値を生成する。

    python3 tools/make_fixture.py

出力:
    fixtures/genpyo.xlsx      架空の原票（4シート・入力セル62）
    fixtures/answers.json     書き戻す値（期待値）
    fixtures/input-cells.json 入力セルの一覧（書き込みを許す範囲）

内容はすべて架空。実在の照会・団体・個人の情報は含まない。
openpyxl で生成したあと、openpyxl では作れない「図形（テキストボックス）」を
ZIPに直接追加する（ライブラリが図形を保持できるかを試すため）。
"""
import datetime
import json
import pathlib
import re
import zipfile

from openpyxl import Workbook
from openpyxl.comments import Comment
from openpyxl.formatting.rule import FormulaRule
from openpyxl.styles import Alignment, Border, Font, PatternFill, Protection, Side
from openpyxl.workbook.defined_name import DefinedName
from openpyxl.worksheet.datavalidation import DataValidation

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "fixtures" / "genpyo.xlsx"

THIN = Side(style="thin", color="FF808080")
BOX = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)
HEAD_FILL = PatternFill("solid", fgColor="FFD9E1F2")
INPUT_FILL = PatternFill("solid", fgColor="FFFFF2CC")
CALC_FILL = PatternFill("solid", fgColor="FFE7E6E6")
UNLOCK = Protection(locked=False)
WRAP = Alignment(wrap_text=True, vertical="top")

input_cells = []  # {"sheet", "cell", "label"}
answers = []  # {"sheet", "cell", "type", "value", "note"}


def head(ws, ref, text):
    c = ws[ref]
    c.value = text
    c.font = Font(bold=True)
    c.fill = HEAD_FILL
    c.border = BOX
    c.alignment = Alignment(horizontal="center", vertical="center")


def label(ws, ref, text):
    c = ws[ref]
    c.value = text
    c.border = BOX
    c.alignment = WRAP


def input_cell(ws, ref, text, number_format=None, merge_to=None, align=None):
    """入力セル。結合する場合は merge_to に右下のセルを渡す。"""
    rng = f"{ref}:{merge_to}" if merge_to else ref
    for row in ws[rng] if merge_to else [[ws[ref]]]:
        for c in row:
            c.fill = INPUT_FILL
            c.border = BOX
            c.protection = UNLOCK
            if number_format:
                c.number_format = number_format
            if align:
                c.alignment = align
    if merge_to:
        ws.merge_cells(rng)
    input_cells.append({"sheet": ws.title, "cell": ref, "label": text})


def answer(ws, ref, typ, value=None, note=None):
    a = {"sheet": ws.title, "cell": ref, "type": typ}
    if typ != "blank":
        a["value"] = value
    if note:
        a["note"] = note
    answers.append(a)


wb = Workbook()

# ---------------------------------------------------------------- 記入要領
ws0 = wb.active
ws0.title = "記入要領"
ws0.merge_cells("A1:F1")
ws0["A1"] = "地域デジタル化取組状況調査（架空） 記入要領"
ws0["A1"].font = Font(bold=True, size=14)
for i, t in enumerate(
    [
        "1. この調査票は検証用の架空の様式です。",
        "2. 黄色のセルに記入してください。灰色のセルは自動計算のため記入不要です。",
        "3. 行・列の追加や削除、シート名の変更はしないでください。",
        "4. 選択式の設問は、プルダウンから選んでください。",
    ],
    start=3,
):
    ws0[f"A{i}"] = t
head(ws0, "H1", "選択肢（参照用）")
for i, t in enumerate(["実施済み", "実施予定", "未実施"], start=2):
    ws0[f"H{i}"] = t
    ws0[f"H{i}"].border = BOX
ws0.column_dimensions["A"].width = 14
ws0.column_dimensions["H"].width = 18

# ---------------------------------------------------------------- 基本情報
ws1 = wb.create_sheet("基本情報")
ws1.merge_cells("B2:F2")
ws1["B2"] = "基本情報"
ws1["B2"].font = Font(bold=True, size=14)
basic = [
    (4, "団体コード（6桁）", "@", "text", "012345", "先頭ゼロを含む識別文字列"),
    (5, "団体名", None, "text", "架空市", None),
    (6, "とりまとめ担当課", None, "text", "デジタル推進課", None),
    (7, "担当者名", None, "text", "検証 太郎", None),
    (8, "電話番号", "@", "text", "0123-45-6789", "先頭ゼロを含む文字列"),
    (9, "回答日", 'yyyy"年"m"月"d"日"', "date", "2026-11-27", "日付（和文の表示形式）"),
]
for row, text, fmt, typ, val, note in basic:
    ws1.merge_cells(f"B{row}:C{row}")
    label(ws1, f"B{row}", text)
    ws1[f"C{row}"].border = BOX
    input_cell(ws1, f"D{row}", text, number_format=fmt, merge_to=f"F{row}")
    answer(ws1, f"D{row}", typ, val, note)
ws1.merge_cells("B11:C11")
label(ws1, "B11", "記入チェック（自動）")
ws1["D11"] = '=IF(COUNTA(D4:D9)=6,"記入済","未記入あり")'
ws1["D11"].fill = CALC_FILL
ws1["D11"].border = BOX
ws1.merge_cells("B12:C12")
label(ws1, "B12", "「導入済み」の設問数（自動）")
ws1["D12"] = "='取組状況'!C19"
ws1["D12"].fill = CALC_FILL
ws1["D12"].border = BOX
ws1.column_dimensions["B"].width = 16
ws1.column_dimensions["C"].width = 16
for col in "DEF":
    ws1.column_dimensions[col].width = 12
ws1.protection.sheet = True  # シート保護（入力セルだけロック解除）
ws1.protection.set_password("kakuu")

# ---------------------------------------------------------------- 取組状況
ws2 = wb.create_sheet("取組状況")
ws2.merge_cells("A2:D2")
ws2["A2"] = "取組状況"
ws2["A2"].font = Font(bold=True, size=14)
for ref, t in [("A4", "番号"), ("B4", "設問"), ("C4", "回答"), ("D4", "補足・自由記述")]:
    head(ws2, ref, t)

LIST3 = '"導入済み,導入予定,未導入"'
# (設問, 回答の種類, 表示形式, 回答, 補足)
Q = [
    ("オンライン申請に対応している手続の数", "int", "#,##0", ("number", 12), ("text", "4月1日時点")),
    ("コンビニ交付の導入状況", "list", None, ("text", "導入済み"), ("text", "令和6年度に開始")),
    ("マイナンバーカード交付の予約方法のオンライン化", "list", None, ("text", "導入予定"), ("blank", None)),
    ("書かない窓口の導入状況", "list", None, ("text", "未導入"), ("text", "該当なし")),
    ("電子納付の導入状況", "list", None, ("text", "導入済み"), ("text", "税目: 住民税 & 固定資産税 <軽自動車税を除く>")),
    ("申告の電子化を開始した日", "date", "yyyy/m/d", ("date", "2025-04-01"), ("blank", None)),
    ("認定調査でのタブレット利用", "ref", None, ("text", "実施済み"), ("text", "  前後に空白を含む文字列  ")),
    ("オンライン手続の利用率", "pct", "0.0%", ("number", 0.125), ("text", "12.5%（概算）")),
    ("申請書の押印見直し", "list", None, ("text", "導入済み"), ("blank", None)),
    ("保育所入所申請のオンライン化", "list", None, ("text", "導入予定"), ("text", "'先頭がアポストロフィの文字列")),
    ("子育て関連手続のオンライン件数", "int", "#,##0", ("number", 0), ("text", "0件（実績なし）")),
]
for i, (text, kind, fmt, ans, sup) in enumerate(Q, start=1):
    r = 4 + i
    label(ws2, f"A{r}", f"問{i}")
    label(ws2, f"B{r}", text)
    input_cell(ws2, f"C{r}", f"問{i} {text} ／ 回答", number_format=fmt)
    input_cell(ws2, f"D{r}", f"問{i} {text} ／ 補足", align=WRAP)
    answer(ws2, f"C{r}", ans[0], ans[1])
    answer(ws2, f"D{r}", sup[0], sup[1], "該当なし→文言で書く例" if sup[1] == "該当なし" else None)
    if kind == "list":
        dv = DataValidation(type="list", formula1=LIST3, allow_blank=True)
    elif kind == "ref":
        dv = DataValidation(type="list", formula1="=記入要領!$H$2:$H$4", allow_blank=True)
    elif kind == "int":
        dv = DataValidation(type="whole", operator="greaterThanOrEqual", formula1="0", allow_blank=True)
        dv.error = "0以上の整数を入力してください"
    elif kind == "date":
        dv = DataValidation(type="date", operator="greaterThan", formula1="36526", allow_blank=True)
    else:
        dv = None
    if dv is not None:
        ws2.add_data_validation(dv)
        dv.add(f"C{r}")
# 問12・問13 は結合セル1つ（複数課が関係する項目）
label(ws2, "A16", "問12")
label(ws2, "B16", "キャッシュレス決済に対応した窓口の数（市民課・税務課の合計）")
input_cell(ws2, "C16", "問12 キャッシュレス対応窓口数", number_format="#,##0", merge_to="D16")
answer(ws2, "C16", "number", 5, "複数課の合算（3＋2）")
label(ws2, "A17", "問13")
label(ws2, "B17", "推進上の課題（自由記述）")
input_cell(ws2, "C17", "問13 推進上の課題", merge_to="D17", align=WRAP)
answer(ws2, "C17", "text", "【市民課】窓口の混雑。\n【税務課】証明書のコンビニ交付率が低い。\n【福祉課】端末が不足。", "改行を含む文章")
ws2.row_dimensions[17].height = 60
label(ws2, "B19", "「導入済み」と回答した設問数（自動）")
ws2["C19"] = '=COUNTIF(C5:C15,"導入済み")'
ws2["C19"].fill = CALC_FILL
ws2["C19"].border = BOX
ws2.conditional_formatting.add(
    "C5:C15", FormulaRule(formula=['ISBLANK(C5)'], fill=PatternFill("solid", bgColor="FFFFC7CE"))
)
ws2["C5"].comment = Comment("半角数字で入力してください。", "架空省")
ws2.column_dimensions["A"].width = 8
ws2.column_dimensions["B"].width = 46
ws2.column_dimensions["C"].width = 16
ws2.column_dimensions["D"].width = 40
ws2.freeze_panes = "C5"

# ---------------------------------------------------------------- 施設別実績
ws3 = wb.create_sheet("施設別実績")
ws3.merge_cells("A2:G2")
ws3["A2"] = "施設別実績（令和7年度）"
ws3["A2"].font = Font(bold=True, size=14)
for ref, t in [
    ("A4", "No"), ("B4", "施設名"), ("C4", "利用者数（人）"), ("D4", "開館日数（日）"),
    ("E4", "オンライン予約件数"), ("F4", "予算額（千円）"), ("G4", "オンライン予約率"),
]:
    head(ws3, ref, t)
FAC = [
    ("中央公民館", 12345, 300, 2400, 15800),
    ("東公民館", 5120, 298, 610, 7200),
    ("西公民館", 4870, 301, 0, 6900),
    ("市民体育館", 48211, 340, 21050, 32500),
    ("図書館", 152340, 285, 30455, 41000),
    ("老人福祉センター", 9800, 244, 0, 12300.5),
    ("障害者福祉センター", 3110, 244, None, 9800),
    ("子育て支援センター", 20015, 290, 8802, 14250),
]
FMT = {"C": "#,##0", "D": "0", "E": "#,##0", "F": "#,##0.0"}
for i, (name, *vals) in enumerate(FAC, start=1):
    r = 4 + i
    label(ws3, f"A{r}", i)
    label(ws3, f"B{r}", name)
    for col, v in zip("CDEF", vals):
        input_cell(ws3, f"{col}{r}", f"{name} × {ws3[col + '4'].value}", number_format=FMT[col])
        if v is None:
            answer(ws3, f"{col}{r}", "blank", note="該当なし→空欄で書く例")
        else:
            answer(ws3, f"{col}{r}", "number", v)
    g = ws3[f"G{r}"]
    g.value = f'=IF(C{r}=0,"",E{r}/C{r})'
    g.number_format = "0.0%"
    g.fill = CALC_FILL
    g.border = BOX
label(ws3, "B13", "合計")
ws3["B13"].font = Font(bold=True)
for col in "CDEF":
    c = ws3[f"{col}13"]
    c.value = f"=SUM({col}5:{col}12)"
    c.number_format = FMT[col]
    c.fill = CALC_FILL
    c.border = BOX
    c.font = Font(bold=True)
ws3["G13"] = '=IF(C13=0,"",E13/C13)'
ws3["G13"].number_format = "0.0%"
ws3["G13"].fill = CALC_FILL
ws3["G13"].border = BOX
ws3.column_dimensions["A"].width = 6
ws3.column_dimensions["B"].width = 24
for col in "CDEFG":
    ws3.column_dimensions[col].width = 18
ws3.freeze_panes = "C5"
ws3.print_area = "A1:G13"
ws3.page_setup.orientation = "landscape"
wb.defined_names["施設別入力"] = DefinedName("施設別入力", attr_text="'施設別実績'!$C$5:$F$12")

wb.properties.creator = "架空省 架空課"
wb.properties.title = "地域デジタル化取組状況調査（架空）"
# 生成物を毎回同じにするため日時を固定する
wb.properties.created = datetime.datetime(2026, 11, 1, 0, 0, 0)
wb.properties.modified = datetime.datetime(2026, 11, 1, 0, 0, 0)

assert len(input_cells) == 62, len(input_cells)
assert len(answers) == 62, len(answers)
OUT.parent.mkdir(exist_ok=True)
wb.save(OUT)

# ---------------------------------------------------------------- 図形の追加
# openpyxl は図形を作れないので、取組状況シートにテキストボックスを直接足す。
DRAWING = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><xdr:twoCellAnchor editAs="oneCell"><xdr:from><xdr:col>4</xdr:col><xdr:colOff>152400</xdr:colOff><xdr:row>4</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>7</xdr:col><xdr:colOff>152400</xdr:colOff><xdr:row>7</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:sp macro="" textlink=""><xdr:nvSpPr><xdr:cNvPr id="2" name="記入例の吹き出し"/><xdr:cNvSpPr txBox="1"/></xdr:nvSpPr><xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1828800" cy="571500"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="FFFFE0"/></a:solidFill><a:ln w="9525"><a:solidFill><a:srgbClr val="C00000"/></a:solidFill></a:ln></xdr:spPr><xdr:txBody><a:bodyPr vertOverflow="clip" wrap="square" rtlCol="0" anchor="t"/><a:lstStyle/><a:p><a:r><a:rPr lang="ja-JP" sz="1000"/><a:t>【図形】記入例：問1は半角数字で入力</a:t></a:r></a:p></xdr:txBody></xdr:sp><xdr:clientData/></xdr:twoCellAnchor></xdr:wsDr>"""
DRAWING_CT = '<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>'
DRAWING_REL = '<Relationship Id="rIdShape1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>'

src = zipfile.ZipFile(OUT)
names = src.namelist()
parts = {n: src.read(n) for n in names}
src.close()

wbxml = parts["xl/workbook.xml"].decode("utf-8")
rels = parts["xl/_rels/workbook.xml.rels"].decode("utf-8")
m = re.search(r'<sheet\b[^>]*name="取組状況"[^>]*r:id="([^"]+)"', wbxml)
rid = m.group(1)
target = re.search(r'<Relationship\b[^>]*Id="%s"[^>]*Target="([^"]+)"' % rid, rels) or re.search(
    r'<Relationship\b[^>]*Target="([^"]+)"[^>]*Id="%s"' % rid, rels
)
sheet_path = "xl/" + target.group(1).lstrip("/").removeprefix("xl/")
sheet_rels_path = sheet_path.replace("worksheets/", "worksheets/_rels/") + ".rels"

sheet_xml = parts[sheet_path].decode("utf-8")
assert "<drawing " not in sheet_xml
# CT_Worksheet の要素順では drawing は legacyDrawing の前、pageSetup の後
anchor = "<legacyDrawing " if "<legacyDrawing " in sheet_xml else "</worksheet>"
sheet_xml = sheet_xml.replace(anchor, '<drawing r:id="rIdShape1"/>' + anchor, 1)
if "xmlns:r=" not in re.search(r"<worksheet\b[^>]*>", sheet_xml).group(0):
    sheet_xml = sheet_xml.replace(
        "<worksheet ", '<worksheet xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ', 1
    )
parts[sheet_path] = sheet_xml.encode("utf-8")

if sheet_rels_path in parts:
    r = parts[sheet_rels_path].decode("utf-8")
    parts[sheet_rels_path] = r.replace("</Relationships>", DRAWING_REL + "</Relationships>").encode("utf-8")
else:
    names.append(sheet_rels_path)
    parts[sheet_rels_path] = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + DRAWING_REL
        + "</Relationships>"
    ).encode("utf-8")
names.append("xl/drawings/drawing1.xml")
parts["xl/drawings/drawing1.xml"] = DRAWING.encode("utf-8")
ct = parts["[Content_Types].xml"].decode("utf-8")
parts["[Content_Types].xml"] = ct.replace("</Types>", DRAWING_CT + "</Types>").encode("utf-8")

with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as z:
    for n in names:
        info = zipfile.ZipInfo(n, date_time=(2026, 11, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        z.writestr(info, parts[n])

(ROOT / "fixtures" / "answers.json").write_text(
    json.dumps(answers, ensure_ascii=False, indent=1) + "\n", encoding="utf-8"
)
(ROOT / "fixtures" / "input-cells.json").write_text(
    json.dumps(input_cells, ensure_ascii=False, indent=1) + "\n", encoding="utf-8"
)
print(f"{OUT.relative_to(ROOT)}: 入力セル {len(input_cells)}、期待値 {len(answers)}")
