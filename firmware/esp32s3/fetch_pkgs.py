#!/usr/bin/env python
"""多线程分段下载 PlatformIO 包 —— 绕开 CDN 的单连接限速。

背景 (2026-10-22): dl.registry.platformio.org 对**单连接**限速到 ~19 KB/s,
但 8 条并发连接合计能到 ~140 KB/s。所以直接开 16 条连接分段拉。

用法:
  python fetch_pkgs.py            # 下载 espressif32 平台需要的全部包到 ~/.platformio/packages
  python fetch_pkgs.py --only xtensa   # 只下某个包
"""
from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import os
import shutil
import sys
import urllib.request
from pathlib import Path

PIO_HOME = Path(os.environ.get("PLATFORMIO_CORE_DIR", Path.home() / ".platformio"))
PKG_DIR = PIO_HOME / "packages"
API = "https://api.registry.platformio.org/v3/packages"

# espressif32 平台在 Windows 上编译 ESP32-S3 (xtensa) 实际需要的包。
# owner/name 与 platform.json 里的 packages 段对应。
#
# 注意: toolchain-riscv32-esp 有 933MB, 只有编 ESP32-C3/C6 (riscv) 才用得上,
# ESP32-S3 是 xtensa —— 所以默认不下, 省掉大头。
WANTED = [
    ("platformio", "toolchain-xtensa-esp-elf"),   # ~396MB, xtensa 编译器 (主工具链)
    ("platformio", "toolchain-esp32ulp"),         # ~16MB, ULP 编译器
    ("espressif", "tool-xtensa-esp-elf-gdb"),     # ~29MB, 调试器
    ("platformio", "tool-mkspiffs"),
    ("platformio", "tool-mklittlefs"),
    ("platformio", "tool-scons"),
]
# framework 包体积大, 单独下
FRAMEWORK = [("platformio", "framework-arduinoespressif32")]
# riscv 工具链 (给 C3/C6 用), 需要时才下
RISCV = [("platformio", "toolchain-riscv32-esp")]

CONN = 32


def api_json(url: str) -> dict:
    with urllib.request.urlopen(url, timeout=60) as r:
        return json.load(r)


def pick_version(owner: str, name: str) -> str | None:
    try:
        d = api_json(f"{API}/{owner}/tool/{name}")
        return d["version"]["name"]
    except Exception as e:
        print(f"  ! 查询 {owner}/{name} 失败: {e}")
        return None


def file_for(owner: str, name: str, version: str) -> dict | None:
    d = api_json(f"{API}/{owner}/tool/{name}")
    for f in d["version"]["files"]:
        # registry 返回的 system 可能是列表 (['windows_amd64','windows_arm64'])
        # 或 '*' —— 表示全平台通用 (scons / framework 是这种)
        systems = f["system"] if isinstance(f["system"], list) else [f["system"]]
        if "windows_amd64" in systems or "*" in systems:
            return f
    return None


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def segmented_download(url: str, dest: Path, size: int | None) -> bool:
    """多连接分段下载 —— 单连接被限速时这个能快一个数量级。"""
    tmp = dest.with_suffix(dest.suffix + ".part")
    part_dir = dest.parent / f".{dest.name}.parts"
    part_dir.mkdir(parents=True, exist_ok=True)

    if size is None:
        # 拿不到大小就退回单连接
        print("  未知大小, 单连接下载")
        with urllib.request.urlopen(url, timeout=120) as r, tmp.open("wb") as fh:
            shutil.copyfileobj(r, fh)
    else:
        chunk = (size + CONN - 1) // CONN
        ranges = []
        for i in range(CONN):
            s = i * chunk
            e = min(s + chunk - 1, size - 1)
            if s <= e:
                ranges.append((i, s, e))

        def grab(item):
            i, s, e = item
            p = part_dir / f"p{i}"
            if p.exists() and p.stat().st_size == (e - s + 1):
                return True
            req = urllib.request.Request(url, headers={"Range": f"bytes={s}-{e}"})
            for attempt in range(4):
                try:
                    with urllib.request.urlopen(req, timeout=120) as r, p.open("wb") as fh:
                        # 流式落盘 —— 每个分段 12MB 左右, 读完才拼,
                        # 整包 396MB 一次性读进内存没必要
                        shutil.copyfileobj(r, fh, 1 << 20)
                    if p.stat().st_size != (e - s + 1):
                        raise IOError(f"长度不符 {p.stat().st_size} != {e-s+1}")
                    return True
                except Exception as ex:
                    if attempt == 3:
                        print(f"  ! 分段 {i} 失败: {ex}")
                        return False
            return False

        with concurrent.futures.ThreadPoolExecutor(max_workers=CONN) as ex:
            if not all(ex.map(grab, ranges)):
                shutil.rmtree(part_dir, ignore_errors=True)
                return False

        with tmp.open("wb") as out:
            for i, _, _ in ranges:
                out.write((part_dir / f"p{i}").read_bytes())
        shutil.rmtree(part_dir, ignore_errors=True)

    tmp.replace(dest)
    return True


