import { getSandbox } from "@cloudflare/sandbox";
import { Think } from "@cloudflare/think";
import { generateText, stepCountIs, tool } from "ai";
import { createAiGateway } from "ai-gateway-provider";
import { createWorkersAI } from "workers-ai-provider";
import { z } from "zod";
import {
  arrayBufferToBase64,
  configuredModelEntries,
  generatedTextFromResult,
  getSpreadsheetRow,
  json,
  jsonRenderResponseInstructions,
  listSpreadsheetRevisionRows,
  modelEntriesForRequest,
  modelConfig,
  parseJsonText,
  parseStringArray,
  providerModel,
  requestedModelEntry,
  runPython,
  safeFilename,
  safeTraceDetail,
  spreadsheetIdFromAgentName,
  stripCodeFence,
  traceDetail,
  type AgentChatMessage,
  type AgentRequestPayload,
  type AgentTraceEvent,
  type Env,
  type ModelEntry,
  type TraceInput,
} from "./http";

type CodemodeExtraction = {
  description: string;
  filename: string;
  format: string;
  metadata: {
    category: string;
    confidence_score: number;
    caveats: string;
    description: string;
    dimensions: Record<string, unknown>;
    domain: string;
    extraction_notes: string;
    geography: string;
    measures: Record<string, unknown>;
    source_summary: string;
    time_period: string;
    title: string;
    units: string;
  };
  tables: Array<{
    columns: string[];
    name: string;
    rows: Array<{
      cells: Record<string, string | number | boolean | null>;
      source_ref: string;
      source_row: number;
    }>;
  }>;
};

type CodemodeExtractorKind = "xlsx" | "ods" | "other";

type CodemodeExtractorProfile = {
  codeRules: string[];
  description: string;
  helperLines: string[];
  kind: CodemodeExtractorKind;
  plannerRules: string[];
  recipe: string[];
  title: string;
};


const CODEMODE_INSPECTION_SCRIPT = String.raw`
import csv
import json
import os
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

path = Path(SPREADSHEET_PATH)
suffix = path.suffix.lower()

def clean(value):
    if value is None:
        return None
    try:
        import math
        if isinstance(value, float):
            if math.isnan(value) or math.isinf(value):
                return None
            if value.is_integer():
                return int(value)
    except Exception:
        pass
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return value

def clean_matrix(rows, limit=20):
    cleaned = []
    for row in rows[:limit]:
        cleaned.append([clean(value) for value in list(row)])
    return cleaned

def sniff_delimiter(path, fallback):
    with open(path, "r", encoding="utf-8-sig", errors="replace", newline="") as handle:
        sample = handle.read(65536)
    if not sample.strip():
        return fallback
    try:
        return csv.Sniffer().sniff(sample, delimiters=[",", "\t", ";", "|"]).delimiter
    except Exception:
        return fallback

def inspect_delimited(path, suffix):
    import pandas as pd
    sep = "\t" if suffix == ".tsv" else sniff_delimiter(path, ",")
    try:
        return (
            pd.read_csv(
                path,
                sep=sep,
                header=None,
                nrows=20,
                dtype=object,
                engine="python",
                on_bad_lines="skip",
                encoding="utf-8-sig",
            ).where(lambda frame: frame.notna(), None),
            sep,
            "pandas-python",
        )
    except Exception as pandas_error:
        rows = []
        with open(path, newline="", encoding="utf-8-sig", errors="replace") as handle:
            reader = csv.reader(handle, delimiter=sep)
            for row_index, row in enumerate(reader):
                if row_index >= 20:
                    break
                rows.append(row)
        max_columns = max([len(row) for row in rows], default=0)
        normalized = [row + [None] * (max_columns - len(row)) for row in rows]
        return pd.DataFrame(normalized, dtype=object), sep, f"csv-reader fallback after {type(pandas_error).__name__}"

def text_from_cell(cell, ns):
    values = []
    for text_node in cell.findall(".//text:p", ns):
        text = "".join(text_node.itertext()).strip()
        if text:
            values.append(text)
    if values:
        return "\n".join(values)
    return cell.attrib.get(f"{{{ns['office']}}}value") or cell.attrib.get(f"{{{ns['office']}}}string-value") or ""

def inspect_ods(path, max_sheets=12, max_rows=20, max_cells=80):
    ns = {
        "office": "urn:oasis:names:tc:opendocument:xmlns:office:1.0",
        "table": "urn:oasis:names:tc:opendocument:xmlns:table:1.0",
        "text": "urn:oasis:names:tc:opendocument:xmlns:text:1.0",
    }
    sheets = []
    with zipfile.ZipFile(path) as archive:
        with archive.open("content.xml") as handle:
            context = ET.iterparse(handle, events=("end",))
            for _, element in context:
                if element.tag != f"{{{ns['table']}}}table":
                    continue
                sheet_name = element.attrib.get(f"{{{ns['table']}}}name", f"sheet_{len(sheets) + 1}")
                rows = []
                max_columns = 0
                for row in element.findall("table:table-row", ns):
                    repeat_rows = int(row.attrib.get(f"{{{ns['table']}}}number-rows-repeated", "1") or "1")
                    if repeat_rows > 1000:
                        repeat_rows = 1
                    row_values = []
                    for cell in list(row):
                        if cell.tag not in {
                            f"{{{ns['table']}}}table-cell",
                            f"{{{ns['table']}}}covered-table-cell",
                        }:
                            continue
                        repeat_cols = int(cell.attrib.get(f"{{{ns['table']}}}number-columns-repeated", "1") or "1")
                        if repeat_cols > 1000:
                            repeat_cols = 1
                        value = text_from_cell(cell, ns)
                        for _ in range(repeat_cols):
                            if len(row_values) >= max_cells:
                                break
                            row_values.append(value)
                        if len(row_values) >= max_cells:
                            break
                    if any(str(value).strip() for value in row_values):
                        for _ in range(min(repeat_rows, max_rows - len(rows))):
                            rows.append(row_values)
                            max_columns = max(max_columns, len(row_values))
                    if len(rows) >= max_rows:
                        break
                sheets.append({
                    "name": sheet_name,
                    "rows_seen": len(rows),
                    "columns_seen": max_columns,
                    "parser": "ods-content-xml",
                    "sample": clean_matrix(rows),
                })
                element.clear()
                if len(sheets) >= max_sheets:
                    break
    return sheets

def xlsx_col_index(cell_ref):
    letters = []
    for char in str(cell_ref or ""):
        if char.isalpha():
            letters.append(char.upper())
        else:
            break
    index = 0
    for char in letters:
        index = index * 26 + (ord(char) - ord("A") + 1)
    return max(index - 1, 0)

def inspect_xlsx_style_free(path, max_sheets=12, max_rows=20, max_cells=80):
    main_ns = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
    rel_ns = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    package_rel_ns = "http://schemas.openxmlformats.org/package/2006/relationships"
    ns = {"main": main_ns}
    sheets = []
    with zipfile.ZipFile(path) as archive:
        shared_strings = []
        try:
            with archive.open("xl/sharedStrings.xml") as handle:
                for _, element in ET.iterparse(handle, events=("end",)):
                    if element.tag == f"{{{main_ns}}}si":
                        shared_strings.append("".join(text.text or "" for text in element.findall(".//main:t", ns)))
                        element.clear()
        except KeyError:
            pass
        rels = {}
        try:
            rel_root = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
            for rel in rel_root:
                rel_id = rel.attrib.get("Id")
                target = rel.attrib.get("Target", "")
                if rel_id and target:
                    rels[rel_id] = "xl/" + target.lstrip("/")
        except KeyError:
            pass
        root = ET.fromstring(archive.read("xl/workbook.xml"))
        workbook_sheets = []
        for index, sheet in enumerate(root.findall(".//main:sheet", ns), start=1):
            name = sheet.attrib.get("name", f"sheet_{index}")
            rel_id = sheet.attrib.get(f"{{{rel_ns}}}id")
            workbook_sheets.append((name, rels.get(rel_id, f"xl/worksheets/sheet{index}.xml")))
        for sheet_name, sheet_path in workbook_sheets[:max_sheets]:
            rows = []
            max_columns = 0
            try:
                handle = archive.open(sheet_path)
            except KeyError:
                continue
            with handle:
                for _, row in ET.iterparse(handle, events=("end",)):
                    if row.tag != f"{{{main_ns}}}row":
                        continue
                    values = []
                    for cell in row.findall("main:c", ns):
                        col_index = xlsx_col_index(cell.attrib.get("r", ""))
                        if col_index >= max_cells:
                            continue
                        while len(values) < col_index:
                            values.append("")
                        value_node = cell.find("main:v", ns)
                        value = value_node.text if value_node is not None and value_node.text is not None else ""
                        if cell.attrib.get("t") == "s":
                            try:
                                value = shared_strings[int(value)]
                            except Exception:
                                pass
                        elif cell.attrib.get("t") == "inlineStr":
                            value = "".join(text.text or "" for text in cell.findall(".//main:t", ns))
                        if len(values) < max_cells:
                            values.append(value)
                    if any(str(value).strip() for value in values):
                        rows.append(values[:max_cells])
                        max_columns = max(max_columns, len(values[:max_cells]))
                    row.clear()
                    if len(rows) >= max_rows:
                        break
            sheets.append({
                "name": sheet_name,
                "rows_seen": len(rows),
                "columns_seen": max_columns,
                "parser": "xlsx-xml-style-free",
                "sample": clean_matrix(rows),
            })
    return sheets

profile = {
    "filename": path.name,
    "extension": suffix,
    "size_bytes": path.stat().st_size,
    "sheets": [],
}

if suffix in [".csv", ".tsv"]:
    sample, delimiter, parser = inspect_delimited(path, suffix)
    profile["sheets"].append({
        "name": path.stem,
        "rows_seen": int(len(sample.index)),
        "columns_seen": int(len(sample.columns)),
        "delimiter": delimiter,
        "parser": parser,
        "sample": clean_matrix(sample.values.tolist()),
    })
elif suffix == ".ods":
    profile["sheets"].extend(inspect_ods(path))
elif suffix in [".xlsx", ".xls"]:
    try:
        import pandas as pd
        sheets = pd.read_excel(path, sheet_name=None, header=None, nrows=20, dtype=object)
        for sheet_name, frame in sheets.items():
            sample = frame.where(frame.notna(), None)
            profile["sheets"].append({
                "name": str(sheet_name),
                "rows_seen": int(len(sample.index)),
                "columns_seen": int(len(sample.columns)),
                "parser": "pandas-read-excel",
                "sample": clean_matrix(sample.values.tolist()),
            })
    except Exception as error:
        profile["xlsx_inspection_fallback"] = f"{type(error).__name__}: {str(error)[:300]}"
        profile["sheets"].extend(inspect_xlsx_style_free(path))
elif suffix == ".xml":
    tree = ET.parse(path)
    root = tree.getroot()
    elements = []
    for element_index, element in enumerate(root.iter(), start=1):
        if element_index > 40:
            break
        text = (element.text or "").strip()
        if element.attrib or text:
            elements.append({"attributes": dict(element.attrib), "tag": element.tag, "text": text[:500]})
    profile["root_tag"] = root.tag
    profile["sheets"].append({
        "name": root.tag or path.stem,
        "rows_seen": len(elements),
        "columns_seen": 3,
        "sample": elements,
    })
else:
    raise ValueError(f"Unsupported file extension: {suffix}")

print(json.dumps(profile, ensure_ascii=False, allow_nan=False))
`;

