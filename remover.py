# remover.py
import sys

if len(sys.argv) != 2:
    print(f"Usage: python3 {sys.argv[0]} <file.js>")
    sys.exit(1)

filename = sys.argv[1]

with open(filename, "r", encoding="utf-8") as f:
    src = f.read()

out = []
i = 0
state = "normal"

while i < len(src):
    c = src[i]
    n = src[i + 1] if i + 1 < len(src) else ""

    if state == "normal":
        if c == "/" and n == "/":
            # Skip until newline
            i += 2
            while i < len(src) and src[i] not in "\r\n":
                i += 1
            continue

        if c == "/" and n == "*":
            # Skip block comment too
            i += 2
            while i + 1 < len(src) and not (src[i] == "*" and src[i + 1] == "/"):
                i += 1
            i += 2
            continue

        if c == '"':
            state = "double"
        elif c == "'":
            state = "single"
        elif c == "`":
            state = "template"

        out.append(c)
        i += 1

    elif state in ("single", "double"):
        out.append(c)

        if c == "\\" and i + 1 < len(src):
            out.append(src[i + 1])
            i += 2
        else:
            if (state == "single" and c == "'") or (state == "double" and c == '"'):
                state = "normal"
            i += 1

    elif state == "template":
        out.append(c)

        if c == "\\" and i + 1 < len(src):
            out.append(src[i + 1])
            i += 2
        elif c == "`":
            state = "normal"
            i += 1
        else:
            i += 1

with open(filename, "w", encoding="utf-8") as f:
    f.write("".join(out))

print(f"Removed comments from {filename}")