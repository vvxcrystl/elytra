"""Regenerate the Unicode 16 Latin-target TR39 subset using Python standard library.

No downloads are used by the app. The Unicode license is retained in licenses/.
"""
import json
from pathlib import Path
import re
import unicodedata
import urllib.request

VERSION = "16.0.0"
FOLD_URL = f"https://www.unicode.org/Public/{VERSION}/ucd/CaseFolding.txt"
CONFUSABLE_URL = f"https://www.unicode.org/Public/security/{VERSION}/confusables.txt"
folds, skeleton = {}, {}
for line in urllib.request.urlopen(FOLD_URL).read().decode().splitlines():
    value = line.split("#")[0].strip()
    if not value:
        continue
    source, status, target, *_ = value.split(";")
    key = chr(int(source, 16))
    target = "".join(chr(int(c, 16)) for c in target.split())
    if status.strip() in ("C", "F") and key.lower() != target:
        folds[key] = target
for line in urllib.request.urlopen(CONFUSABLE_URL).read().decode().splitlines():
    value = line.split("#")[0].strip()
    if not value:
        continue
    source, target, *_ = value.split(";")
    key = "".join(chr(int(c, 16)) for c in source.split())
    target = "".join(chr(int(c, 16)) for c in target.split())
    target = "".join(c for c in unicodedata.normalize("NFD", target.casefold()) if not unicodedata.category(c).startswith("M"))
    surviving = "".join(c for c in unicodedata.normalize("NFD", unicodedata.normalize("NFKC", key).casefold()) if not unicodedata.category(c).startswith("M"))
    if surviving == key and re.fullmatch("[a-z]+", target) and key != target:
        skeleton[key] = target
header = ("// Unicode 16.0.0 data subset. Generated from CaseFolding.txt and UTS #39 confusables.txt.\n"
          f"// Sources: {FOLD_URL}\n// {CONFUSABLE_URL}\n"
          "// See licenses/Unicode-LICENSE.txt. Only surviving Latin-target skeletons and non-lowercase case folds.\n")
output = header + "export const CASE_FOLDS: Record<string, string> = " + json.dumps(folds, ensure_ascii=True, separators=(",", ":")) + ";\n"
output += "export const LATIN_SKELETON: Record<string, string> = " + json.dumps(skeleton, ensure_ascii=True, separators=(",", ":")) + ";\n"
Path("src/server/moderation/unicode-data.ts").write_text(output)
print(f"Unicode {VERSION}: {len(folds)} case-fold overrides, {len(skeleton)} Latin-target confusables. Retrain weights after changing these files.")
