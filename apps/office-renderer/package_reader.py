"""Bounded OOXML inspection; never extracts package paths to the filesystem."""
import io
import posixpath
import re
import zipfile
from xml.etree import ElementTree as ET

S = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
P = "http://schemas.openxmlformats.org/package/2006/relationships"
MAIN = {"docx": "word/document.xml", "xlsx": "xl/workbook.xml", "pptx": "ppt/presentation.xml"}


def xml(data):
    if len(data) > 8 * 1024 * 1024 or re.search(br"<!DOCTYPE|<!ENTITY", data, re.I):
        raise ValueError("unsupported_xml")
    return ET.fromstring(data)


class Package:
    def __init__(self, data, kind):
        if kind not in MAIN or len(data) > 8_000_000:
            raise ValueError("unsupported_file")
        self.zip = zipfile.ZipFile(io.BytesIO(data))
        infos = self.zip.infolist()
        names = [i.filename for i in infos]
        if (len(infos) > 4096 or len(set(names)) != len(names)
                or sum(i.file_size for i in infos) > 64 * 1024 * 1024
                or MAIN[kind] not in names):
            raise ValueError("unsupported_package")
        for entry in infos:
            name = entry.filename
            if (entry.file_size > 8 * 1024 * 1024 or entry.flag_bits & 1
                    or entry.compress_type not in (0, 8) or "\\" in name
                    or name.startswith("/") or any(p in ("..", ".") for p in name.split("/"))):
                raise ValueError("unsupported_member")
            if re.search(r"vbaProject|_xmlsignatures/|/embeddings/.*\.(?:bin|docm|xlsm)|activeX/", name, re.I):
                raise ValueError("active_content")
            if name.endswith((".xml", ".rels")):
                root = xml(self.zip.read(entry))
                if name.endswith(".rels"):
                    for rel in root:
                        if rel.get("TargetMode") == "External" and not rel.get("Type", "").endswith("/hyperlink"):
                            raise ValueError("external_content")
                if "externalLink" in name or "connections.xml" in name:
                    raise ValueError("external_content")
        self.kind = kind

    def sheets(self):
        relationships = xml(self.zip.read("xl/_rels/workbook.xml.rels"))
        targets = {}
        for rel in relationships:
            if rel.get("TargetMode") != "External":
                raw = rel.get("Target", "")
                targets[rel.get("Id")] = raw.lstrip("/") if raw.startswith("/") else posixpath.normpath("xl/" + raw)
        return [(s.get("name"), targets[s.get("{" + R + "}id")])
                for s in xml(self.zip.read(MAIN["xlsx"])).findall(".//{" + S + "}sheet")]

    def formula_cells(self):
        result = []
        for sheet, path in self.sheets():
            for cell in xml(self.zip.read(path)).iter("{" + S + "}c"):
                formula = cell.find("{" + S + "}f")
                if formula is None:
                    continue
                # Array formulas also produce values in cells without <f>; do not
                # claim complete recalculation until those spill ranges are covered.
                if formula.get("t", "normal") not in ("normal", "shared"):
                    raise ValueError("unsupported_formula_range")
                result.append((sheet, cell.get("r"), formula.text or ""))
                if len(result) > 10_000:
                    raise ValueError("too_many_formulas")
        return result

    def values(self):
        shared = []
        if "xl/sharedStrings.xml" in self.zip.namelist():
            shared = ["".join(n.itertext()) for n in xml(self.zip.read("xl/sharedStrings.xml"))]
        result = {}
        for sheet, path in self.sheets():
            for cell in xml(self.zip.read(path)).iter("{" + S + "}c"):
                value = cell.find("{" + S + "}v")
                typ = cell.get("t", "n")
                raw = value.text if value is not None and value.text is not None else ""
                if typ == "s":
                    raw, typ = shared[int(raw)], "str"
                elif typ == "inlineStr":
                    raw, typ = "".join(cell.find("{" + S + "}is").itertext()), "str"
                result[(sheet, cell.get("r"))] = (typ, raw)
        return result