const RAW_PREVIEW_SCRIPT = String.raw`
import csv
import json
import math
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

path = Path(SPREADSHEET_PATH)
suffix = path.suffix.lower()

def clean(value):
    if value is None:
        return None
    try:
        if hasattr(value, "item"):
            value = value.item()
    except Exception:
        pass
    if isinstance(value, float):
        if math.isnan(value) or math.isinf(value):
            return None
        if value.is_integer():
            return int(value)
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return value

def normalize_rows(rows, limit=100):
    return [[clean(cell) for cell in list(row)] for row in rows[:limit]]

def ods_cell_text(cell, ns):
    values = []
    for text_node in cell.findall(".//text:p", ns):
        text = "".join(text_node.itertext()).strip()
        if text:
            values.append(text)
    if values:
        return "\n".join(values)
    return cell.attrib.get(f"{{{ns['office']}}}value") or cell.attrib.get(f"{{{ns['office']}}}string-value") or ""

def preview_ods(path, max_sheets=12, max_rows=100, max_cells=80):
    ns = {
        "office": "urn:oasis:names:tc:opendocument:xmlns:office:1.0",
        "table": "urn:oasis:names:tc:opendocument:xmlns:table:1.0",
        "text": "urn:oasis:names:tc:opendocument:xmlns:text:1.0",
    }
    output = []
    with zipfile.ZipFile(path) as archive:
        with archive.open("content.xml") as handle:
            for _, element in ET.iterparse(handle, events=("end",)):
                if element.tag != f"{{{ns['table']}}}table":
                    continue
                sheet_name = element.attrib.get(f"{{{ns['table']}}}name", f"sheet_{len(output) + 1}")
                rows = []
                max_columns = 0
                for row in element.findall("table:table-row", ns):
                    row_values = []
                    repeat_rows = int(row.attrib.get(f"{{{ns['table']}}}number-rows-repeated", "1") or "1")
                    if repeat_rows > 1000:
                        repeat_rows = 1
                    for cell in list(row):
                        if cell.tag not in {
                            f"{{{ns['table']}}}table-cell",
                            f"{{{ns['table']}}}covered-table-cell",
                        }:
                            continue
                        repeat_cols = int(cell.attrib.get(f"{{{ns['table']}}}number-columns-repeated", "1") or "1")
                        if repeat_cols > 1000:
                            repeat_cols = 1
                        value = ods_cell_text(cell, ns)
                        for _ in range(repeat_cols):
                            if len(row_values) >= max_cells:
                                break
                            row_values.append(value)
                        if len(row_values) >= max_cells:
                            break
                    if any(str(value).strip() for value in row_values):
                        for _ in range(min(repeat_rows, max_rows - len(rows))):
                            rows.append(row_values)
                            max_columns = max(max_columns, len(row_values))
                    if len(rows) >= max_rows:
                        break
                output.append({"name": sheet_name, "columns": max_columns, "rows": normalize_rows(rows)})
                element.clear()
                if len(output) >= max_sheets:
                    break
    return output

def xlsx_col_index(cell_ref):
    letters = []
    for char in str(cell_ref or ""):
        if char.isalpha():
            letters.append(char.upper())
        else:
            break
    index = 0
    for char in letters:
        index = index * 26 + (ord(char) - ord("A") + 1)
    return max(index - 1, 0)

def preview_xlsx_style_free(path, max_sheets=12, max_rows=100, max_cells=80):
    main_ns = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
    rel_ns = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    ns = {"main": main_ns}
    output = []
    with zipfile.ZipFile(path) as archive:
        shared_strings = []
        try:
            with archive.open("xl/sharedStrings.xml") as handle:
                for _, element in ET.iterparse(handle, events=("end",)):
                    if element.tag == f"{{{main_ns}}}si":
                        shared_strings.append("".join(text.text or "" for text in element.findall(".//main:t", ns)))
                        element.clear()
        except KeyError:
            pass
        rels = {}
        try:
            rel_root = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
            for rel in rel_root:
                rel_id = rel.attrib.get("Id")
                target = rel.attrib.get("Target", "")
                if rel_id and target:
                    rels[rel_id] = "xl/" + target.lstrip("/")
        except KeyError:
            pass
        root = ET.fromstring(archive.read("xl/workbook.xml"))
        workbook_sheets = []
        for index, sheet in enumerate(root.findall(".//main:sheet", ns), start=1):
            name = sheet.attrib.get("name", f"sheet_{index}")
            rel_id = sheet.attrib.get(f"{{{rel_ns}}}id")
            workbook_sheets.append((name, rels.get(rel_id, f"xl/worksheets/sheet{index}.xml")))
        for sheet_name, sheet_path in workbook_sheets[:max_sheets]:
            rows = []
            max_columns = 0
            try:
                handle = archive.open(sheet_path)
            except KeyError:
                continue
            with handle:
                for _, row in ET.iterparse(handle, events=("end",)):
                    if row.tag != f"{{{main_ns}}}row":
                        continue
                    values = []
                    for cell in row.findall("main:c", ns):
                        col_index = xlsx_col_index(cell.attrib.get("r", ""))
                        if col_index >= max_cells:
                            continue
                        while len(values) < col_index:
                            values.append("")
                        value_node = cell.find("main:v", ns)
                        value = value_node.text if value_node is not None and value_node.text is not None else ""
                        if cell.attrib.get("t") == "s":
                            try:
                                value = shared_strings[int(value)]
                            except Exception:
                                pass
                        elif cell.attrib.get("t") == "inlineStr":
                            value = "".join(text.text or "" for text in cell.findall(".//main:t", ns))
                        if len(values) < max_cells:
                            values.append(value)
                    if any(str(value).strip() for value in values):
                        rows.append(values[:max_cells])
                        max_columns = max(max_columns, len(values[:max_cells]))
                    row.clear()
                    if len(rows) >= max_rows:
                        break
            output.append({"name": sheet_name, "columns": max_columns, "rows": normalize_rows(rows)})
    return output

sheets = []

if suffix in [".csv", ".tsv"]:
    with open(path, newline="", encoding="utf-8-sig") as handle:
        dialect = csv.excel_tab if suffix == ".tsv" else csv.excel
        rows = list(csv.reader(handle, dialect=dialect))
    sheets.append({"name": path.stem, "columns": max([len(row) for row in rows], default=0), "rows": normalize_rows(rows)})
elif suffix == ".ods":
    sheets.extend(preview_ods(path))
elif suffix == ".xlsx":
    try:
        import pandas as pd
        workbook = pd.read_excel(path, sheet_name=None, header=None, nrows=100, dtype=object)
        for name, frame in workbook.items():
            clean_frame = frame.where(frame.notna(), None)
            sheets.append({
                "name": str(name),
                "columns": int(len(clean_frame.columns)),
                "rows": normalize_rows(clean_frame.values.tolist()),
            })
    except Exception:
        sheets.extend(preview_xlsx_style_free(path))
elif suffix == ".xls":
    import pandas as pd
    workbook = pd.read_excel(path, sheet_name=None, header=None, nrows=100, dtype=object)
    for name, frame in workbook.items():
        clean_frame = frame.where(frame.notna(), None)
        sheets.append({
            "name": str(name),
            "columns": int(len(clean_frame.columns)),
            "rows": normalize_rows(clean_frame.values.tolist()),
        })
elif suffix == ".xml":
    tree = ET.parse(path)
    root = tree.getroot()
    rows = [["tag", "attributes", "text"]]
    for element in root.iter():
        text = (element.text or "").strip()
        if element.attrib or text:
            rows.append([element.tag, json.dumps(element.attrib, ensure_ascii=False), text])
        if len(rows) >= 100:
            break
    sheets.append({"name": root.tag or path.stem, "columns": 3, "rows": rows})
else:
    raise ValueError(f"Unsupported file extension: {suffix}")

print(json.dumps({"format": suffix.lstrip("."), "sheets": sheets}, ensure_ascii=False, allow_nan=False))
`;

const CODEMODE_RUNTIME_HELPERS = String.raw`
import csv
import json
import math
import pathlib
import zipfile
import xml.etree.ElementTree as ET

def cm_normalize_value(value):
    if value is None:
        return None
    if isinstance(value, float):
        if math.isnan(value) or math.isinf(value):
            return None
        if value.is_integer():
            return int(value)
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return value

def cm_emit_extraction(payload):
    print(json.dumps(payload, ensure_ascii=False, allow_nan=False))

def cm_ods_cell_text(cell, ns):
    values = []
    for text_node in cell.findall(".//text:p", ns):
        text = "".join(text_node.itertext()).strip()
        if text:
            values.append(text)
    if values:
        return "\n".join(values)
    return cell.attrib.get(f"{{{ns['office']}}}value") or cell.attrib.get(f"{{{ns['office']}}}string-value") or ""

def cm_iter_ods_rows(path, max_sheets=None, max_rows_per_sheet=None, max_cells_per_row=120):
    ns = {
        "office": "urn:oasis:names:tc:opendocument:xmlns:office:1.0",
        "table": "urn:oasis:names:tc:opendocument:xmlns:table:1.0",
        "text": "urn:oasis:names:tc:opendocument:xmlns:text:1.0",
    }
    path = pathlib.Path(path)
    table_tag = f"{{{ns['table']}}}table"
    row_tag = f"{{{ns['table']}}}table-row"
    cell_tags = {
        f"{{{ns['table']}}}table-cell",
        f"{{{ns['table']}}}covered-table-cell",
    }
    table_name_attr = f"{{{ns['table']}}}name"
    repeated_rows_attr = f"{{{ns['table']}}}number-rows-repeated"
    repeated_cols_attr = f"{{{ns['table']}}}number-columns-repeated"
    sheet_count = 0
    current_sheet = None
    current_row = 0
    with zipfile.ZipFile(path) as archive:
        with archive.open("content.xml") as handle:
            for event, element in ET.iterparse(handle, events=("start", "end")):
                if event == "start" and element.tag == table_tag:
                    sheet_count += 1
                    current_row = 0
                    current_sheet = element.attrib.get(table_name_attr, f"sheet_{sheet_count}")
                    if max_sheets is not None and sheet_count > max_sheets:
                        current_sheet = None
                    continue

                if event == "end" and element.tag == row_tag and current_sheet:
                    current_row += 1
                    if max_rows_per_sheet is not None and current_row > max_rows_per_sheet:
                        element.clear()
                        continue
                    repeat_rows = int(element.attrib.get(repeated_rows_attr, "1") or "1")
                    if repeat_rows > 1000:
                        repeat_rows = 1
                    row_values = []
                    for cell in list(element):
                        if cell.tag not in cell_tags:
                            continue
                        repeat_cols = int(cell.attrib.get(repeated_cols_attr, "1") or "1")
                        if repeat_cols > 1000:
                            repeat_cols = 1
                        value = cm_ods_cell_text(cell, ns)
                        for _ in range(repeat_cols):
                            if len(row_values) >= max_cells_per_row:
                                break
                            row_values.append(value)
                        if len(row_values) >= max_cells_per_row:
                            break
                    if any(str(value).strip() for value in row_values):
                        for _ in range(repeat_rows):
                            yield {
                                "sheet_name": current_sheet,
                                "source_row": current_row,
                                "source_ref": f"{current_sheet}!row:{current_row}",
                                "values": [cm_normalize_value(value) for value in row_values],
                            }
                    element.clear()
                    continue

                if event == "end" and element.tag == table_tag:
                    current_sheet = None
                    element.clear()

def cm_ods_rows_by_sheet(path, max_sheets=None, max_rows_per_sheet=None, max_cells_per_row=120):
    sheets = {}
    for row in cm_iter_ods_rows(path, max_sheets=max_sheets, max_rows_per_sheet=max_rows_per_sheet, max_cells_per_row=max_cells_per_row):
        sheets.setdefault(row["sheet_name"], []).append(row)
    return sheets

def cm_xlsx_col_index(cell_ref):
    letters = []
    for char in str(cell_ref or ""):
        if char.isalpha():
            letters.append(char.upper())
        else:
            break
    index = 0
    for char in letters:
        index = index * 26 + (ord(char) - ord("A") + 1)
    return max(index - 1, 0)

def cm_xlsx_cell_text(cell, shared_strings, ns):
    cell_type = cell.attrib.get("t")
    if cell_type == "inlineStr":
        values = []
        for text_node in cell.findall(".//main:t", ns):
            if text_node.text:
                values.append(text_node.text)
        return "".join(values)
    value_node = cell.find("main:v", ns)
    value = value_node.text if value_node is not None and value_node.text is not None else ""
    if cell_type == "s":
        try:
            return shared_strings[int(value)]
        except Exception:
            return value
    if cell_type == "b":
        return "TRUE" if value == "1" else "FALSE"
    return value

def cm_xlsx_shared_strings(archive):
    ns = {"main": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
    try:
        handle = archive.open("xl/sharedStrings.xml")
    except KeyError:
        return []
    strings = []
    with handle:
        for event, element in ET.iterparse(handle, events=("end",)):
            if element.tag == f"{{{ns['main']}}}si":
                strings.append("".join(text.text or "" for text in element.findall(".//main:t", ns)))
                element.clear()
    return strings

def cm_xlsx_sheet_map(archive):
    main_ns = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
    rel_ns = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    package_rel_ns = "http://schemas.openxmlformats.org/package/2006/relationships"
    ns = {"main": main_ns, "rel": package_rel_ns}
    rels = {}
    try:
        rel_root = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
        for rel in rel_root:
            rel_id = rel.attrib.get("Id")
            target = rel.attrib.get("Target", "")
            if rel_id and target:
                rels[rel_id] = "xl/" + target.lstrip("/")
    except KeyError:
        pass
    root = ET.fromstring(archive.read("xl/workbook.xml"))
    sheets = []
    for index, sheet in enumerate(root.findall(".//main:sheet", {"main": main_ns}), start=1):
        name = sheet.attrib.get("name", f"sheet_{index}")
        rel_id = sheet.attrib.get(f"{{{rel_ns}}}id")
        target = rels.get(rel_id, f"xl/worksheets/sheet{index}.xml")
        sheets.append((name, target))
    return sheets

def cm_iter_xlsx_rows(path, max_sheets=None, max_rows_per_sheet=None, max_cells_per_row=120):
    ns = {"main": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
    path = pathlib.Path(path)
    with zipfile.ZipFile(path) as archive:
        shared_strings = cm_xlsx_shared_strings(archive)
        for sheet_index, (sheet_name, sheet_path) in enumerate(cm_xlsx_sheet_map(archive), start=1):
            if max_sheets is not None and sheet_index > max_sheets:
                break
            try:
                handle = archive.open(sheet_path)
            except KeyError:
                continue
            yielded = 0
            with handle:
                for event, element in ET.iterparse(handle, events=("end",)):
                    if element.tag != f"{{{ns['main']}}}row":
                        continue
                    row_number = int(element.attrib.get("r", str(yielded + 1)) or str(yielded + 1))
                    if max_rows_per_sheet is not None and yielded >= max_rows_per_sheet:
                        element.clear()
                        break
                    values = []
                    for cell in element.findall("main:c", ns):
                        col_index = cm_xlsx_col_index(cell.attrib.get("r", ""))
                        if col_index >= max_cells_per_row:
                            continue
                        while len(values) < col_index:
                            values.append("")
                        if len(values) < max_cells_per_row:
                            values.append(cm_xlsx_cell_text(cell, shared_strings, ns))
                    if any(str(value).strip() for value in values):
                        yielded += 1
                        yield {
                            "sheet_name": sheet_name,
                            "source_row": row_number,
                            "source_ref": f"{sheet_name}!row:{row_number}",
                            "values": [cm_normalize_value(value) for value in values[:max_cells_per_row]],
                        }
                    element.clear()

def cm_xlsx_rows_by_sheet(path, max_sheets=None, max_rows_per_sheet=None, max_cells_per_row=120):
    sheets = {}
    for row in cm_iter_xlsx_rows(path, max_sheets=max_sheets, max_rows_per_sheet=max_rows_per_sheet, max_cells_per_row=max_cells_per_row):
        sheets.setdefault(row["sheet_name"], []).append(row)
    return sheets

def cm_row_values(row):
    return row.get("values", row) if isinstance(row, dict) else row

def cm_first_nonempty_index(values):
    for index, value in enumerate(values):
        if str(value).strip():
            return index
    return None

def cm_last_nonempty_index(values):
    for index in range(len(values) - 1, -1, -1):
        if str(values[index]).strip():
            return index
    return None

def cm_trim_empty_edges(values):
    start = cm_first_nonempty_index(values)
    if start is None:
        return []
    end = cm_last_nonempty_index(values)
    return values[start:end + 1]

def cm_table_start_col(row):
    values = cm_row_values(row)
    start = cm_first_nonempty_index(values)
    return start if start is not None else 0

def cm_cell(row, index, default=""):
    values = cm_row_values(row)
    return values[index] if index < len(values) else default

def cm_table_cell(row, index, start_col=0, default=""):
    return cm_cell(row, start_col + index, default)

def cm_source_row(row, fallback=None):
    return row.get("source_row", fallback) if isinstance(row, dict) else fallback

def cm_source_ref(row, fallback=""):
    return row.get("source_ref", fallback) if isinstance(row, dict) else fallback

def cm_slug(value, fallback="value"):
    return cm_safe_column_name(str(value or "").replace("%", "percent"), fallback)

def cm_parse_number(value):
    text = str(value or "").strip().replace(",", "")
    if not text or text.lower() in {"n/a", "na", "null", "none"} or text in {"[u]", "[x1]", "[x2]"}:
        return None
    try:
        number = float(text.rstrip("%"))
    except ValueError:
        return None
    return int(number) if number.is_integer() else number

def cm_parse_percent(value):
    number = cm_parse_number(value)
    return number

def cm_missing_status(value):
    text = str(value or "").strip()
    return text if text in {"[u]", "[x1]", "[x2]", "n/a", "na"} else None

def cm_parse_ci_percent(value):
    import re
    text = str(value or "").strip()
    match = re.match(r"([\\d.]+)%\\s*\\(([\\d.]+)%\\s*to\\s*([\\d.]+)%\\)", text)
    if not match:
        return {"percentage": cm_parse_percent(text), "ci_lower": None, "ci_upper": None, "status": cm_missing_status(text)}
    return {
        "percentage": float(match.group(1)),
        "ci_lower": float(match.group(2)),
        "ci_upper": float(match.group(3)),
        "status": None,
    }

def cm_find_row_index(rows, first_cell=None, contains=None, max_scan=100):
    for index, row in enumerate(rows[:max_scan]):
        values = [str(value).strip() for value in cm_row_values(row)]
        first_nonempty = next((value for value in values if value), "")
        if first_cell is not None and first_nonempty.lower() == str(first_cell).strip().lower():
            return index
        if contains is not None and any(str(contains).strip().lower() in value.lower() for value in values):
            return index
    return None

def cm_table_region(rows, first_cell=None, contains=None, header_index=None, max_scan=100):
    if header_index is None:
        header_index = cm_find_row_index(rows, first_cell=first_cell, contains=contains, max_scan=max_scan)
    if header_index is None:
        header_index = cm_detect_header_row(rows, max_scan=max_scan)
    header_row = rows[header_index]
    start_col = cm_table_start_col(header_row)
    header = cm_row_values(header_row)
    end_col = cm_last_nonempty_index(header)
    if end_col is None:
        end_col = len(header) - 1
    return {
        "header_index": header_index,
        "start_col": start_col,
        "end_col": end_col,
        "header": header[start_col:end_col + 1],
        "rows": rows[header_index + 1:],
    }

def cm_detect_header_row(rows, min_filled=2, max_scan=25):
    best_index = 0
    best_score = -1
    for index, row in enumerate(rows[:max_scan]):
        values = row.get("values", row) if isinstance(row, dict) else row
        filled = [str(value).strip() for value in values if str(value).strip()]
        alpha = sum(1 for value in filled if any(char.isalpha() for char in value))
        score = alpha * 2 + len(filled)
        if len(filled) >= min_filled and score > best_score:
            best_index = index
            best_score = score
    return best_index

def cm_safe_column_name(value, fallback):
    text = str(value or "").strip().lower()
    out = []
    previous_underscore = False
    for char in text:
        if char.isalnum():
            out.append(char)
            previous_underscore = False
        elif not previous_underscore:
            out.append("_")
            previous_underscore = True
    name = "".join(out).strip("_")[:64] or fallback
    if name and name[0].isdigit():
        name = f"c_{name}"
    return name

def cm_unique_columns(values):
    counts = {}
    columns = []
    for index, value in enumerate(values):
        base = cm_safe_column_name(value, f"column_{index + 1}")
        count = counts.get(base, 0) + 1
        counts[base] = count
        columns.append(base if count == 1 else f"{base}_{count}")
    return columns

def cm_rows_to_records(rows, header_index=None, include_blank=False):
    if not rows:
        return []
    if header_index is None:
        header_index = cm_detect_header_row(rows)
    header = cm_row_values(rows[header_index])
    start_col = cm_table_start_col(rows[header_index])
    end_col = cm_last_nonempty_index(header)
    if end_col is None:
        end_col = len(header) - 1
    table_header = header[start_col:end_col + 1]
    columns = cm_unique_columns(table_header)
    records = []
    for row in rows[header_index + 1:]:
        values = cm_row_values(row)
        table_values = values[start_col:end_col + 1]
        if not include_blank and not any(str(value).strip() for value in table_values):
            continue
        cells = {column: cm_normalize_value(table_values[index]) if index < len(table_values) else None for index, column in enumerate(columns)}
        records.append({
            "source_row": row.get("source_row", len(records) + 1) if isinstance(row, dict) else len(records) + 1,
            "source_ref": f"{row.get('source_ref', f'row:{len(records) + 1}')} col:{start_col + 1}:{end_col + 1}" if isinstance(row, dict) else f"row:{len(records) + 1}",
            "values": [cm_normalize_value(value) for value in values],
            "cells": cells,
        })
    return records

def cm_ods_records_by_sheet(path, max_sheets=None, max_rows_per_sheet=None, max_cells_per_row=120, include_blank=False):
    output = {}
    for sheet_name, rows in cm_ods_rows_by_sheet(
        path,
        max_sheets=max_sheets,
        max_rows_per_sheet=max_rows_per_sheet,
        max_cells_per_row=max_cells_per_row,
    ).items():
        header_index = cm_detect_header_row(rows)
        records = cm_rows_to_records(rows, header_index=header_index, include_blank=include_blank)
        output[sheet_name] = {
            "header_index": header_index,
            "profile": cm_profile_rows(rows),
            "records": records,
            "rows": rows,
        }
    return output

def cm_unpivot_records(records, id_columns, variable_name="measure", value_name="value"):
    output = []
    id_set = set(id_columns)
    for record in records:
        cells = record.get("cells", {})
        id_values = {column: cells.get(column) for column in id_columns}
        for column, value in cells.items():
            if column in id_set:
                continue
            output.append({
                "source_row": record.get("source_row"),
                "source_ref": record.get("source_ref"),
                "cells": {**id_values, variable_name: column, value_name: value},
            })
    return output

def cm_profile_rows(rows, max_scan=100):
    non_empty = []
    widths = {}
    for row in rows[:max_scan]:
        values = row.get("values", row) if isinstance(row, dict) else row
        filled = sum(1 for value in values if str(value).strip())
        if filled:
            non_empty.append(filled)
            widths[len(values)] = widths.get(len(values), 0) + 1
    return {
        "likely_header_index": cm_detect_header_row(rows[:max_scan]) if rows else 0,
        "non_empty_rows_scanned": len(non_empty),
        "max_filled_cells": max(non_empty) if non_empty else 0,
        "width_histogram": widths,
    }

def cm_read_delimited_rows(path, delimiter=None, max_rows=None):
    path = pathlib.Path(path)
    if delimiter is None:
        delimiter = "\t" if path.suffix.lower() == ".tsv" else ","
    rows = []
    with open(path, newline="", encoding="utf-8-sig", errors="replace") as handle:
        reader = csv.reader(handle, delimiter=delimiter)
        for row_index, row in enumerate(reader, start=1):
            rows.append({
                "sheet_name": path.stem,
                "source_row": row_index,
                "source_ref": f"{path.name}:row {row_index}",
                "values": [cm_normalize_value(value) for value in row],
            })
            if max_rows is not None and len(rows) >= max_rows:
                break
    return rows
`;


