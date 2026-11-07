# 重新生成界面用的字体子集。
#
# 为什么要子集：Noto Sans CJK SC 两个字重一共 32.9MB，整个打进桌面端 exe 会让产物
# 从 23.7MB 涨到 36.4MB。界面只用到 800 来个字，裁出来只有 409KB。
#
# 用法（本机 python 自带 fontTools 4.63 + brotli）：
#   D:\AITools\py312\python.exe tools\subset-fonts.py
#
# 规则：把 renderer 下所有 .js/.mjs/.html/.css 里出现过的字符全收进来，
# 再补全 ASCII 0x20-0x7E 和界面会用到的符号。改了界面文案就重跑一次。
# 原字体（33MB）放在 desktop/fonts-src/，不打进安装包，换机器也能重新裁。

import pathlib
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent          # desktop/tools
DESKTOP = HERE.parent                                    # desktop
RENDERER = DESKTOP / "renderer"
SOURCE = DESKTOP / "fonts-src"
TARGET = RENDERER / "assets" / "fonts"
FAMILY = "NotoSansCJKsc"
WEIGHTS = ("Regular", "Medium")
SUFFIXES = {".js", ".mjs", ".html", ".css"}

# 界面上会出现、但不一定写在源码里的符号
EXTRA = "¥￥≈≥≤−–—·…“”‘’×÷→←↑↓°％‰⋯"


def collect_chars() -> str:
    chars = set()
    for path in RENDERER.rglob("*"):
        if path.is_file() and path.suffix.lower() in SUFFIXES:
            chars.update(path.read_text(encoding="utf-8", errors="replace"))
    chars.update(chr(c) for c in range(0x20, 0x7F))
    chars.update(EXTRA)
    chars = {c for c in chars if c >= " " and c != "\u00a0"}
    return "".join(sorted(chars))


def main() -> int:
    text = collect_chars()
    chars_file = DESKTOP / "tools" / ".chars.tmp"
    chars_file.write_text(text, encoding="utf-8")
    print(f"字符集 {len(text)} 个（含 ASCII）")
    try:
        for weight in WEIGHTS:
            src = SOURCE / f"{FAMILY}-{weight}.otf"
            dst = TARGET / f"{FAMILY}-{weight}.woff2"
            if not src.exists():
                print(f"缺源字体：{src}")
                return 1
            subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "fontTools.subset",
                    str(src),
                    f"--text-file={chars_file}",
                    "--flavor=woff2",
                    f"--output-file={dst}",
                    "--layout-features=*",
                    "--name-IDs=*",
                ],
                check=True,
            )
            print(f"{dst.name}: {dst.stat().st_size:,} 字节")
    finally:
        chars_file.unlink(missing_ok=True)
    print("完成")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
