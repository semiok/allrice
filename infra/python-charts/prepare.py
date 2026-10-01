"""Image-build proof and immutable font-cache seed, never a tenant installer."""
import hashlib
import importlib.metadata
import io
import json
from pathlib import Path
import platform
import warnings

import matplotlib
from matplotlib import font_manager, ft2font
import matplotlib.pyplot as plt

assert platform.python_version() == "3.11.13"
assert matplotlib.get_backend().lower() == "agg"
font = Path(font_manager.findfont("Noto Sans CJK JP", fallback_to_default=False))
face = ft2font.FT2Font(str(font))
assert all(face.get_char_index(ord(ch)) for ch in "中文图表收入费用科研项目单位元−")
with warnings.catch_warnings():
    warnings.simplefilter("error")
    figure, axes = plt.subplots()
    axes.bar(["办公费用", "较长中文分类名称"], [10, -25])
    axes.set_title("中文图表验证")
    axes.set_ylabel("金额（元）")
    figure.savefig(io.BytesIO(), format="png")
    plt.close(figure)
packages = ["matplotlib", "numpy", "pandas", "openpyxl", "pillow", "contourpy",
            "cycler", "fonttools", "kiwisolver", "packaging", "pyparsing",
            "python-dateutil", "pytz", "tzdata", "six", "et-xmlfile"]
proof = {"python": platform.python_version(), "backend": "Agg",
         "packages": {name: importlib.metadata.version(name) for name in packages},
         "font": {"family": "Noto Sans CJK JP", "path": str(font),
                  "checksum": "sha256:" + hashlib.sha256(font.read_bytes()).hexdigest()}}
Path("/opt/allrice-python/runtime.json").write_text(json.dumps(proof, indent=2) + "\n")
