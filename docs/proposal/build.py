#!/usr/bin/env python3
"""Builds docs/One-Way-Door-proposal.pdf from proposal.html.

Chrome won't load fonts over file://, so the local woff2 files are inlined as data URIs
into a temporary copy, which headless Chrome then prints to an A4 PDF.

Usage: python3 docs/proposal/build.py
"""
import base64
import pathlib
import re
import subprocess
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
OUT = HERE.parent / "One-Way-Door-proposal.pdf"
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"


def inline_fonts(css: str) -> str:
    def repl(m):
        data = base64.b64encode((HERE / m.group(1)).read_bytes()).decode()
        return f"url(data:font/woff2;base64,{data})"
    return re.sub(r"url\((fonts/[^)]+\.woff2)\)", repl, css)


LICENSED = {  # base file name -> (family the stylesheet asks for, weight)
    "GT-Ultra-Median-Regular": ("GT Ultra Median", 400),
    "GT-Ultra-Median-Bold": ("GT Ultra Median", 700),
    "GT-Ultra-Standard-Regular": ("GT Ultra Standard", 400),
    "GT-Ultra-Standard-Bold": ("GT Ultra Standard", 700),
}
FORMATS = {".woff2": ("font/woff2", "woff2"), ".woff": ("font/woff", "woff"), ".otf": ("font/otf", "opentype"), ".ttf": ("font/ttf", "truetype")}


def licensed_fonts() -> str:
    """@font-face rules for licensed brand fonts dropped into fonts/licensed/ (none by default)."""
    rules = []
    for base, (family, weight) in LICENSED.items():
        for ext, (mime, fmt) in FORMATS.items():
            f = HERE / "fonts" / "licensed" / f"{base}{ext}"
            if f.exists():
                data = base64.b64encode(f.read_bytes()).decode()
                rules.append(f"@font-face {{ font-family: '{family}'; font-weight: {weight}; "
                             f"src: url(data:{mime};base64,{data}) format('{fmt}'); }}")
                break
    # A face given only 400 and 700 also serves 600 and 800 requests via the nearest weight.
    return "\n".join(rules)


def main() -> int:
    html = (HERE / "proposal.html").read_text()
    brand = licensed_fonts()
    print("brand fonts:", f"{brand.count('@font-face')} licensed GT Ultra faces" if brand else "none (using open stand-ins)")
    css = brand + "\n" + inline_fonts((HERE / "fonts" / "fonts.css").read_text())
    html = html.replace('<link href="fonts/fonts.css" rel="stylesheet">', f"<style>\n{css}</style>")
    with tempfile.TemporaryDirectory() as tmp:
        page = pathlib.Path(tmp) / "proposal.html"
        page.write_text(html)
        common = [CHROME, "--headless=new", "--disable-gpu", "--virtual-time-budget=15000",
                  "--run-all-compositor-stages-before-draw"]
        dom = subprocess.run(common + ["--window-size=794,1123", "--dump-dom", page.as_uri()],
                             capture_output=True, text=True).stdout
        overflow = re.search(r'data-overflow="([^"]*)"', dom)
        print("overflow check:", overflow.group(1) if overflow else "not run")
        subprocess.run(common + ["--no-pdf-header-footer", f"--print-to-pdf={OUT}", page.as_uri()],
                       capture_output=True, check=True)
    print("wrote", OUT)
    return 0 if overflow and overflow.group(1) == "none" else 1


if __name__ == "__main__":
    sys.exit(main())