function normalizeJsonValue(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value instanceof Date) return value.toISOString();
  return JSON.stringify(value);
}

function normalizeCodemodeExtraction(value: unknown, filename: string): CodemodeExtraction {
  const input = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const metadataInput = input.metadata && typeof input.metadata === "object" ? (input.metadata as Record<string, unknown>) : {};
  const rawTables = Array.isArray(input.tables) ? input.tables : [];
  const tables = rawTables.map((rawTable, tableIndex) => {
    const table = rawTable && typeof rawTable === "object" ? (rawTable as Record<string, unknown>) : {};
    const rawRows = Array.isArray(table.rows) ? table.rows : [];
    const inferredColumns = new Set<string>();

    for (const rawRow of rawRows) {
      const row = rawRow && typeof rawRow === "object" ? (rawRow as Record<string, unknown>) : {};
      const cells = row.cells && typeof row.cells === "object" ? (row.cells as Record<string, unknown>) : {};
      for (const column of Object.keys(cells)) inferredColumns.add(column);
    }

    const listedColumns = Array.isArray(table.columns) ? table.columns : [];
    const columns = [...listedColumns, ...[...inferredColumns].filter((column) => !listedColumns.includes(column))]
      .map((column, columnIndex) => String(column || `column_${columnIndex + 1}`))
      .filter(Boolean);

    const rows = rawRows.map((rawRow, rowIndex) => {
      const row = rawRow && typeof rawRow === "object" ? (rawRow as Record<string, unknown>) : {};
      const cells = row.cells && typeof row.cells === "object" ? (row.cells as Record<string, unknown>) : {};
      const sourceRow = typeof row.source_row === "number" && Number.isFinite(row.source_row) ? row.source_row : rowIndex + 1;
      const normalizedCells: Record<string, string | number | boolean | null> = {};

      for (const column of columns) {
        normalizedCells[column] = normalizeJsonValue(cells[column]);
      }

      return {
        cells: normalizedCells,
        source_ref: typeof row.source_ref === "string" ? row.source_ref : `${table.name ?? `table_${tableIndex + 1}`}!row:${sourceRow}`,
        source_row: sourceRow,
      };
    });

    return {
      columns,
      name: typeof table.name === "string" && table.name.trim() ? table.name : `table_${tableIndex + 1}`,
      rows,
    };
  });

  const description =
      typeof input.description === "string" && input.description.trim()
        ? input.description
        : typeof metadataInput.description === "string" && metadataInput.description.trim()
          ? metadataInput.description
          : `${filename} was analyzed in codemode into ${tables.length} table${tables.length === 1 ? "" : "s"}.`;
  const metadata = {
    category: typeof metadataInput.category === "string" && metadataInput.category.trim() ? metadataInput.category : "Uncategorised",
    caveats: typeof metadataInput.caveats === "string" ? metadataInput.caveats : "",
    confidence_score:
      typeof metadataInput.confidence_score === "number" && Number.isFinite(metadataInput.confidence_score)
        ? Math.max(0, Math.min(100, Math.round(metadataInput.confidence_score)))
        : 75,
    description,
    dimensions:
      metadataInput.dimensions && typeof metadataInput.dimensions === "object"
        ? (metadataInput.dimensions as Record<string, unknown>)
        : {},
    domain: typeof metadataInput.domain === "string" && metadataInput.domain.trim() ? metadataInput.domain : "general",
    extraction_notes: typeof metadataInput.extraction_notes === "string" ? metadataInput.extraction_notes : "",
    geography: typeof metadataInput.geography === "string" ? metadataInput.geography : "",
    measures:
      metadataInput.measures && typeof metadataInput.measures === "object"
        ? (metadataInput.measures as Record<string, unknown>)
        : {},
    source_summary: typeof metadataInput.source_summary === "string" ? metadataInput.source_summary : "",
    time_period: typeof metadataInput.time_period === "string" ? metadataInput.time_period : "",
    title:
      typeof metadataInput.title === "string" && metadataInput.title.trim()
        ? metadataInput.title
        : filename.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " "),
    units: typeof metadataInput.units === "string" ? metadataInput.units : "",
  };

  return {
    description,
    filename: typeof input.filename === "string" ? input.filename : filename,
    format: typeof input.format === "string" ? input.format : filename.split(".").pop()?.toLowerCase() ?? "unknown",
    metadata,
    tables,
  };
}


function profileSummary(profile: unknown) {
  if (typeof profile !== "object" || profile === null) return profile;
  const record = profile as {
    extension?: unknown;
    filename?: unknown;
    sheets?: unknown;
    size_bytes?: unknown;
  };
  const sheets = Array.isArray(record.sheets)
    ? record.sheets.map((sheet) => {
        if (typeof sheet !== "object" || sheet === null) return sheet;
        const typedSheet = sheet as {
          columns_seen?: unknown;
          delimiter?: unknown;
          name?: unknown;
          parser?: unknown;
          rows_seen?: unknown;
        };
        return {
          columns_seen: typedSheet.columns_seen,
          delimiter: typedSheet.delimiter,
          name: typedSheet.name,
          parser: typedSheet.parser,
          rows_seen: typedSheet.rows_seen,
        };
      })
    : [];
  return {
    extension: record.extension,
    filename: record.filename,
    sheets,
    size_bytes: record.size_bytes,
  };
}

function compactProfile(profile: unknown) {
  if (typeof profile !== "object" || profile === null) return profile;
  const record = profile as {
    extension?: unknown;
    filename?: unknown;
    sheets?: unknown;
    size_bytes?: unknown;
  };
  const sheets = Array.isArray(record.sheets)
    ? record.sheets.slice(0, 16).map((sheet) => {
        if (typeof sheet !== "object" || sheet === null) return sheet;
        const typedSheet = sheet as {
          columns_seen?: unknown;
          delimiter?: unknown;
          name?: unknown;
          parser?: unknown;
          rows_seen?: unknown;
          sample?: unknown;
        };
        const sampleRows = Array.isArray(typedSheet.sample) ? typedSheet.sample : [];
        const usefulRows = sampleRows
          .filter((row) => Array.isArray(row) && row.some((cell) => String(cell ?? "").trim()))
          .slice(0, 8)
          .map((row) =>
            Array.isArray(row)
              ? row.slice(0, 18).map((cell) => {
                  const text = String(cell ?? "");
                  return text.length > 120 ? `${text.slice(0, 120)}...` : text;
                })
              : row,
          );
        const widths = sampleRows.reduce<Record<string, number>>((counts, row) => {
          const width = Array.isArray(row) ? row.filter((cell) => String(cell ?? "").trim()).length : 0;
          if (width) counts[String(width)] = (counts[String(width)] ?? 0) + 1;
          return counts;
        }, {});
        return {
          columns_seen: typedSheet.columns_seen,
          delimiter: typedSheet.delimiter,
          name: typedSheet.name,
          parser: typedSheet.parser,
          rows_seen: typedSheet.rows_seen,
          useful_sample: usefulRows,
          width_histogram: widths,
        };
      })
    : [];
  return {
    extension: record.extension,
    filename: record.filename,
    sheets,
    size_bytes: record.size_bytes,
  };
}

