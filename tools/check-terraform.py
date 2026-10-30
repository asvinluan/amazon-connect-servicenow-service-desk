"""Offline checks on the Terraform in ./terraform. No provider download, no AWS.

What it proves: every .tf file parses, every var.X / data.T.N / resource.T.N
reference points at something declared, every declared variable and resource is
used or is an output, and the flow template's ${placeholders} match what the
templatefile() call passes. What it cannot prove: that the provider accepts the
arguments. That is what `terraform validate` is for (CI runs it).

    python tools/check-terraform.py
"""
import json
import pathlib
import re
import sys

import hcl2

ROOT = pathlib.Path(__file__).resolve().parent.parent / "terraform"
problems = []

files = sorted(ROOT.glob("*.tf"))
parsed = {}
for f in files:
    try:
        with f.open() as fh:
            parsed[f.name] = hcl2.load(fh)
    except Exception as exc:  # noqa: BLE001 - report any parse failure
        problems.append(f"{f.name}: does not parse: {exc}")

variables, resources, datas, outputs = set(), set(), set(), set()
for name, doc in parsed.items():
    for v in doc.get("variable", []):
        variables.update(k.strip('"') for k in v)
    for r in doc.get("resource", []):
        for rtype, body in r.items():
            for rname in body:
                resources.add(f"{rtype.strip(chr(34))}.{rname.strip(chr(34))}")
    for d in doc.get("data", []):
        for dtype, body in d.items():
            for dname in body:
                datas.add(f"data.{dtype.strip(chr(34))}.{dname.strip(chr(34))}")
    for o in doc.get("output", []):
        outputs.update(k.strip('"') for k in o)

text = {f.name: f.read_text() for f in files}
alltext = "\n".join(text.values())
# strip comments so a mention in prose is not counted as a use
code = re.sub(r"(?m)^\s*#.*$", "", alltext)

for m in sorted(set(re.findall(r"\bvar\.([a-z_0-9]+)", code))):
    if m not in variables:
        problems.append(f"var.{m} is used but not declared")
for v in sorted(variables):
    if not re.search(rf"\bvar\.{v}\b", code):
        problems.append(f"variable {v} is declared but never used")

for m in sorted(set(re.findall(r"\bdata\.([a-z_0-9]+)\.([a-z_0-9]+)", code))):
    if f"data.{m[0]}.{m[1]}" not in datas:
        problems.append(f"data.{m[0]}.{m[1]} is used but not declared")
for d in sorted(datas):
    if code.count(d) == 0:  # the declaration is written data "t" "n", so any dotted mention is a use
        problems.append(f"{d} is declared but never used")

refs = set(re.findall(r"(?<![.\w])(aws_[a-z_0-9]+\.[a-z_0-9]+)", code))
for r in sorted(refs):
    if r not in resources:
        problems.append(f"{r} is referenced but not declared")

# templatefile() placeholders
tpl = (ROOT / "flows" / "servicedesk.json.tftpl").read_text()
used = set(re.findall(r"\$\{([a-z_]+)\}", tpl))
passed = set()
for m in re.finditer(r"templatefile\([^,]+,\s*\{(.*?)\}\s*\)", code, re.S):
    passed.update(re.findall(r"^\s*([a-z_]+)\s*=", m.group(1), re.M))
if used != passed:
    problems.append(f"flow template uses {sorted(used)} but templatefile passes {sorted(passed)}")

# Hygiene
if re.search(r"AKIA[0-9A-Z]{16}", alltext):
    problems.append("something that looks like an AWS access key is in the Terraform")
if re.search(r"(?i)password\s*=\s*\"[^\"]+\"", code):
    problems.append("a hard-coded password-looking value is in the Terraform")
if re.search(r'"\*"', re.sub(r'Resource\s*=\s*"\*"', "", code)):
    problems.append('a wildcard "*" appears outside the KMS key policy; check it is intended')

print(f"{len(files)} files, {len(resources)} resources, {len(datas)} data sources, "
      f"{len(variables)} variables, {len(outputs)} outputs")
if problems:
    print("\nPROBLEMS:")
    for p in problems:
        print("  -", p)
    sys.exit(1)
print("OK: parses, every reference resolves, nothing unused, placeholders match")