def install(owner: str, name: str, version: str, force: bool = False) -> bool:
    target = PKG_DIR / name
    marker = target / ".piopm"
    if marker.exists() and not force:
        print(f"= {name} 已存在, 跳过")
        return True

    f = file_for(owner, name, version)
    if not f:
        print(f"! {name}: 找不到 windows 构建")
        return False

    url = f["download_url"]
    size = f.get("size")
    sha = (f.get("checksum") or {}).get("sha256")
    print(f"> {name} {version}  ({size or '?'} bytes)")

    target.mkdir(parents=True, exist_ok=True)
    tarball = PKG_DIR / "_dl" / f"{name}-{version}.tar.gz"
    tarball.parent.mkdir(parents=True, exist_ok=True)

    if not (tarball.exists() and sha and sha256_of(tarball) == sha):
        if not segmented_download(url, tarball, size):
            print(f"  ! {name} 下载失败")
            return False
        if sha:
            got = sha256_of(tarball)
            if got != sha:
                print(f"  ! {name} 校验失败\n    期望 {sha}\n    实际 {got}")
                tarball.unlink(missing_ok=True)
                return False
            print(f"  校验 OK")

    import tarfile
    with tarfile.open(tarball, "r:gz") as tf:
        tf.extractall(target)

    # 包内容通常在 "package/xxx-<ver>" 这一层里, 拍平到 target/ 下,
    # 跟 PlatformIO 自己装出来的目录结构一致。
    inner = [p for p in target.iterdir() if p.is_dir() and p.name != ".pio"]
    if len(inner) == 1:
        src = inner[0]
        for item in list(src.iterdir()):
            dest = target / item.name
            if dest.exists():
                shutil.rmtree(dest, ignore_errors=True) if dest.is_dir() else dest.unlink()
            shutil.move(str(item), str(dest))
        shutil.rmtree(src, ignore_errors=True)

    (target / ".piopm").write_text(json.dumps({
        "type": "tool", "name": name, "version": version,
        "spec": {"owner": owner, "id": name, "name": name, "requirements": None},
    }))
    print(f"  安装到 {target}")
    return True


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default=None)
    ap.add_argument("--with-framework", action="store_true")
    ap.add_argument("--with-riscv", action="store_true")
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()

    PKG_DIR.mkdir(parents=True, exist_ok=True)
    targets = list(WANTED)
    if args.with_framework:
        targets += FRAMEWORK
    if args.with_riscv:
        targets += RISCV

    ok = True
    for owner, name in targets:
        if args.only and args.only not in name:
            continue
        ver = pick_version(owner, name)
        if not ver:
            ok = False
            continue
        if not install(owner, name, ver, force=args.force):
            ok = False
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