function extractionTableSummary(extraction: CodemodeExtraction) {
  return extraction.tables.map((table) => ({
    columns: table.columns.slice(0, 12),
    name: table.name,
    row_count: table.rows.length,
  }));
}



export class SheetsThink extends Think<Env> {
  private chatSchemaReady = false;
  private fileSchemaReady = false;
  private traceSchemaReady = false;
  private turnStartTimes = new Map<string, number>();

  getModel(selectedModel?: ModelEntry) {
    const entries = modelEntriesForRequest(this.env, selectedModel);
    if (entries[0]?.provider.toLowerCase() === "workers-ai") {
      return createWorkersAI({ binding: this.env.AI })(entries[0]?.model ?? "@cf/moonshotai/kimi-k2.7-code");
    }

    return this.getGatewayModel(entries);
  }

  private getGatewayModel(entries: Array<{ model: string; provider: string }>) {
    const gatewayEntries = entries.filter((entry) => entry.provider.toLowerCase() !== "workers-ai");
    if (!gatewayEntries.length) {
      throw new Error("No AI Gateway model configured.");
    }

    const gateway = createAiGateway({
      binding: this.env.AI.gateway(this.env.AI_GATEWAY_ID ?? "default"),
      options: {
        collectLog: true,
        requestTimeoutMs: 120_000,
        retries: {
          backoff: "exponential",
          maxAttempts: 3,
          retryDelayMs: 750,
        },
        skipCache: true,
      },
    });

    return gateway(gatewayEntries.map((entry) => providerModel(entry.provider, entry.model)));
  }

  getSystemPrompt() {
    const spreadsheetId = spreadsheetIdFromAgentName(this.name);
    const fileMode = spreadsheetId ? this.getSpreadsheetFileMode(spreadsheetId) : null;
    const preExtracted = fileMode?.preExtract ?? true;

    return [
      "You are a practical hackathon coding assistant.",
      "You are scoped to one uploaded spreadsheet when your agent name starts with spreadsheet-.",
      "The uploaded spreadsheet is stored on disk in that spreadsheet's Cloudflare Sandbox.",
      preExtracted
        ? "This spreadsheet was pre-extracted into your own Durable Object SQLite database with dynamic tables."
        : "This spreadsheet was uploaded without pre-extraction. Its raw file is available in the sandbox and R2, but the dynamic SQLite database may be empty.",
      preExtracted
        ? "For questions about the data, first call describe_spreadsheet_database, then query_spreadsheet_database. Use execute_python only when SQL is insufficient or the user asks for code/Python."
        : "For questions about the data, use execute_python first to inspect the raw spreadsheet file at SPREADSHEET_PATH. Do not assume pre-extracted SQL tables exist.",
      "For questions about upload history, edits, versions, or revisions, call list_spreadsheet_revisions.",
      "Use robust CSV/TSV parsing: sniff delimiters, prefer pandas.read_csv(..., engine='python', on_bad_lines='skip', encoding='utf-8-sig') when using pandas, and fall back to csv.reader for ragged files. Use pandas/openpyxl for XLSX/XLS when useful. For ODS, avoid pandas/odf in constrained sandboxes and prefer lightweight zip/content.xml parsing. Use pandas.read_xml or lxml/ElementTree for XML.",
      "When citing values, include the source_ref/source_row from the generated database where possible.",
      "Keep answers concise, concrete, and useful.",
      jsonRenderResponseInstructions(),
    ].join("\n");
  }

  getTools() {
    return {
      describe_spreadsheet_database: tool({
        description:
          "Describe the pre-analyzed spreadsheet database, including generated tables, columns, extraction score, and spreadsheet description.",
        inputSchema: z.object({}),
        execute: async () => this.describeAnalysisDatabase(),
      }),
      query_spreadsheet_database: tool({
        description:
          "Run a read-only SQL SELECT/WITH query against this agent's pre-analyzed spreadsheet SQLite tables. Query this before using Python.",
        inputSchema: z.object({
          sql: z.string().min(1).describe("Read-only SQLite SELECT or WITH query."),
        }),
        execute: async ({ sql }) => this.queryAnalysisDatabase(sql),
      }),
      list_spreadsheet_revisions: tool({
        description: "List upload and revision history for this spreadsheet, newest revision first.",
        inputSchema: z.object({}),
        execute: async () => {
          const spreadsheetId = spreadsheetIdFromAgentName(this.name);
          if (!spreadsheetId) throw new Error("This agent is not attached to a spreadsheet.");
          return listSpreadsheetRevisionRows(this.env, spreadsheetId);
        },
      }),
      execute_python: tool({
        description:
          "Execute Python inside this spreadsheet's Cloudflare Sandbox. SPREADSHEET_PATH is available when the agent is attached to a spreadsheet.",
        inputSchema: z.object({
          code: z.string().min(1).describe("Python source code to run."),
        }),
        execute: async ({ code }) => {
          const spreadsheetId = spreadsheetIdFromAgentName(this.name);
          const spreadsheet = spreadsheetId ? await getSpreadsheetRow(this.env, spreadsheetId) : null;
          return runPython(this.env, code, spreadsheet);
        },
      }),
    };
  }

  async onRequest(request: Request) {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/traces")) {
      return json({ traces: this.listTraces(url.searchParams.get("since")) });
    }

    if (url.pathname.endsWith("/extraction-trace")) {
      return json({ traces: this.listExtractionTraces() });
    }

    if (url.pathname.endsWith("/chat-history") && request.method === "GET") {
      return json({ messages: this.listChatMessages() });
    }

    if (url.pathname.endsWith("/chat-history") && request.method === "DELETE") {
      this.clearChatMessages();
      return json({ ok: true });
    }

    if (url.pathname.endsWith("/analysis-tables") && request.method === "GET") {
      return json(this.listAnalysisTables());
    }

    if (url.pathname.endsWith("/analysis-export") && request.method === "GET") {
      return json(this.exportAnalysisDatabase());
    }

    if (url.pathname.endsWith("/analysis-table") && request.method === "GET") {
      const tableName = url.searchParams.get("table");
      if (!tableName) return json({ error: "Missing table query parameter." }, { status: 400 });
      return json(this.getAnalysisTable(tableName));
    }

    if (url.pathname.endsWith("/raw-preview") && request.method === "GET") {
      const spreadsheetId = spreadsheetIdFromAgentName(this.name);
      if (!spreadsheetId) return json({ error: "This agent is not attached to a spreadsheet." }, { status: 400 });
      return json(await this.getRawSpreadsheetPreview(spreadsheetId));
    }

