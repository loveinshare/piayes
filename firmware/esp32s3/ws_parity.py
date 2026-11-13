"""一致性对比 —— 同一串命令分别打给树莓派和 ESP32, 把回包并排打出来.

用法: python ws_parity.py [pi_url] [esp_url]

跑的是前端 WsTransport 真正会发的那几条:
    auth → init → status → set_many → show → marquee → off → ping
每条都记下回包的**原始文本**, 方便逐字比.

比的是**解析后的 JSON** (键的顺序、空格不算差异) —— 树莓派那边是
json.dumps 默认带空格, 设备那边是紧凑格式, 逐字比没意义.

已知差异 (白名单):
  * init/status 里的 pin —— 树莓派是 GPIO 18, ESP32 是 GPIO 14 (硬件不同).
  * marquee —— 树莓派没这个 op, ESP32 有 (超集, 前端 WS 这条路压根不发).
"""
import asyncio
import json
import sys

import websockets

PI = sys.argv[1] if len(sys.argv) > 1 else "ws://192.168.1.113:8080"
ESP = sys.argv[2] if len(sys.argv) > 2 else "ws://192.168.1.108:8080"

PIX = [{"i": 0, "r": 10, "g": 0, "b": 0}, {"i": 5, "r": 0, "g": 20, "b": 0}]

CMDS = [
    ("auth", {"token": ""}),
    ("init", {"count": 176, "pin": 18}),
    ("status", {}),
    ("set_many", {"pixels": PIX}),
    ("show", {}),
    ("marquee", {"window": 4, "step": 1, "count": 2}),
    ("off", {}),
    ("ping", {}),
]

# op → 允许不一样的字段 (值不同不算不一致).
#   pin —— 树莓派是 GPIO 18, ESP32 是 GPIO 14 (硬件不同).
#   last_show_age_s —— 运行时值 (距上次 show 多久), 两边各算各的.
IGNORED_FIELDS = {
    "init": {"pin"},
    "status": {"pin", "last_show_age_s"},
}
# 树莓派没有、ESP32 多出来的 op (超集).
SUPERSET_OPS = {"marquee"}


async def run(url: str) -> list[tuple[str, str]]:
    out = []
    async with websockets.connect(url, max_size=None) as ws:
        nid = 0
        pending: dict[int, asyncio.Event] = {}
        raw_by_id: dict[int, str] = {}

        async def recv_loop() -> None:
            async for raw in ws:
                try:
                    cid = int(json.loads(raw).get("id", -1))
                except Exception:
                    continue
                raw_by_id[cid] = raw
                ev = pending.pop(cid, None)
                if ev is not None:
                    ev.set()

        task = asyncio.create_task(recv_loop())

        for op, args in CMDS:
            cid = nid
            nid += 1
            ev = asyncio.Event()
            pending[cid] = ev
            await ws.send(json.dumps({"id": cid, "op": op, "args": args}))
            try:
                await asyncio.wait_for(ev.wait(), 3.0)
                out.append((op, raw_by_id.get(cid, "?")))
            except asyncio.TimeoutError:
                out.append((op, "<超时>"))

        # 一定关灯.
        cid = nid
        nid += 1
        ev = asyncio.Event()
        pending[cid] = ev
        await ws.send(json.dumps({"id": cid, "op": "off", "args": {}}))
        try:
            await asyncio.wait_for(ev.wait(), 3.0)
        except asyncio.TimeoutError:
            pass
        task.cancel()
    return out


def norm(raw: str, op: str) -> dict | None:
    """把回包解析成 dict, 并抹掉白名单里的字段."""
    try:
        d = json.loads(raw)
    except Exception:
        return None
    if not isinstance(d, dict):
        return None
    for k in IGNORED_FIELDS.get(op, ()):  # pin: 硬件不同, 不算不一致
        d.pop(k, None)
    return d


async def main() -> None:
    pi = await run(PI)
    esp = await run(ESP)
    print(f"{'树莓派 ' + PI:38s} | ESP32 {ESP}")
    print("-" * 120)
    diffs = []
    for (op, a), (_, b) in zip(pi, esp):
        da, db = norm(a, op), norm(b, op)
        if op in SUPERSET_OPS:
            same = "➕" if da != db else "✅"
            note = "  (ESP32 超集: 树莓派没这个 op)"
        elif da is None or db is None:
            same = "≠"
            note = "  (有一边不是合法 JSON)"
        else:
            same = "✅" if da == db else "≠"
            note = ""
        print(f"{op:10s} {a:46s} {same} {b}{note}")
        if same == "≠":
            diffs.append((op, da, db))

    print()
    if diffs:
        print(f"⚠️  {len(diffs)} 条不一致:")
        for op, da, db in diffs:
            keys = sorted(set(da or {}) | set(db or {}))
            for k in keys:
                va = (da or {}).get(k, "<没有>")
                vb = (db or {}).get(k, "<没有>")
                if va != vb:
                    print(f"    {op}.{k}: 树莓派={va!r}  ESP32={vb!r}")
    else:
        print("✅ 回包一致 (字段和值都对得上)")


if __name__ == "__main__":
    asyncio.run(main())
