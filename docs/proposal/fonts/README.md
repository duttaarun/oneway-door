# Fonts

**Stand-ins (open licence, used by default).** Source Serif 4 and Source Sans 3 (Adobe) and JetBrains Mono, all under the
SIL Open Font License 1.1, downloaded from Google Fonts (latin subset). `build.py` inlines them, because Chrome won't
load fonts over `file://`.

**Brand fonts (optional).** The theme follows the Lloyds Banking Group website, whose typeface is GT Ultra (Grilli Type).
It is a commercial font, so it is not included here. If you have a licensed copy (for example, from your brand team),
put these files in `fonts/licensed/` and run the build again. The PDF will then use them instead of the stand-ins:

    GT-Ultra-Median-Regular.woff2   GT-Ultra-Median-Bold.woff2
    GT-Ultra-Standard-Regular.woff2 GT-Ultra-Standard-Bold.woff2

(`.woff`, `.otf` and `.ttf` work too, with the same base names.)