    if (url.pathname.endsWith("/api-request") && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as AgentRequestPayload;
      if (typeof body.message !== "string" || !body.message.trim()) {
        return json({ error: "Send JSON with a non-empty 'message' string." }, { status: 400 });
      }
      let selectedModel: ModelEntry | undefined;
      try {
        selectedModel = requestedModelEntry(this.env, body);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "Invalid model." }, { status: 400 });
      }

      const requestId = crypto.randomUUID();
      const startedAt = Date.now();
      const model = modelConfig(this.env, selectedModel);
      const previousMessages = this.listChatMessages(8);
      this.recordChatMessage("user", body.message, requestId);
      this.recordTrace({
        detail: { message: body.message, model },
        requestId,
        spanType: "api",
        status: "running",
        title: "API request received",
      });

      try {
        const result = await generateText({
          model: this.getModel(selectedModel),
          prompt: this.promptWithChatHistory(previousMessages, body.message),
          stopWhen: stepCountIs(6),
          system: this.getSystemPrompt(),
          temperature: 0.2,
          tools: this.getTools(),
        });
        const generatedText = generatedTextFromResult(result);
        const responseText =
          generatedText ||
          "The agent completed the request but did not return a visible answer. Please retry or ask for a shorter answer.";

        this.recordTrace({
          detail: { emptyResponse: !generatedText, finishReason: result.finishReason, usage: result.usage },
          durationMs: Date.now() - startedAt,
          requestId,
          spanType: "api",
          status: "done",
          title: "API request complete",
        });
        this.recordChatMessage("assistant", responseText, requestId);

        return json({
          agentName: this.name,
          finishReason: result.finishReason,
          model,
          requestId,
          response: responseText,
          usage: result.usage,
        });
      } catch (error) {
        this.recordTrace({
          detail: error instanceof Error ? error.message : String(error),
          durationMs: Date.now() - startedAt,
          requestId,
          spanType: "api",
          status: "error",
          title: "API request failed",
        });

        return json(
          { error: error instanceof Error ? error.message : "Agent request failed.", requestId },
          { status: 500 },
        );
      }
    }

    if (url.pathname.endsWith("/upload-trace") && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as {
        detail?: unknown;
        durationMs?: unknown;
        spanType?: unknown;
        status?: unknown;
        title?: unknown;
      };

      if (
        typeof body.spanType !== "string" ||
        typeof body.title !== "string" ||
        (body.status !== "running" && body.status !== "done" && body.status !== "error")
      ) {
        return new Response("Invalid upload trace payload.", { status: 400 });
      }

      this.recordTrace({
        detail: body.detail,
        durationMs: typeof body.durationMs === "number" ? body.durationMs : undefined,
        spanType: body.spanType,
        status: body.status,
        title: body.title,
      });
      return json({ ok: true });
    }

    if (url.pathname.endsWith("/spreadsheet-file") && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as {
        contentType?: unknown;
        filename?: unknown;
        preExtract?: unknown;
        r2Key?: unknown;
        sandboxPath?: unknown;
        sizeBytes?: unknown;
        spreadsheetId?: unknown;
      };

      if (
        typeof body.spreadsheetId !== "string" ||
        typeof body.filename !== "string" ||
        typeof body.sandboxPath !== "string" ||
        typeof body.r2Key !== "string" ||
        typeof body.contentType !== "string" ||
        typeof body.sizeBytes !== "number"
      ) {
        return new Response("Invalid spreadsheet file payload.", { status: 400 });
      }

      this.storeSpreadsheetFile({
        contentType: body.contentType,
        filename: body.filename,
        preExtract: body.preExtract !== false,
        r2Key: body.r2Key,
        sandboxPath: body.sandboxPath,
        sizeBytes: body.sizeBytes,
        spreadsheetId: body.spreadsheetId,
      });
      return json({ ok: true });
    }

    if (url.pathname.endsWith("/restore-spreadsheet-file") && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as {
        filename?: unknown;
        r2Key?: unknown;
        sandboxPath?: unknown;
        spreadsheetId?: unknown;
      };

      if (
        typeof body.spreadsheetId !== "string" ||
        typeof body.filename !== "string" ||
        typeof body.sandboxPath !== "string"
      ) {
        return new Response("Invalid spreadsheet restore payload.", { status: 400 });
      }

      await this.restoreSpreadsheetFile(body.spreadsheetId, body.filename, body.sandboxPath, body.r2Key);
      return json({ ok: true });
    }

    if (url.pathname.endsWith("/analyze-spreadsheet-file") && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as {
        extractorKind?: unknown;
        filename?: unknown;
        sandboxPath?: unknown;
        spreadsheetId?: unknown;
      };

      if (
        typeof body.spreadsheetId !== "string" ||
        typeof body.filename !== "string" ||
        typeof body.sandboxPath !== "string"
      ) {
        return new Response("Invalid spreadsheet analysis payload.", { status: 400 });
      }

      const startedAt = Date.now();
      this.recordTrace({
        spanType: "ingestion",
        status: "running",
        title: "Pre-analysis started",
      });
      const analysis = await this.analyzeSpreadsheetFile(body.spreadsheetId, body.filename, body.sandboxPath, body.extractorKind);
      this.recordTrace({
        detail: { extractor: analysis.extractor, score: analysis.score, tables: analysis.tables },
        durationMs: Date.now() - startedAt,
        spanType: "ingestion",
        status: "done",
        title: "Pre-analysis complete",
      });
      return json(analysis);
    }

    if (url.pathname.endsWith("/retry-extraction") && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as {
        extractorKind?: unknown;
        filename?: unknown;
        sandboxPath?: unknown;
        spreadsheetId?: unknown;
      };

      if (
        typeof body.spreadsheetId !== "string" ||
        typeof body.filename !== "string" ||
        typeof body.sandboxPath !== "string"
      ) {
        return new Response("Invalid extraction retry payload.", { status: 400 });
      }

      const startedAt = Date.now();
      this.recordTrace({
        detail: { filename: body.filename },
        spanType: "ingestion",
        status: "running",
        title: "Extraction retry started",
      });

      try {
        const analysis = await this.analyzeSpreadsheetFile(body.spreadsheetId, body.filename, body.sandboxPath, body.extractorKind);
        this.recordTrace({
          detail: { extractor: analysis.extractor, score: analysis.score, tables: analysis.tables },
          durationMs: Date.now() - startedAt,
          spanType: "ingestion",
          status: "done",
          title: "Extraction retry complete",
        });
        return json(analysis);
      } catch (error) {
        this.recordTrace({
          detail: error instanceof Error ? error.message : String(error),
          durationMs: Date.now() - startedAt,
          spanType: "ingestion",
          status: "error",
          title: "Extraction retry failed",
        });
        throw error;
      } finally {
        await getSandbox(this.env.Sandbox, `sandbox-${body.spreadsheetId}`).destroy().catch(() => undefined);
      }
    }

    if (url.pathname.endsWith("/delete-spreadsheet") && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as {
        spreadsheetId?: unknown;
      };

      if (typeof body.spreadsheetId !== "string") {
        return new Response("Invalid spreadsheet delete payload.", { status: 400 });
      }

      this.deleteSpreadsheetData(body.spreadsheetId);
      return json({ ok: true });
    }

    return super.onRequest(request);
  }

  beforeTurn(ctx: { body?: unknown; messages?: unknown[]; requestId?: string }) {
    const turnKey = this.turnKey(ctx.requestId);
    this.turnStartTimes.set(turnKey, Date.now());
    this.recordTrace({
      detail: { messageCount: ctx.messages?.length ?? 0 },
      requestId: ctx.requestId,
      spanType: "turn",
      status: "running",
      title: "Agent turn started",
    });
  }

  beforeStep(ctx: { stepNumber?: number }) {
    this.recordTrace({
      spanType: "step",
      status: "running",
      stepNumber: ctx.stepNumber,
      title: `Step ${ctx.stepNumber ?? "?"} started`,
    });
  }

  beforeToolCall(ctx: { input?: unknown; requestId?: string; stepNumber?: number; toolName?: string }) {
    this.recordTrace({
      detail: ctx.input,
      requestId: ctx.requestId,
      spanType: "tool",
      status: "running",
      stepNumber: ctx.stepNumber,
      title: `Tool ${ctx.toolName ?? "call"} started`,
    });
  }

  afterToolCall(ctx: {
    durationMs?: number;
    error?: unknown;
    output?: unknown;
    requestId?: string;
    stepNumber?: number;
    success?: boolean;
    toolName?: string;
  }) {
    this.recordTrace({
      detail: ctx.success ? ctx.output : ctx.error,
      durationMs: ctx.durationMs,
      requestId: ctx.requestId,
      spanType: "tool",
      status: ctx.success ? "done" : "error",
      stepNumber: ctx.stepNumber,
      title: `Tool ${ctx.toolName ?? "call"} ${ctx.success ? "finished" : "failed"}`,
    });
  }

  onStepFinish(ctx: {
    finishReason?: string;
    requestId?: string;
    stepNumber?: number;
    toolCalls?: unknown[];
    usage?: unknown;
  }) {
    this.recordTrace({
      detail: {
        finishReason: ctx.finishReason,
        toolCalls: ctx.toolCalls?.length ?? 0,
        usage: ctx.usage,
      },
      requestId: ctx.requestId,
      spanType: "step",
      status: "done",
      stepNumber: ctx.stepNumber,
      title: `Step ${ctx.stepNumber ?? "?"} finished`,
    });
  }

  onChatResponse(result: { requestId?: string; status?: string }) {
    const durationMs = this.finishTurn(result.requestId);
    this.recordTrace({
      detail: result.status,
      durationMs,
      requestId: result.requestId,
      spanType: "turn",
      status: "done",
      title: "Agent turn complete",
    });
  }

  onChatError(error: unknown, ctx?: { requestId?: string; stage?: string }) {
    const durationMs = this.finishTurn(ctx?.requestId);
    this.recordTrace({
      detail: error instanceof Error ? { message: error.message, stage: ctx?.stage } : { error, stage: ctx?.stage },
      durationMs,
      requestId: ctx?.requestId,
      spanType: "turn",
      status: "error",
      title: "Agent turn failed",
    });

    return error;
  }

  private turnKey(requestId?: string) {
    return requestId ?? "__active_turn__";
  }

  private finishTurn(requestId?: string) {
    const turnKey = this.turnKey(requestId);
    const startedAt = this.turnStartTimes.get(turnKey) ?? this.turnStartTimes.get("__active_turn__");
    if (!startedAt) return;

    this.turnStartTimes.delete(turnKey);
    if (turnKey !== "__active_turn__") this.turnStartTimes.delete("__active_turn__");
    return Date.now() - startedAt;
  }

  private ensureChatSchema() {
    if (this.chatSchemaReady) return;
    this.sql`
      CREATE TABLE IF NOT EXISTS agent_chat_messages (
        id TEXT PRIMARY KEY,
        request_id TEXT,
        role TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      )
    `;
    this.sql`
      CREATE INDEX IF NOT EXISTS idx_agent_chat_messages_created_at
      ON agent_chat_messages (created_at ASC)
    `;
    this.chatSchemaReady = true;
  }

  private listChatMessages(limit = 80): AgentChatMessage[] {
    this.ensureChatSchema();
    return this.sql<AgentChatMessage>`
      SELECT id, role, text, created_at
      FROM (
        SELECT id, role, text, created_at
        FROM agent_chat_messages
        ORDER BY created_at DESC
        LIMIT ${limit}
      )
      ORDER BY created_at ASC
    `;
  }

  private recordChatMessage(role: AgentChatMessage["role"], text: string, requestId: string) {
    this.ensureChatSchema();
    this.sql`
      INSERT INTO agent_chat_messages (id, request_id, role, text)
      VALUES (${crypto.randomUUID()}, ${requestId}, ${role}, ${text})
    `;
  }

  private clearChatMessages() {
    this.ensureChatSchema();
    this.sql`DELETE FROM agent_chat_messages`;
  }

  private promptWithChatHistory(messages: AgentChatMessage[], message: string) {
    if (messages.length === 0) return message;
    const history = messages.map((entry) => `${entry.role.toUpperCase()}: ${entry.text}`).join("\n\n");
    return `Recent conversation:\n${history}\n\nUSER: ${message}`;
  }

  private ensureTraceSchema() {
    if (this.traceSchemaReady) return;

    this.sql`
      CREATE TABLE IF NOT EXISTS agent_traces (
        id TEXT PRIMARY KEY,
        request_id TEXT,
        span_type TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        detail TEXT,
        step_number INTEGER,
        duration_ms INTEGER,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      )
    `;
    this.sql`
      CREATE INDEX IF NOT EXISTS idx_agent_traces_created_at
      ON agent_traces (created_at DESC)
    `;
    this.traceSchemaReady = true;
  }

  private ensureFileSchema() {
    if (this.fileSchemaReady) return;

    this.sql`
      CREATE TABLE IF NOT EXISTS agent_spreadsheet_files (
        spreadsheet_id TEXT PRIMARY KEY,
        filename TEXT NOT NULL,
        content_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        sandbox_path TEXT NOT NULL,
        r2_key TEXT,
        pre_extract INTEGER NOT NULL DEFAULT 1,
        file_base64 TEXT,
        updated_at TEXT NOT NULL
      )
    `;
    try {
      this.ctx.storage.sql.exec("ALTER TABLE agent_spreadsheet_files ADD COLUMN r2_key TEXT");
    } catch (error) {
      if (!(error instanceof Error ? error.message : String(error)).toLowerCase().includes("duplicate column")) {
        throw error;
      }
    }
    try {
      this.ctx.storage.sql.exec("ALTER TABLE agent_spreadsheet_files ADD COLUMN pre_extract INTEGER NOT NULL DEFAULT 1");
    } catch (error) {
      if (!(error instanceof Error ? error.message : String(error)).toLowerCase().includes("duplicate column")) {
        throw error;
      }
    }
    this.sql`
      CREATE TABLE IF NOT EXISTS document_analysis (
        spreadsheet_id TEXT PRIMARY KEY,
        description TEXT NOT NULL,
        deterministic_summary_json TEXT NOT NULL,
        agent_review_json TEXT NOT NULL,
        extraction_score INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      )
    `;
    this.sql`
      CREATE TABLE IF NOT EXISTS document_metadata (
        spreadsheet_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        category TEXT NOT NULL,
        domain TEXT NOT NULL,
        geography TEXT,
        time_period TEXT,
        units TEXT,
        measures_json TEXT NOT NULL,
        dimensions_json TEXT NOT NULL,
        caveats TEXT,
        source_summary TEXT,
        extraction_notes TEXT,
        confidence_score INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      )
    `;
    this.sql`
      CREATE TABLE IF NOT EXISTS document_tables (
        spreadsheet_id TEXT NOT NULL,
        table_name TEXT NOT NULL,
        source_name TEXT NOT NULL,
        columns_json TEXT NOT NULL,
        row_count INTEGER NOT NULL,
        PRIMARY KEY (spreadsheet_id, table_name)
      )
    `;
    this.fileSchemaReady = true;
  }

  private selectCodemodeExtractor(filename: string, profile?: unknown, requested?: unknown): CodemodeExtractorKind {
    if (requested === "xlsx" || requested === "ods" || requested === "other") return requested;
    const input = profile && typeof profile === "object" ? (profile as Record<string, unknown>) : {};
    const extension = typeof input.extension === "string" ? input.extension.toLowerCase() : "";
    const lowerName = filename.toLowerCase();
    if (extension === ".xlsx" || lowerName.endsWith(".xlsx")) return "xlsx";
    if (extension === ".ods" || lowerName.endsWith(".ods")) return "ods";
    return "other";
  }

  private codemodeExtractorProfile(kind: CodemodeExtractorKind): CodemodeExtractorProfile {
    const sharedHelpers = [
      "- cm_read_delimited_rows(path, delimiter=None, max_rows=None): CSV/TSV rows with provenance.",
      "- cm_normalize_value(value) and cm_emit_extraction(payload).",
      "- cm_cell(row, index), cm_row_values(row), cm_source_row(row), and cm_source_ref(row): safe accessors for row dictionaries.",
      "- cm_first_nonempty_index(values), cm_trim_empty_edges(values), cm_table_start_col(row), cm_table_cell(row, index, start_col), and cm_table_region(rows, first_cell=None, contains=None): helpers for sheets with leading blank columns or preamble rows.",
      "- cm_parse_number(value), cm_parse_percent(value), cm_parse_ci_percent(value), cm_missing_status(value), cm_slug(value), and cm_find_row_index(rows, first_cell=None, contains=None).",
      "- cm_detect_header_row(rows), cm_rows_to_records(rows, header_index=None), cm_unpivot_records(records, id_columns, variable_name='measure', value_name='value'), and cm_profile_rows(rows).",
    ];

    if (kind === "xlsx") {
      return {
        codeRules: [
          "- For XLSX files, prefer cm_xlsx_rows_by_sheet(path) for extraction because it ignores workbook styles and avoids pandas/openpyxl stylesheet crashes such as TypeError: Fill() takes no arguments.",
          "- Do not rely on pandas.read_excel or ExcelFile for XLSX. If you use pandas.read_excel, openpyxl, or load_workbook at all, wrap it in try/except and fall back to cm_xlsx_rows_by_sheet(path) when any error mentions styles, stylesheet, Fill, PatternFill, DifferentialStyle, descriptor conversion, or openpyxl.",
          "- Use rows_by_sheet = cm_xlsx_rows_by_sheet(path), then cm_table_region(...), cm_table_cell(...), and small semantic mapping/unpivot loops.",
          "- For XLSX sheets with a title/preamble above data, find the real header row by label, for example first_cell='Date Changed', first_cell='Area', or contains='Indicator'.",
          "- Keep source_row and source_ref from the XML reader; include physical column numbers in source_ref when unpivoting wide columns.",
        ],
        description: "Style-safe XLSX codemode extractor using sheet XML/sharedStrings first, with pandas/openpyxl only as guarded optional fallbacks.",
        helperLines: [
          "- cm_xlsx_rows_by_sheet(path, max_sheets=None, max_rows_per_sheet=None, max_cells_per_row=120): style-free XLSX row extraction from sheet XML/sharedStrings that avoids openpyxl stylesheet parsing.",
          "- cm_iter_xlsx_rows(path, ...): true row-at-a-time XLSX rows with sheet_name, source_row, source_ref, values.",
          ...sharedHelpers,
        ],
        kind,
        plannerRules: [
          "Design for XLSX workbooks that may have broken styles, title rows, preambles, multiple sheets, and sparse columns.",
          "Prefer semantic domain tables over raw workbook mirrors, but preserve any useful source/audit text in notes/metadata tables.",
          "If a sheet is already a clean two-column or date/value table, keep that grain and use typed names.",
        ],
        recipe: [
          "XLSX recipe to follow:",
          "rows_by_sheet = cm_xlsx_rows_by_sheet(path)",
          "rows = rows_by_sheet.get('Sheet name', [])",
          "region = cm_table_region(rows, first_cell='Date Changed')  # or first_cell='Area'/'Indicator' depending on the profile",
          "header = region['header']; start_col = region['start_col']",
          "for row in region['rows']: value = cm_table_cell(row, col, start_col); source_ref = cm_source_ref(row)",
          "finish with cm_emit_extraction(payload)",
        ],
        title: "XLSX extractor",
      };
    }

    if (kind === "ods") {
      return {
        codeRules: [
          "- For ODS files, the script MUST NOT implement XML parsing, zipfile parsing, repeated-cell handling, or generic ODS infrastructure. That is already handled by the helper prelude.",
          "- For ODS files, prefer rows_by_sheet = cm_ods_rows_by_sheet(path). Rows are dictionaries; never write row[0]. Use cm_cell(row, 0), cm_row_values(row), cm_source_row(row), and cm_source_ref(row).",
          "- Never assume physical column 0 is the first table column. Many spreadsheets have leading blank columns. Use cm_find_row_index, cm_table_region, cm_table_start_col, and cm_table_cell so tables with preambles or blank left margins are not extracted as empty Column 1/Column 2 data.",
          "- For ODS files, build small domain loops over known header rows. For wide official-statistics sheets, identify the header row, loop over data rows, parse quarter/measure headers with regex, and unpivot values into observation tables.",
          "- For ODS files, use records = cm_ods_records_by_sheet(path) only when a sheet has one clean header row. Records are dictionaries with record['cells'], record['values'], source_row, and source_ref; never write record[0].",
          "- For ODS files, do not import pandas, numpy, odf, zipfile, xml.etree, or call read_excel.",
          "- For ODS files, generated code should usually be 40-220 lines: constants, small normalization functions, table-specific mapping loops, metadata, cm_emit_extraction(payload).",
        ],
        description: "Low-memory ODS codemode extractor using row-at-a-time content.xml helpers and table-region detection.",
        helperLines: [
          "- cm_ods_rows_by_sheet(path, max_sheets=None, max_rows_per_sheet=None, max_cells_per_row=120): memory-safe ODS row extraction from content.xml.",
          "- cm_iter_ods_rows(path, ...): true row-at-a-time ODS rows with sheet_name, source_row, source_ref, values.",
          "- cm_ods_records_by_sheet(path, ...): ODS sheets converted into records with source_row/source_ref, header detection, row profile, and original rows.",
          ...sharedHelpers,
        ],
        kind,
        plannerRules: [
          "Design for ODS sheets with preambles, repeated cells, leading blank columns, wide official-statistics tables, and validation notes.",
          "For wide quarter/period sheets, require observation-grain tables, not only summary tables.",
          "Use metadata/notes tables to preserve definitions, caveats, validation rules, and source text.",
        ],
        recipe: [
          "ODS recipe to follow:",
          "rows_by_sheet = cm_ods_rows_by_sheet(path)",
          "rows = rows_by_sheet.get('Sheet name', [])",
          "region = cm_table_region(rows, first_cell='Area')  # or first_cell='Indicator' for summary tables",
          "header = region['header']; start_col = region['start_col']",
          "for row in region['rows']: area = cm_table_cell(row, 0, start_col); source_row = cm_source_row(row); source_ref = cm_source_ref(row)",
          "for wide quarter/indicator columns: parse header[col] with regex, read value = cm_table_cell(row, col, start_col), output one observation row per measure with source_ref including physical column number start_col + col + 1",
          "finish with cm_emit_extraction(payload)",
        ],
        title: "ODS extractor",
      };
    }

    return {
      codeRules: [
        "- For CSV/TSV, expect messy real-world files: metadata rows, inconsistent column counts, BOMs, quoted delimiters, blank lines, and semicolon/pipe/tab/comma delimiters.",
        "- For CSV/TSV, sniff the delimiter with csv.Sniffer over a large sample when possible. If using pandas.read_csv, prefer engine='python', dtype=object, keep_default_na=False, encoding='utf-8-sig', and on_bad_lines='skip'.",
        "- If pandas.read_csv raises ParserError or UnicodeDecodeError, fall back to Python csv.reader with encoding='utf-8-sig', errors='replace', preserving row numbers and padding ragged rows instead of failing.",
        "- For XML, parse with ElementTree/lxml into semantic records and preserve tag paths/attributes as provenance.",
        "- Normalize NaN, Infinity, pandas.NA, timestamps, decimals, and numpy values into valid JSON values.",
        "- Print with json.dumps(..., ensure_ascii=False, allow_nan=False).",
      ],
      description: "General codemode extractor for CSV, TSV, XML, legacy XLS, and other supported non-XLSX/ODS formats.",
      helperLines: sharedHelpers,
      kind,
      plannerRules: [
        "Design for messy delimited files, XML documents, or legacy spreadsheet formats.",
        "Identify preamble/metadata rows and separate them from the main data table.",
        "Prefer robust parser fallbacks and preserve raw source row references.",
      ],
      recipe: [
        "Other-format recipe to follow:",
        "For CSV/TSV: rows = cm_read_delimited_rows(path); region = cm_table_region(rows, contains='known header label')",
        "For XML: parse elements into domain tables with source_ref as tag path or element index",
        "For legacy XLS: pandas is allowed when useful, but normalize all values before cm_emit_extraction(payload)",
        "finish with cm_emit_extraction(payload)",
      ],
      title: "Other extractor",
    };
  }

  private async analyzeSpreadsheetFile(spreadsheetId: string, filename: string, sandboxPath: string, requestedExtractor?: unknown) {
    this.ensureFileSchema();
    const restoreStartedAt = Date.now();
    this.recordTrace({
      detail: traceDetail("Restoring the uploaded file from R2 into the sandbox workspace.", sandboxPath),
      spanType: "ingestion",
      status: "running",
      title: "Preparing sandbox file",
    });
    await this.restoreSpreadsheetFile(spreadsheetId, filename, sandboxPath);
    this.recordTrace({
      detail: traceDetail("The spreadsheet is available on disk for Python code to inspect.", sandboxPath),
      durationMs: Date.now() - restoreStartedAt,
      spanType: "ingestion",
      status: "done",
      title: "Sandbox file ready",
    });

    const sandbox = getSandbox(this.env.Sandbox, `sandbox-${spreadsheetId}`);
    const inspectionStartedAt = Date.now();
    this.recordTrace({
      detail: traceDetail("Running a small Python profiler to identify format, sheets, dimensions, delimiter, and sample rows."),
      spanType: "ingestion",
      status: "running",
      title: "Inspecting document shape",
    });
    const profileResult = await sandbox.exec(
      `python3 - <<'PY'\nSPREADSHEET_PATH = ${JSON.stringify(sandboxPath)}\n${CODEMODE_INSPECTION_SCRIPT}\nPY`,
      { timeout: 60_000 },
    );

    if (!profileResult.success) {
      this.recordTrace({
        detail: traceDetail("The document shape inspection failed before extraction code could be generated.", profileResult.stderr),
        durationMs: Date.now() - inspectionStartedAt,
        spanType: "ingestion",
        status: "error",
        title: "Document inspection failed",
      });
      throw new Error(profileResult.stderr || "Codemode spreadsheet inspection failed.");
    }

    const profile = parseJsonText(profileResult.stdout);
    this.recordTrace({
      detail: traceDetail(
        "The document shape was profiled and will guide the generated extraction code.",
        profileSummary(profile),
      ),
      durationMs: Date.now() - inspectionStartedAt,
      spanType: "ingestion",
      status: "done",
      title: "Document shape inspected",
    });
    const extractorKind = this.selectCodemodeExtractor(filename, profile, requestedExtractor);
    const extractor = this.codemodeExtractorProfile(extractorKind);
    this.recordTrace({
      detail: traceDetail("Codemode selected the format-specific extractor that will design and generate the extraction.", {
        extractor: extractor.kind,
        filename,
        profile: profileSummary(profile),
        strategy: extractor.description,
      }),
      spanType: "ingestion",
      status: "done",
      title: `Selected ${extractor.title}`,
    });
    const design = await this.designCodemodeExtraction(filename, profile, extractor);
    let extraction: CodemodeExtraction | undefined;
    let previousProblem: string | undefined;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const code = await this.generateCodemodeExtractionCode(filename, profile, design, extractor, previousProblem);
      const extractionStartedAt = Date.now();
      this.recordTrace({
        detail: traceDetail("Running the generated Python extraction script in the sandbox.", code, { snippetLimit: 60_000 }),
        spanType: "ingestion",
        status: "running",
        title: "Running extraction code",
      });
      const extractionResult = await sandbox.exec(
        `python3 - <<'PY'\nSPREADSHEET_PATH = ${JSON.stringify(sandboxPath)}\n${CODEMODE_RUNTIME_HELPERS}\n${code}\nPY`,
        { timeout: 120_000 },
      );

      if (!extractionResult.success) {
        this.recordTrace({
          detail: traceDetail("The generated extraction code failed while reading the spreadsheet.", extractionResult.stderr),
          durationMs: Date.now() - extractionStartedAt,
          spanType: "ingestion",
          status: "error",
          title: "Extraction code failed",
        });
        previousProblem = extractionResult.stderr || "Codemode spreadsheet extraction failed.";
        if (attempt < 3) continue;
        throw new Error(previousProblem);
      }
      if (extractionResult.stdout.length > 8_000_000) {
        previousProblem = "Extraction output is too large. Generate fewer audit rows or more compact semantic tables.";
        this.recordTrace({
          detail: traceDetail("The generated extraction output was too large for a single JSON import.", {
            bytes: extractionResult.stdout.length,
            limit: 8_000_000,
          }),
          durationMs: Date.now() - extractionStartedAt,
          spanType: "ingestion",
          status: "error",
          title: "Extraction output too large",
        });
        if (attempt < 3) continue;
        throw new Error(previousProblem);
      }

      this.recordTrace({
        detail: traceDetail("The generated extraction code produced JSON for the document database.", {
          bytes: extractionResult.stdout.length,
          preview: extractionResult.stdout.slice(0, 2000),
        }),
        durationMs: Date.now() - extractionStartedAt,
        spanType: "ingestion",
        status: "done",
        title: "Extraction code complete",
      });
      const candidate = normalizeCodemodeExtraction(parseJsonText(extractionResult.stdout), filename);
      const coverageProblem = this.codemodeCoverageProblem(filename, profile, candidate, extractor);
      if (coverageProblem) {
        previousProblem = coverageProblem;
        this.recordTrace({
          detail: traceDetail("The generated extraction was valid JSON but failed local coverage checks, so codemode will retry with this feedback.", {
            problem: coverageProblem,
            tables: extractionTableSummary(candidate),
          }),
          spanType: "ingestion",
          status: "error",
          title: "Extraction coverage incomplete",
        });
        if (attempt < 3) continue;
        throw new Error(coverageProblem);
      }
      extraction = candidate;
      break;
    }

    if (!extraction) throw new Error(previousProblem || "Codemode extraction failed coverage checks.");
    const parseStartedAt = Date.now();
    this.recordTrace({
      detail: traceDetail("Validating and normalizing the generated JSON before writing SQLite tables."),
      spanType: "ingestion",
      status: "running",
      title: "Normalizing extraction output",
    });
    const review = await this.reviewCodemodeExtraction(filename, profile, design, extraction);
    extraction.metadata.confidence_score = review.score;
    extraction.metadata.extraction_notes = [extraction.metadata.extraction_notes, review.notes].filter(Boolean).join("\n\n");
    this.recordTrace({
      detail: traceDetail("The extraction JSON is valid and has been normalized into table definitions.", {
        description: extraction.description,
        metadata: extraction.metadata,
        tables: extractionTableSummary(extraction),
      }),
      durationMs: Date.now() - parseStartedAt,
      spanType: "ingestion",
      status: "done",
      title: "Extraction output normalized",
    });
    const storeStartedAt = Date.now();
    this.recordTrace({
      detail: traceDetail("Creating dynamic SQLite tables inside this agent durable object.", extractionTableSummary(extraction)),
      spanType: "ingestion",
      status: "running",
      title: "Writing SQLite tables",
    });
    this.storeCodemodeExtraction(spreadsheetId, extraction);

    this.sql`
      INSERT INTO document_analysis (
        spreadsheet_id,
        description,
        deterministic_summary_json,
        agent_review_json,
        extraction_score,
        updated_at
      )
      VALUES (
        ${spreadsheetId},
        ${extraction.description},
        ${JSON.stringify(this.extractionSummary(extraction))},
        ${JSON.stringify({ metadata: extraction.metadata, mode: "codemode", profile })},
        ${extraction.metadata.confidence_score},
        ${new Date().toISOString()}
      )
      ON CONFLICT(spreadsheet_id) DO UPDATE SET
        description = excluded.description,
        deterministic_summary_json = excluded.deterministic_summary_json,
        agent_review_json = excluded.agent_review_json,
        extraction_score = excluded.extraction_score,
        updated_at = excluded.updated_at
    `;
    this.recordTrace({
      detail: traceDetail("The agent SQLite database now contains the extracted document data.", {
        description: extraction.description,
        metadata: extraction.metadata,
        tables: extractionTableSummary(extraction),
      }),
      durationMs: Date.now() - storeStartedAt,
      spanType: "ingestion",
      status: "done",
      title: "SQLite tables ready",
    });

    return { description: extraction.description, extractor: extractor.kind, mode: "codemode", score: extraction.metadata.confidence_score, tables: extraction.tables.length };
  }

  private storeCodemodeExtraction(spreadsheetId: string, extraction: CodemodeExtraction) {
    const existingTables = this.sql<{ table_name: string }>`
      SELECT table_name FROM document_tables WHERE spreadsheet_id = ${spreadsheetId}
    `;

    for (const table of existingTables) {
      this.ctx.storage.sql.exec(`DROP TABLE IF EXISTS ${this.quoteIdentifier(table.table_name)}`);
    }

    this.sql`DELETE FROM document_tables WHERE spreadsheet_id = ${spreadsheetId}`;
    this.sql`DELETE FROM document_analysis WHERE spreadsheet_id = ${spreadsheetId}`;
    this.sql`DELETE FROM document_metadata WHERE spreadsheet_id = ${spreadsheetId}`;

    this.sql`
      INSERT INTO document_metadata (
        spreadsheet_id,
        title,
        description,
        category,
        domain,
        geography,
        time_period,
        units,
        measures_json,
        dimensions_json,
        caveats,
        source_summary,
        extraction_notes,
        confidence_score,
        updated_at
      )
      VALUES (
        ${spreadsheetId},
        ${extraction.metadata.title},
        ${extraction.metadata.description},
        ${extraction.metadata.category},
        ${extraction.metadata.domain},
        ${extraction.metadata.geography},
        ${extraction.metadata.time_period},
        ${extraction.metadata.units},
        ${JSON.stringify(extraction.metadata.measures)},
        ${JSON.stringify(extraction.metadata.dimensions)},
        ${extraction.metadata.caveats},
        ${extraction.metadata.source_summary},
        ${extraction.metadata.extraction_notes},
        ${extraction.metadata.confidence_score},
        ${new Date().toISOString()}
      )
    `;

    extraction.tables.forEach((table, tableIndex) => {
      const startedAt = Date.now();
      const tableName = this.safeSqlIdentifier(`doc_${tableIndex + 1}_${table.name}`);
      const uniqueColumns = this.uniqueSqlColumns(table.columns.filter((column) => !["source_row", "source_ref"].includes(column.toLowerCase())));
      const columnDefs = uniqueColumns.map((column) => `${this.quoteIdentifier(column)} TEXT`).join(", ");
      const createSql = [
        `CREATE TABLE ${this.quoteIdentifier(tableName)} (`,
        "source_row INTEGER NOT NULL,",
        "source_ref TEXT NOT NULL",
        columnDefs ? `, ${columnDefs}` : "",
        ")",
      ].join(" ");
      this.ctx.storage.sql.exec(createSql);

      for (const row of table.rows) {
        const values = uniqueColumns.map((column, index) => row.cells[table.columns[index]] ?? null);
        const insertSql = [
          `INSERT INTO ${this.quoteIdentifier(tableName)}`,
          `(${["source_row", "source_ref", ...uniqueColumns].map((column) => this.quoteIdentifier(column)).join(", ")})`,
          `VALUES (${["?", "?", ...uniqueColumns.map(() => "?")].join(", ")})`,
        ].join(" ");
        this.ctx.storage.sql.exec(insertSql, row.source_row, row.source_ref, ...values.map((value) => String(value ?? "")));
      }

      this.sql`
        INSERT INTO document_tables (spreadsheet_id, table_name, source_name, columns_json, row_count)
        VALUES (${spreadsheetId}, ${tableName}, ${table.name}, ${JSON.stringify(uniqueColumns)}, ${table.rows.length})
      `;
      this.recordTrace({
        detail: traceDetail("Imported one generated table into the agent SQLite database.", {
          columns: uniqueColumns.slice(0, 20),
          rowCount: table.rows.length,
          sourceName: table.name,
          tableName,
        }),
        durationMs: Date.now() - startedAt,
        spanType: "ingestion",
        status: "done",
        title: `Imported table ${tableName}`,
      });
    });
  }

  private async designCodemodeExtraction(filename: string, profile: unknown, extractor: CodemodeExtractorProfile) {
    const prompt = [
      "You are codemode's data modeling planner.",
      `You are the ${extractor.title}: ${extractor.description}`,
      "Design a semantic SQLite extraction model for this uploaded document.",
      "Return only JSON, no markdown.",
      "Do not mirror the spreadsheet mechanically unless the document is already a clean domain table.",
      "Prefer proper domain tables with clear grain, useful names, typed columns, and provenance columns.",
      "Every fact/observation table must include source_row and source_ref.",
      "Always include a metadata object with title, description, category, domain, geography, time_period, units, measures, dimensions, caveats, source_summary, extraction_notes, confidence_score.",
      "Format-specific planning rules:",
      extractor.plannerRules.join("\n"),
      "The JSON shape must be:",
      '{"metadata": {"title": string, "description": string, "category": string, "domain": string, "geography": string, "time_period": string, "units": string, "measures": object, "dimensions": object, "caveats": string, "source_summary": string, "extraction_notes": string, "confidence_score": number}, "tables": [{"name": string, "purpose": string, "grain": string, "columns": [{"name": string, "meaning": string}], "source_strategy": string}]}',
      `Filename: ${filename}`,
      "Compact inspection profile:",
      JSON.stringify(compactProfile(profile), null, 2),
    ].join("\n\n");

    const entries = configuredModelEntries(this.env);
    let lastError: unknown;

    for (const entry of entries) {
      const label = `${entry.provider}:${entry.model}`;
      const startedAt = Date.now();
      try {
        this.recordTrace({
          detail: traceDetail(`Asking the ${extractor.title} to design semantic tables and document metadata before code is written.`, {
            extractor: extractor.kind,
            model: label,
            profile: compactProfile(profile),
          }),
          spanType: "ingestion",
          status: "running",
          title: `Designing ${extractor.title} schema`,
        });
        const model =
          entry.provider.toLowerCase() === "workers-ai"
            ? createWorkersAI({ binding: this.env.AI })(entry.model)
            : this.getGatewayModel([entry]);
        const result = await generateText({
          model,
          prompt,
          temperature: 0,
        });
        const design = parseJsonText(result.text);
        this.recordTrace({
          detail: traceDetail("The model proposed domain-specific tables and metadata for the extraction.", design),
          durationMs: Date.now() - startedAt,
          spanType: "ingestion",
          status: "done",
          title: `${extractor.title} schema designed`,
        });
        return design;
      } catch (error) {
        lastError = error;
        this.recordTrace({
          detail: traceDetail(
            "This model failed to design a semantic schema. The fallback chain will continue if another model is configured.",
            error instanceof Error ? { message: error.message, model: label } : { error, model: label },
          ),
          durationMs: Date.now() - startedAt,
          spanType: "ingestion",
          status: "error",
          title: "Semantic schema design failed",
        });
      }
    }

    throw lastError instanceof Error ? lastError : new Error("Failed to design codemode extraction.");
  }

  private codemodeCodeProblem(filename: string, code: string, extractor: CodemodeExtractorProfile) {
    const lowerName = filename.toLowerCase();
    const lowerCode = code.toLowerCase();
    if (extractor.kind === "ods") {
      const forbidden = [
        "import pandas",
        "from pandas",
        "read_excel",
        "engine='odf'",
        'engine="odf"',
        "import numpy",
        "from numpy",
        "import odf",
        "from odf",
        "import zipfile",
        "from zipfile",
        "xml.etree",
        "et.iterparse",
        "content.xml",
        "table-cell",
        "number-columns-repeated",
        "number-rows-repeated",
      ];
      const match = forbidden.find((item) => lowerCode.includes(item));
      if (match) {
        return `ODS extractors must not use pandas/numpy/odf/read_excel or custom zip/XML parsing because they exceed sandbox memory. Found forbidden code: ${match}. Use cm_ods_records_by_sheet, cm_ods_rows_by_sheet, or cm_iter_ods_rows instead.`;
      }
      if (/\b(?:row|rec|record)\s*\[\s*\d+\s*\]/i.test(code)) {
        return "ODS helper rows and records are dictionaries, not lists. Use cm_cell(row, index), cm_row_values(row), record.get('cells', {}), or record.get('values', []) instead of row[0]/record[0].";
      }
    }
    if (extractor.kind === "xlsx") {
      if (/\b(?:row|rec|record)\s*\[\s*\d+\s*\]/i.test(code)) {
        return "XLSX helper rows and records are dictionaries, not lists. Use cm_cell(row, index), cm_row_values(row), record.get('cells', {}), or record.get('values', []) instead of row[0]/record[0].";
      }
      const usesStyleParsingExcelReader =
        lowerCode.includes("openpyxl") ||
        lowerCode.includes("load_workbook") ||
        lowerCode.includes("read_excel") ||
        lowerCode.includes("excelfile") ||
        lowerCode.includes("excel_file");
      const hasStyleSafeFallback = lowerCode.includes("cm_xlsx_rows_by_sheet") || lowerCode.includes("cm_iter_xlsx_rows");
      if (usesStyleParsingExcelReader && !hasStyleSafeFallback) {
        return "XLSX extraction code that uses pandas.read_excel, ExcelFile, openpyxl, or load_workbook must include a fallback to cm_xlsx_rows_by_sheet(path), because those readers can fail on workbook styles with errors like TypeError: Fill() takes no arguments.";
      }
    }
    if (extractor.kind === "other" && (lowerName.endsWith(".csv") || lowerName.endsWith(".tsv"))) {
      if (lowerCode.includes("read_excel") || lowerCode.includes("load_workbook") || lowerCode.includes("openpyxl")) {
        return "Delimited-file extractors must not use Excel readers. Use cm_read_delimited_rows(path) or csv.reader/pandas.read_csv with robust delimiter handling instead.";
      }
    }
    const lineCount = code.split(/\r?\n/).length;
    if (lineCount > 420) {
      return `Generated extraction code is too large (${lineCount} lines). Keep it under 420 lines by composing cm_* helpers instead of writing generic parser infrastructure.`;
    }
    if (code.length > 48_000) {
      return `Generated extraction code is too large (${code.length} chars). Keep it under 48000 chars by composing cm_* helpers.`;
    }
    return null;
  }

  private codemodeExtractionPrompt(filename: string, profile: unknown, design: unknown, extractor: CodemodeExtractorProfile, previousProblem?: string) {
    return [
      "You are in codemode. Generate a complete Python script that reads the uploaded spreadsheet at SPREADSHEET_PATH and prints one JSON object to stdout.",
      `You are the ${extractor.title}: ${extractor.description}`,
      "Do not explain the code. Return only Python code, with no markdown fences.",
      "The variable SPREADSHEET_PATH is already defined as the absolute sandbox path. You must read from SPREADSHEET_PATH, not from the filename and not from the current working directory.",
      "Start by assigning path = pathlib.Path(SPREADSHEET_PATH) or Path(SPREADSHEET_PATH), and use that path variable for every file read.",
      "A trusted helper prelude is already loaded before your script. Reuse these helpers instead of reimplementing generic parsers:",
      extractor.helperLines.join("\n"),
      "The script must implement the semantic extraction design below, not simply mirror spreadsheet columns unless the design explicitly says to.",
      "The script must print this exact JSON shape:",
      '{"description": string, "filename": string, "format": string, "metadata": {"title": string, "description": string, "category": string, "domain": string, "geography": string, "time_period": string, "units": string, "measures": object, "dimensions": object, "caveats": string, "source_summary": string, "extraction_notes": string, "confidence_score": number}, "tables": [{"name": string, "columns": string[], "rows": [{"source_row": number, "source_ref": string, "cells": object}]}]}',
      "Rules:",
      "- Create domain-specific tables with proper names, grain, and columns based on the semantic design.",
      "- Preserve all meaningful spreadsheet/XML/CSV data, either in semantic tables or an audit/source table if needed.",
      "- Include source_row and source_ref for every extracted row so answers can point back to the original document.",
      "- Include a metadata table worth of content in the metadata object: category, domain, measures, dimensions, units, geography, time period, caveats, source summary, and extraction notes.",
      "Format-specific code rules:",
      extractor.codeRules.join("\n"),
      "- Normalize NaN, Infinity, pandas.NA, timestamps, decimals, and numpy values into valid JSON values.",
      "- Print with json.dumps(..., ensure_ascii=False, allow_nan=False).",
      "- Never print Python dict reprs, comments, logs, warnings, or NaN tokens.",
      "- Keep the script under 420 lines. Compose helpers; do not write generic parsing frameworks.",
      extractor.recipe.join("\n"),
      previousProblem ? `Previous generated code was rejected: ${previousProblem}` : "",
      `Filename: ${filename}`,
      "Compact inspection profile:",
      JSON.stringify(compactProfile(profile), null, 2),
      "Semantic extraction design:",
      JSON.stringify(design, null, 2),
    ].filter(Boolean).join("\n\n");
  }

  private async generateCodemodeExtractionCode(
    filename: string,
    profile: unknown,
    design: unknown,
    extractor: CodemodeExtractorProfile,
    initialProblem?: string,
  ) {

    const entries = configuredModelEntries(this.env);
    let lastError: unknown;
    let previousProblem: string | undefined = initialProblem;

    for (const entry of entries) {
      const label = `${entry.provider}:${entry.model}`;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const startedAt = Date.now();
        try {
          this.recordTrace({
            detail: traceDetail(`Asking the configured model to write a lean Python extractor using the ${extractor.title}.`, {
              attempt,
              extractor: extractor.kind,
              model: label,
              profile: compactProfile(profile),
              previousProblem,
            }),
            spanType: "ingestion",
            status: "running",
            title: `Generating ${extractor.title} code`,
          });
          const model =
            entry.provider.toLowerCase() === "workers-ai"
              ? createWorkersAI({ binding: this.env.AI })(entry.model)
              : this.getGatewayModel([entry]);
          const result = await generateText({
            model,
            prompt: this.codemodeExtractionPrompt(filename, profile, design, extractor, previousProblem),
            temperature: 0,
          });
          const code = stripCodeFence(result.text);
          const problem = this.codemodeCodeProblem(filename, code, extractor);
          if (problem) {
            previousProblem = problem;
            lastError = new Error(problem);
          this.recordTrace({
            detail: traceDetail(`The generated ${extractor.title} code was rejected before sandbox execution.`, {
              code,
              extractor: extractor.kind,
              problem,
            }, { snippetLimit: 60_000 }),
            durationMs: Date.now() - startedAt,
            spanType: "ingestion",
            status: "error",
            title: `${extractor.title} code rejected`,
          });
            continue;
          }
          this.recordTrace({
            detail: traceDetail(`The model returned executable ${extractor.title} Python code for the sandbox.`, {
              code,
              extractor: extractor.kind,
              model: label,
            }, { snippetLimit: 60_000 }),
            durationMs: Date.now() - startedAt,
            spanType: "ingestion",
            status: "done",
            title: `${extractor.title} code generated`,
          });
          return code;
        } catch (error) {
          lastError = error;
          this.recordTrace({
            detail: traceDetail(
              "This model failed to generate extraction code. The fallback chain will continue if another model is configured.",
              error instanceof Error ? { message: error.message, model: label } : { error, model: label },
            ),
            durationMs: Date.now() - startedAt,
            spanType: "ingestion",
            status: "error",
            title: "Extraction code generation failed",
          });
        }
      }
    }

    throw lastError instanceof Error ? lastError : new Error("Failed to generate extraction code.");
  }

  private codemodeCoverageProblem(filename: string, profile: unknown, extraction: CodemodeExtraction, extractor: CodemodeExtractorProfile) {
    const lowerName = filename.toLowerCase();
    if (extractor.kind !== "ods" || !lowerName.endsWith(".ods")) return null;

    const input = profile && typeof profile === "object" ? (profile as Record<string, unknown>) : {};
    const sheets = Array.isArray(input.sheets) ? input.sheets : [];
    const wideQuarterSheets = sheets
      .map((sheet) => sheet && typeof sheet === "object" ? (sheet as Record<string, unknown>) : null)
      .filter((sheet): sheet is Record<string, unknown> => {
        const name = String(sheet?.name ?? "");
        const rowsSeen = typeof sheet?.rows_seen === "number" ? sheet.rows_seen : 0;
        const columnsSeen = typeof sheet?.columns_seen === "number" ? sheet.columns_seen : 0;
        return /quarter[_\s-]*\d/i.test(name) && rowsSeen >= 25 && columnsSeen >= 12;
      });
    if (wideQuarterSheets.length < 2) return null;

    const expectedDataRows = wideQuarterSheets.reduce((total, sheet) => {
      const rowsSeen = typeof sheet.rows_seen === "number" ? sheet.rows_seen : 0;
      return total + Math.max(0, rowsSeen - 20);
    }, 0);
    const minimumObservationRows = Math.max(100, Math.floor(expectedDataRows * 3));

    const observationTables = extraction.tables.filter((table) => {
      const columns = table.columns.map((column) => column.toLowerCase());
      const hasQuarter = columns.some((column) => column.includes("quarter") || column.includes("period"));
      const hasGeography = columns.some((column) => column.includes("area") || column.includes("geograph") || column.includes("region") || column.includes("ons"));
      const hasIndicator = columns.some((column) => column.includes("indicator") || column.includes("measure") || column.includes("domain"));
      const hasValue = columns.some((column) => column.includes("percentage") || column.includes("percent") || column.includes("numerator") || column.includes("denominator") || column.includes("count") || column.includes("value"));
      return hasQuarter && hasGeography && hasIndicator && hasValue;
    });
    const observationRows = observationTables.reduce((total, table) => total + table.rows.length, 0);

    if (observationRows < minimumObservationRows) {
      return [
        `Coverage check failed for this ODS: the inspection profile has ${wideQuarterSheets.length} wide quarter sheets and should produce at least ${minimumObservationRows} geography × quarter × indicator observation rows.`,
        `The generated extraction produced only ${observationRows} rows in observation-grain tables.`,
        "Do not stop at the Summary_of_results sheet. Unpivot each Quarter_* sheet after its Area header row.",
        "For each quarter sheet, loop over every geography/area row and every indicator group, preserving ONS code, counts/numerator, denominator/completed count, percentage, confidence interval, validation category, data quality note, source_row, and source_ref.",
      ].join(" ");
    }

    const rowsWithCounts = observationTables.reduce((total, table) => {
      return total + table.rows.filter((row) => {
        const cells = row.cells;
        return Object.entries(cells).some(([key, value]) => {
          const lowerKey = key.toLowerCase();
          return value !== null && value !== "" && (lowerKey.includes("numerator") || lowerKey.includes("denominator") || lowerKey.includes("count") || lowerKey.includes("completed"));
        });
      }).length;
    }, 0);
    if (rowsWithCounts < Math.max(25, Math.floor(minimumObservationRows / 3))) {
      return [
        "Coverage check failed: observation rows exist, but most rows are missing count/numerator/denominator/completed-count values.",
        "The quarter detail sheets contain counts as well as percentages; extract them from the 49-column Quarter_* sheets, not just the Summary_of_results percentage table.",
      ].join(" ");
    }

    return null;
  }

  private async reviewCodemodeExtraction(filename: string, profile: unknown, design: unknown, extraction: CodemodeExtraction) {
    const prompt = [
      "You are codemode's extraction reviewer.",
      "Review whether the generated SQLite extraction is domain-specific, complete, well-metadataed, and source-referenceable.",
      "Return only JSON with keys: score, notes, issues.",
      "score must be an integer from 0 to 100.",
      "Reward semantic tables with clear grain and provenance. Penalize spreadsheet mirroring when better domain tables were possible.",
      `Filename: ${filename}`,
      "Inspection profile:",
      JSON.stringify(compactProfile(profile), null, 2),
      "Semantic design:",
      JSON.stringify(design, null, 2),
      "Extraction summary:",
      JSON.stringify(this.extractionSummary(extraction), null, 2),
    ].join("\n\n");

    const entries = configuredModelEntries(this.env);
    let lastError: unknown;

    for (const entry of entries) {
      const label = `${entry.provider}:${entry.model}`;
      const startedAt = Date.now();
      try {
        this.recordTrace({
          detail: traceDetail("Asking the model to score the semantic extraction and metadata quality.", { model: label }),
          spanType: "ingestion",
          status: "running",
          title: "Reviewing extraction quality",
        });
        const model =
          entry.provider.toLowerCase() === "workers-ai"
            ? createWorkersAI({ binding: this.env.AI })(entry.model)
            : this.getGatewayModel([entry]);
        const result = await generateText({ model, prompt, temperature: 0 });
        const parsed = parseJsonText(result.text) as { issues?: unknown; notes?: unknown; score?: unknown };
        const score = typeof parsed.score === "number" && Number.isFinite(parsed.score) ? Math.max(0, Math.min(100, Math.round(parsed.score))) : extraction.metadata.confidence_score;
        const notes = typeof parsed.notes === "string" ? parsed.notes : JSON.stringify(parsed);
        this.recordTrace({
          detail: traceDetail("The model reviewed the generated domain tables and metadata.", { issues: parsed.issues, notes, score }),
          durationMs: Date.now() - startedAt,
          spanType: "ingestion",
          status: "done",
          title: "Extraction quality reviewed",
        });
        return { notes, score };
      } catch (error) {
        lastError = error;
        this.recordTrace({
          detail: traceDetail(
            "This model failed to review the extraction. The fallback chain will continue if another model is configured.",
            error instanceof Error ? { message: error.message, model: label } : { error, model: label },
          ),
          durationMs: Date.now() - startedAt,
          spanType: "ingestion",
          status: "error",
          title: "Extraction quality review failed",
        });
      }
    }

    return {
      notes: lastError instanceof Error ? `Review failed: ${lastError.message}` : "Review failed.",
      score: extraction.metadata.confidence_score,
    };
  }

  private extractionSummary(extraction: CodemodeExtraction) {
    return {
      description: extraction.description,
      filename: extraction.filename,
      format: extraction.format,
      metadata: extraction.metadata,
      tables: extraction.tables.map((table) => ({
        columns: table.columns,
        name: table.name,
        row_count: table.rows.length,
        sample_rows: table.rows.slice(0, 5),
      })),
    };
  }

  private describeAnalysisDatabase() {
    this.ensureFileSchema();
    const analysis = this.sql`
      SELECT spreadsheet_id, description, extraction_score, agent_review_json, updated_at
      FROM document_analysis
      LIMIT 1
    `;
    const metadata = this.sql`
      SELECT *
      FROM document_metadata
      LIMIT 1
    `;
    const tables = this.sql`
      SELECT table_name, source_name, columns_json, row_count
      FROM document_tables
      ORDER BY table_name
    `;
    return { analysis, metadata, tables };
  }

  private listAnalysisTables() {
    this.ensureFileSchema();
    const analysis = this.sql`
      SELECT spreadsheet_id, description, extraction_score, updated_at
      FROM document_analysis
      LIMIT 1
    `;
    const metadata = this.sql`
      SELECT *
      FROM document_metadata
      LIMIT 1
    `;
    const tables = this.sql<{
      columns_json: string;
      row_count: number;
      source_name: string;
      table_name: string;
    }>`
      SELECT table_name, source_name, columns_json, row_count
      FROM document_tables
      ORDER BY table_name
    `.map((table) => ({
      ...table,
      columns: parseStringArray(table.columns_json),
    }));

    return { analysis: analysis[0] ?? null, metadata: metadata[0] ?? null, tables };
  }

  private getAnalysisTable(tableName: string) {
    this.ensureFileSchema();
    const table = this.sql<{
      columns_json: string;
      row_count: number;
      source_name: string;
      table_name: string;
    }>`
      SELECT table_name, source_name, columns_json, row_count
      FROM document_tables
      WHERE table_name = ${tableName}
      LIMIT 1
    `[0];

    if (!table) return { columns: [], rows: [], table: null };

    const columns = parseStringArray(table.columns_json);
    const rows = [...this.ctx.storage.sql.exec(`SELECT * FROM ${this.quoteIdentifier(tableName)} LIMIT 200`)];
    return {
      columns: ["source_row", "source_ref", ...columns],
      rows,
      table: { ...table, columns },
    };
  }

  private exportAnalysisDatabase() {
    const listed = this.listAnalysisTables();
    return {
      analysis: listed.analysis,
      metadata: listed.metadata,
      tables: listed.tables.map((table) => ({
        columns: ["source_row", "source_ref", ...table.columns],
        rows: [...this.ctx.storage.sql.exec(`SELECT * FROM ${this.quoteIdentifier(table.table_name)}`)],
        sourceName: table.source_name,
        tableName: table.table_name,
      })),
    };
  }

  private queryAnalysisDatabase(sql: string) {
    this.ensureFileSchema();
    const trimmed = sql.trim();
    const normalized = trimmed.toLowerCase();
    if ((!normalized.startsWith("select ") && !normalized.startsWith("with ")) || normalized.includes(";")) {
      throw new Error("Only a single read-only SELECT/WITH query is allowed.");
    }

    return [...this.ctx.storage.sql.exec(trimmed)].slice(0, 200);
  }

  private async getRawSpreadsheetPreview(spreadsheetId: string) {
    this.ensureFileSchema();
    const file = this.sql<{
      content_type: string;
      filename: string;
      r2_key: string | null;
      sandbox_path: string;
      size_bytes: number;
    }>`
      SELECT filename, content_type, size_bytes, sandbox_path, r2_key
      FROM agent_spreadsheet_files
      WHERE spreadsheet_id = ${spreadsheetId}
      LIMIT 1
    `[0];

    if (!file?.r2_key) throw new Error("Raw spreadsheet file is not available in R2.");

    const object = await this.env.SPREADSHEETS.get(file.r2_key);
    if (!object) throw new Error("Raw spreadsheet object was not found in R2.");

    const sandbox = getSandbox(this.env.Sandbox, `preview-${spreadsheetId}`);
    const sandboxPath = `/workspace/previews/${spreadsheetId}/${safeFilename(file.filename)}`;
    try {
      await sandbox.mkdir(`/workspace/previews/${spreadsheetId}`, { recursive: true });
      await sandbox.writeFile(sandboxPath, arrayBufferToBase64(await object.arrayBuffer()), {
        encoding: "base64",
      });
      const result = await sandbox.exec(
        `python3 - <<'PY'\nSPREADSHEET_PATH = ${JSON.stringify(sandboxPath)}\n${RAW_PREVIEW_SCRIPT}\nPY`,
        { timeout: 60_000 },
      );
      if (!result.success) throw new Error(result.stderr || "Raw spreadsheet preview failed.");
      return {
        contentType: file.content_type,
        filename: file.filename,
        preview: parseJsonText(result.stdout),
        sizeBytes: file.size_bytes,
      };
    } finally {
      await sandbox.destroy().catch(() => undefined);
    }
  }

  private safeSqlIdentifier(value: string) {
    const cleaned = value.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48);
    return cleaned && /^[a-z_]/.test(cleaned) ? cleaned : `table_${cleaned || "data"}`;
  }

  private uniqueSqlColumns(columns: string[]) {
    const seen = new Map<string, number>();
    return columns.map((column, index) => {
      const base = this.safeSqlIdentifier(column || `column_${index + 1}`);
      const count = seen.get(base) ?? 0;
      seen.set(base, count + 1);
      return count === 0 ? base : `${base}_${count + 1}`;
    });
  }

  private quoteIdentifier(value: string) {
    return `"${value.replace(/"/g, '""')}"`;
  }

  private storeSpreadsheetFile(input: {
    contentType: string;
    filename: string;
    preExtract: boolean;
    r2Key: string;
    sandboxPath: string;
    sizeBytes: number;
    spreadsheetId: string;
  }) {
    this.ensureFileSchema();
    this.sql`
      INSERT INTO agent_spreadsheet_files (
        spreadsheet_id,
        filename,
        content_type,
        size_bytes,
        sandbox_path,
        r2_key,
        pre_extract,
        updated_at
      )
      VALUES (
        ${input.spreadsheetId},
        ${input.filename},
        ${input.contentType},
        ${input.sizeBytes},
        ${input.sandboxPath},
        ${input.r2Key},
        ${input.preExtract ? 1 : 0},
        ${new Date().toISOString()}
      )
      ON CONFLICT(spreadsheet_id) DO UPDATE SET
        filename = excluded.filename,
        content_type = excluded.content_type,
        size_bytes = excluded.size_bytes,
        sandbox_path = excluded.sandbox_path,
        r2_key = excluded.r2_key,
        pre_extract = excluded.pre_extract,
        updated_at = excluded.updated_at
    `;
  }

  private getSpreadsheetFileMode(spreadsheetId: string) {
    this.ensureFileSchema();
    const rows = this.sql<{ pre_extract: number | null }>`
      SELECT pre_extract
      FROM agent_spreadsheet_files
      WHERE spreadsheet_id = ${spreadsheetId}
      LIMIT 1
    `;
    if (!rows[0]) return null;
    return { preExtract: rows[0].pre_extract !== 0 };
  }

  private async restoreSpreadsheetFile(spreadsheetId: string, filename: string, sandboxPath: string, r2Key?: unknown) {
    this.ensureFileSchema();
    const rows = this.sql<{
      file_base64: string | null;
      r2_key: string | null;
    }>`
      SELECT file_base64, r2_key
      FROM agent_spreadsheet_files
      WHERE spreadsheet_id = ${spreadsheetId}
      LIMIT 1
    `;

    const key = typeof r2Key === "string" ? r2Key : rows[0]?.r2_key;
    const object = key ? await this.env.SPREADSHEETS.get(key) : null;
    let fileBase64 = rows[0]?.file_base64 ?? null;

    if (object) {
      fileBase64 = arrayBufferToBase64(await object.arrayBuffer());
    }

    if (!fileBase64) {
      throw new Error(
        [
          `The sandbox file for ${filename} is missing and no R2 object was available to restore it.`,
          "Re-upload the spreadsheet to seed R2 storage.",
        ].join(" "),
      );
    }

    const sandbox = getSandbox(this.env.Sandbox, `sandbox-${spreadsheetId}`);
    const directory = sandboxPath.slice(0, sandboxPath.lastIndexOf("/"));
    await sandbox.mkdir(directory, { recursive: true });
    await sandbox.writeFile(sandboxPath, fileBase64, {
      encoding: "base64",
    });
  }

  private deleteSpreadsheetData(spreadsheetId: string) {
    this.ensureFileSchema();
    this.ensureTraceSchema();
    const tables = this.sql<{ table_name: string }>`
      SELECT table_name FROM document_tables WHERE spreadsheet_id = ${spreadsheetId}
    `;

    for (const table of tables) {
      this.ctx.storage.sql.exec(`DROP TABLE IF EXISTS ${this.quoteIdentifier(table.table_name)}`);
    }

    this.sql`DELETE FROM document_tables WHERE spreadsheet_id = ${spreadsheetId}`;
    this.sql`DELETE FROM document_analysis WHERE spreadsheet_id = ${spreadsheetId}`;
    this.sql`DELETE FROM agent_spreadsheet_files WHERE spreadsheet_id = ${spreadsheetId}`;
    this.sql`DELETE FROM agent_traces`;
    this.clearChatMessages();
  }

  private listTraces(since?: string | null) {
    this.ensureTraceSchema();
    if (since) {
      return this.sql`
        SELECT id, request_id, span_type, title, status, detail, step_number, duration_ms, created_at
        FROM agent_traces
        WHERE created_at >= ${since}
        ORDER BY created_at ASC
        LIMIT 80
      `;
    }

    return this.sql`
      SELECT id, request_id, span_type, title, status, detail, step_number, duration_ms, created_at
      FROM agent_traces
      ORDER BY created_at DESC
      LIMIT 30
    `.reverse();
  }

  private listExtractionTraces() {
    this.ensureTraceSchema();
    return this.sql`
      SELECT id, request_id, span_type, title, status, detail, step_number, duration_ms, created_at
      FROM agent_traces
      WHERE span_type IN ('upload', 'ingestion')
      ORDER BY created_at ASC
    `;
  }

  private recordTrace(input: TraceInput) {
    this.ensureTraceSchema();
    const trace: AgentTraceEvent = {
      id: crypto.randomUUID(),
      request_id: input.requestId ?? null,
      span_type: input.spanType,
      title: input.title,
      status: input.status,
      detail: safeTraceDetail(input.detail),
      step_number: input.stepNumber ?? null,
      duration_ms: input.durationMs ?? null,
      created_at: new Date().toISOString(),
    };

    this.sql`
      INSERT INTO agent_traces (
        id,
        request_id,
        span_type,
        title,
        status,
        detail,
        step_number,
        duration_ms,
        created_at
      )
      VALUES (
        ${trace.id},
        ${trace.request_id},
        ${trace.span_type},
        ${trace.title},
        ${trace.status},
        ${trace.detail},
        ${trace.step_number},
        ${trace.duration_ms},
        ${trace.created_at}
      )
    `;
    this.broadcast(JSON.stringify({ trace, type: "agent_trace" }));
  }
}
