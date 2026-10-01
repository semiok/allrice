"""Trusted image-only PNG check. Invoke with isolated Python and captured stdin.

This checker never imports tenant code, opens a tenant-selected path, or returns
image contents. Pillow owns parsing, CRC checks and raster decompression.
"""
import hashlib
import io
import json
import sys
import warnings

from PIL import Image, ImageFile, PngImagePlugin

MAX_BYTES = 4_000_000
MAX_PIXELS = 16_000_000
MAX_DIMENSION = 8192
Image.MAX_IMAGE_PIXELS = MAX_PIXELS
ImageFile.LOAD_TRUNCATED_IMAGES = False
PngImagePlugin.MAX_TEXT_CHUNK = 128_000
PngImagePlugin.MAX_TEXT_MEMORY = 1_000_000


def check_png(raw):
    if not raw or len(raw) > MAX_BYTES:
        raise ValueError("png_size")
    with warnings.catch_warnings():
        warnings.simplefilter("error")
        with Image.open(io.BytesIO(raw)) as image:
            width, height = image.size
            if (image.format != "PNG" or getattr(image, "is_animated", False)
                    or width < 1 or height < 1
                    or width > MAX_DIMENSION or height > MAX_DIMENSION
                    or width * height > MAX_PIXELS):
                raise ValueError("png_dimensions")
            image.verify()
        # verify checks the package; load must also decode its complete raster.
        with Image.open(io.BytesIO(raw)) as image:
            image.load()
    return {"checker": "pillow-11.3.0", "width": width, "height": height,
            "checksum": "sha256:" + hashlib.sha256(raw).hexdigest()}


if __name__ == "__main__":
    try:
        result = check_png(sys.stdin.buffer.read(MAX_BYTES + 1))
    except Exception:
        print(json.dumps({"error": "png_invalid"}))
        sys.exit(1)
    print(json.dumps(result, separators=(",", ":")))
