# Noto Sans CJK SC（子集）

Source: https://github.com/notofonts/noto-cjk/tree/main/Sans/OTF/SimplifiedChinese

本目录里的两个 `.woff2` 是从原字体裁出来的**子集**，只保留界面实际用到的字符：

- 覆盖：renderer 下所有 `.js/.mjs/.html/.css` 的字符 + 全量 ASCII（0x20–0x7E）+ 界面符号，共 **797 个码点**
- 裁法：`fontTools.subset`，`--flavor=woff2 --layout-features=* --name-IDs=*`（保留 hinting，小字号更清楚）
- 大小：Regular 253,520 字节、Medium 255,444 字节（原来的两个 `.otf` 共 32,960,996 字节）
- 子集之外的字符会回退到系统字体（`fonts.css` 里 `'Salary Noto Sans SC', system-ui, …`），不会出现方块

原字体（未修改的 `.otf`）放在 `desktop/fonts-src/`，不打进安装包，用来重新裁剪。
改了界面文案后重跑：`D:\AITools\py312\python.exe tools\subset-fonts.py`

License: SIL Open Font License 1.1, see OFL.txt. Copyright and naming metadata are retained in the font files. The font license is independent of the application license.
