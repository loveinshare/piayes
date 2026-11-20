"""真机: 验证固件的**分片重组**对不对 —— 这是「乱闪」的关键嫌疑.

前端的一条命令经常超过 ATT 载荷 (244 字节) —— 比如跑马灯一帧 7 个像素
就是 327 字节. 固件要能把多个 ATT 包拼回一条完整的 JSON 行.

如果重组有问题 (比如某片被当成新行), 固件就会:
  * 执行一条**被截断**的 JSON → 解析出垃圾 → 画错像素 (乱闪)
  * 或者把半行 + 下一条命令拼在一起 → 整条命令被吞掉

本脚本按 244 字节切片写, 然后看固件回的响应:
  * id 对得上 + ok:true  → 重组正确
  * id 对不上 / 没有响应 / ok:false → 重组有问题

用法: python probe_ble_reassembly.py
"""

import asyncio
import json
import time

from bleak import BleakClient, BleakScanner

RX_UUID = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"
TX_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"
DEVICE_NAME = "pianoflow"
CHUNK = 244  # MTU 247 - 3


class Resp:
    def __init__(self):
        self.buf = ""
        self.lines = []

    def feed(self, data: str):
        self.buf += data
        while "\n" in self.buf:
            line, self.buf = self.buf.split("\n", 1)
            if line.strip():
                try:
                    self.lines.append(json.loads(line))
                except Exception:
                    self.lines.append({"RAW": line[:200]})


async def connect():
    """连上设备. Windows 蓝牙栈偶尔会缓存 '找不到', 所以多试几次."""
    for attempt in range(8):
        try:
            devs = await BleakScanner.discover(timeout=6.0, return_adv=True)
            for d, _ in devs.values():
                if d.name == DEVICE_NAME:
                    c = BleakClient(d.address)
                    await c.connect()
                    return c
            # 扫不到 (可能已经连着) → 试已知地址
            c = BleakClient("B8:1F:3F:BA:3A:C5")
            await c.connect()
            return c
        except Exception as e:
            print(f"  第 {attempt + 1} 次连接失败: {type(e).__name__}")
            await asyncio.sleep(1.5)
    raise RuntimeError("连不上设备")


async def main():
    print("连接中 ...")
    client = await connect()
    resp = Resp()
    async with client:
        await client.start_notify(TX_UUID,
                                  lambda _c, d: resp.feed(d.decode("utf-8", "replace")))
        print(f"已连接, MTU = {client.mtu_size}\n")

        print("像素数 |  字节 | 包数 | 固件回的 id | ok  | 结果")
        print("-" * 62)
        for npx in (1, 4, 5, 6, 7, 10, 20, 40, 80):
            resp.lines.clear()
            px = [{"i": i, "r": 50, "g": 0, "b": 200} for i in range(npx)]
            payload = (json.dumps({"id": f"x{npx}", "op": "led.set_many",
                                   "args": {"pixels": px}}) + "\n").encode()
            npk = len(range(0, len(payload), CHUNK))
            for off in range(0, len(payload), CHUNK):
                await client.write_gatt_char(RX_UUID, payload[off:off + CHUNK],
                                             response=False)
                # 分片之间留点间隔 —— 前端也是等上一片写完再发下一片
                await asyncio.sleep(0.02)
            await asyncio.sleep(0.6)
            got = resp.lines[0] if resp.lines else None
            got_id = got.get("id") if got else None
            ok = got.get("ok") if got else None
            good = (got_id == f"x{npx}") and ok is True
            mark = "✓" if good else "✗ 重组有问题"
            print(f"{npx:6d} | {len(payload):5d} | {npk:4d} | {str(got_id):12s} | "
                  f"{str(ok):4s} | {mark}")
            if got and not good:
                print(f"         实际收到: {json.dumps(got, ensure_ascii=False)[:160]}")
            await asyncio.sleep(0.2)

        # 全灭
        await client.write_gatt_char(
            RX_UUID, (json.dumps({"id": "off", "op": "led.off", "args": {}}) + "\n").encode(),
            response=False)

    print("\n诊断结束")


if __name__ == "__main__":
    asyncio.run(main())
