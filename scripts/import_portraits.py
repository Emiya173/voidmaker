"""把完整立绘裁成 pack 用的紧凑 PNG(统一取景,脸固定不跳)。

完整立绘(如 /mnt/game/adv/ex/st/ST01A_A020.png)是 2400x2048 画布、四周大量
透明边距、角色全身居中。本脚本:
1. 读 character.json 引用的所有表情码(A020/B180/E050…);
2. 用全组内容 bbox 的并集算一个稳定裁剪框(手势不被切、脸不跳);
3. 按 --bottom 比例做"腰上/全身"取景,统一裁剪每张 → 写进 pack。

用法:
  python scripts/import_portraits.py --src /mnt/game/adv/ex/st \
      --pack characters/sakura --prefix ST01A_ --bottom 0.72
再跑 python -m voidmaker 看效果;想改取景改 --bottom(1.0=全身)重跑即可。
"""
from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path

from PIL import Image


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True, help="完整立绘目录")
    ap.add_argument("--pack", required=True, help="角色包目录(含 character.json)")
    ap.add_argument("--prefix", default="ST01A_", help="完整立绘文件名前缀")
    ap.add_argument("--bottom", type=float, default=0.72, help="纵向保留比例(1.0=全身,0.72≈腰上)")
    ap.add_argument("--pad", type=float, default=0.02, help="裁剪框四周留白比例")
    args = ap.parse_args()

    pack = Path(args.pack)
    src = Path(args.src)
    raw = json.loads((pack / "character.json").read_text(encoding="utf-8"))
    portrait = raw.get("portrait", {})
    codes = set()
    if portrait.get("default"):
        codes.add(Path(portrait["default"]).stem)
    for v in (portrait.get("expressions") or {}).values():
        codes.add(Path(v).stem)
    default_code = Path(portrait["default"]).stem if portrait.get("default") else None

    # 1) 找到每个码对应的完整立绘,算内容 bbox 并集
    srcs = {}
    ux0 = uy0 = 10**9
    ux1 = uy1 = 0
    for code in sorted(codes):
        f = src / f"{args.prefix}{code}.png"
        if not f.is_file():
            print(f"⚠ 缺完整立绘: {f.name}(跳过)")
            continue
        im = Image.open(f).convert("RGBA")
        b = im.getbbox()
        srcs[code] = (f, im, b)
        ux0, uy0 = min(ux0, b[0]), min(uy0, b[1])
        ux1, uy1 = max(ux1, b[2]), max(uy1, b[3])
    if not srcs:
        print("没有可导入的立绘")
        return

    W, H = ux1 - ux0, uy1 - uy0
    padx, pady = int(W * args.pad), int(H * args.pad)
    fx0 = max(0, ux0 - padx)
    fy0 = max(0, uy0 - pady)
    fx1 = ux1 + padx
    fy1 = uy0 + int(H * args.bottom)  # 从头顶向下按比例(腰上/全身)
    frame = (fx0, fy0, fx1, fy1)
    print(f"统一裁剪框(画布坐标): {frame}  输出尺寸 {fx1-fx0}x{fy1-fy0}")
    if default_code and default_code in srcs:
        db = srcs[default_code][2]
        dcx = ((db[0] + db[2]) / 2.0 - fx0) / (fx1 - fx0)
        print(f"默认姿势角色水平中心 = {dcx:.3f}(widget 按此居中,无需手填)")

    # 2) 备份现有 pack 立绘,统一裁剪写入
    pdir = pack / "portraits"
    backup = pack / "portraits_cropped_backup"
    if pdir.is_dir() and not backup.exists():
        shutil.copytree(pdir, backup)
        print(f"已备份原裁切版 → {backup}")
    pdir.mkdir(parents=True, exist_ok=True)
    for code, (f, im, b) in srcs.items():
        out = im.crop(frame)
        out.save(pdir / f"{code}.png")
    print(f"✓ 导入 {len(srcs)} 张 → {pdir}")


if __name__ == "__main__":
    main()
