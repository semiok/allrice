"""One disposable conversion process. Explicit UNO policy, no IP sockets.

The parent supplies only a fixed temporary directory and a validated format.
No document text is ever interpolated into a command or filename.
"""
import base64
import ctypes
import errno
import hashlib
import json
import math
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import time

from package_reader import Package


def deny_network():
    # Inherited by soffice/poppler. UNO uses a local pipe, not a TCP listener.
    # This also blocks formulas/resources from reaching Web/Worker on the
    # otherwise private service network, even if an import filter ignores flags.
    lib = ctypes.CDLL("libseccomp.so.2", use_errno=True)
    lib.seccomp_init.argtypes = [ctypes.c_uint32]
    lib.seccomp_init.restype = ctypes.c_void_p
    lib.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
    lib.seccomp_rule_add_array.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int, ctypes.c_uint, ctypes.c_void_p]
    lib.seccomp_load.argtypes = [ctypes.c_void_p]
    lib.seccomp_release.argtypes = [ctypes.c_void_p]

    class Comparison(ctypes.Structure):
        _fields_ = [("arg", ctypes.c_uint), ("op", ctypes.c_int), ("a", ctypes.c_uint64), ("b", ctypes.c_uint64)]

    context = lib.seccomp_init(0x7FFF0000)  # SCMP_ACT_ALLOW
    if not context:
        raise RuntimeError("seccomp_unavailable")
    try:
        for domain in (socket.AF_INET, socket.AF_INET6):
            cmp = Comparison(0, 4, domain, 0)  # SCMP_CMP_EQ
            if lib.seccomp_rule_add_array(context, 0x50000 | errno.EPERM,
                                          lib.seccomp_syscall_resolve_name(b"socket"), 1, ctypes.byref(cmp)) != 0:
                raise RuntimeError("seccomp_rule_failed")
        if lib.seccomp_load(context) != 0:
            raise RuntimeError("seccomp_load_failed")
    finally:
        lib.seccomp_release(context)


def convert(folder, kind):
    deny_network()
    import uno
    from com.sun.star.beans import PropertyValue

    def props(**values):
        return tuple(PropertyValue(Name=k, Value=v) for k, v in values.items())

    source = folder / ("input." + kind)
    original = source.read_bytes()
    package = Package(original, kind)
    formulas = package.formula_cells() if kind == "xlsx" else []
    pipe = "office_" + folder.name.replace("-", "_")
    proc = subprocess.Popen([
        "soffice", "-env:UserInstallation=" + (folder / "profile").as_uri(),
        "--headless", "--nologo", "--nodefault", "--norestore", "--nofirststartwizard",
        "--accept=pipe,name=" + pipe + ";urp;StarOffice.ComponentContext",
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    document = None
    try:
        local = uno.getComponentContext()
        resolver = local.ServiceManager.createInstanceWithContext("com.sun.star.bridge.UnoUrlResolver", local)
        context = None
        for _ in range(100):
            try:
                context = resolver.resolve("uno:pipe,name=" + pipe + ";urp;StarOffice.ComponentContext")
                break
            except Exception:
                if proc.poll() is not None:
                    raise ValueError("renderer_start_failed")
                time.sleep(0.1)
        if context is None:
            raise ValueError("renderer_start_timeout")
        desktop = context.ServiceManager.createInstanceWithContext("com.sun.star.frame.Desktop", context)
        document = desktop.loadComponentFromURL(source.as_uri(), "_blank", 0,
            props(Hidden=True, ReadOnly=True, MacroExecutionMode=0, UpdateDocMode=0))
        if document is None:
            raise ValueError("document_load_failed")
        results = []
        if kind == "xlsx":
            document.calculateAll()
            recalculated = folder / "calculated.xlsx"
            document.storeToURL(recalculated.as_uri(), props(FilterName="Calc MS Excel 2007 XML", Overwrite=True))
            values = Package(recalculated.read_bytes(), "xlsx").values()
            for sheet, cell, formula in formulas:
                typ, raw = values.get((sheet, cell), ("", ""))
                if typ not in ("n", "b", "str", "e") or (typ in ("n", "b") and not raw):
                    raise ValueError("formula_result_missing")
                if typ == "n":
                    value = float(raw)
                    if not math.isfinite(value):
                        raise ValueError("formula_result_nonfinite")
                elif typ == "b":
                    value = raw == "1"
                else:
                    value = raw
                if len(str(value)) > 20_000:
                    raise ValueError("formula_result_too_large")
                results.append({"sheet": sheet, "cell": cell, "formula": formula, "type": typ, "value": value})
        filters = {"docx": "writer_pdf_Export", "xlsx": "calc_pdf_Export", "pptx": "impress_pdf_Export"}
        pdf = folder / "preview.pdf"
        document.storeToURL(pdf.as_uri(), props(FilterName=filters[kind], Overwrite=True))
        if pdf.stat().st_size > 32 * 1024 * 1024:
            raise ValueError("preview_too_large")
        info = subprocess.check_output(["pdfinfo", str(pdf)], timeout=5, env={**os.environ, "LC_ALL": "C"}).decode()
        match = re.search(r"^Pages:\s+(\d+)", info, re.M)
        count = int(match[1]) if match else 0
        if not count:
            raise ValueError("preview_has_no_pages")
        subprocess.run(["pdftoppm", "-f", "1", "-l", str(min(count, 8)), "-scale-to", "1200", "-png", str(pdf), str(folder / "page")],
                       check=True, timeout=15, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        pages = []
        total = 0
        for path in sorted(folder.glob("page-*.png"), key=lambda p: int(p.stem.split("-")[-1])):
            content = path.read_bytes()
            total += len(content)
            if total > 3_000_000:
                break
            pages.append({"number": int(path.stem.split("-")[-1]), "base64": base64.b64encode(content).decode()})
        if not pages:
            raise ValueError("preview_too_large")
        result = {
            "checksum": "sha256:" + hashlib.sha256(original).hexdigest(),
            "format": kind,
            "engine": subprocess.check_output(["soffice", "--version"], timeout=3).decode().strip()[:120],
            "pageCount": count, "pages": pages, "formulas": results,
        }
        encoded = json.dumps(result, ensure_ascii=False, separators=(",", ":")).encode()
        if len(encoded) > 8_000_000:
            raise ValueError("result_too_large")
        (folder / "result.json").write_bytes(encoded)
    finally:
        if document is not None:
            try:
                document.close(True)
            except Exception:
                pass
        proc.terminate()
        try:
            proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()


if __name__ == "__main__":
    try:
        convert(Path(sys.argv[1]), sys.argv[2])
    except Exception as error:
        # Never return document text, paths, subprocess output or credentials.
        allowed = {"unsupported_formula_range", "too_many_formulas", "external_content", "active_content"}
        code = str(error) if str(error) in allowed else "conversion_failed"
        (Path(sys.argv[1]) / "error.json").write_text(json.dumps({"code": code}))
        sys.exit(1)
