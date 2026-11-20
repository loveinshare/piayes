"""测固件端 show() 的**真实耗时** —— 判断 bit-bang 有没有被中断打断.

原理:
  ping   = 纯回包 (设备端 ≈ 0ms 计算)
  show   = 回包 + 一次 show() (bit-bang 物理 352 灯)
  两者往返的差 = 设备端 show() 的耗时.

理论值: 物理 352 灯 × 24bit × 1.25µs = **10.6ms** (bit-bang 干净时)
        (物理帧长恒定 352 —— 逻辑 count 只决定「能写哪几颗」)

⚠️ 如果实测远大于 10.6ms (比如 15-30ms), 说明 bit-bang 循环里被**中断打断**了 ——
   ESP32-S3 只有**一个 CPU 核**, BLE 协议的定时器中断会打进来.
   中断把某个 bit 的高低电平时间拉长 → WS2811 解码出**错误的颜色** →
   灯带乱闪 + 像素错位 (该灭的没灭 → 常驻灯).

测法: 各跑 N 次, 取**最小值** (过滤掉 BLE 抖动), 再相减.

用法: python probe_ble_show_time.py
"""

import asyncio
import json
import time

from bleak import BleakClient, BleakScanner

RX_UUID = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"
TX_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"
DEVICE_NAME = "pianoflow"
N = 60


def _all_characteristics(client):
    """列出设备上的全部 characteristic —— 兼容 bleak 0.x/1.x/2.x/3.x.

    bleak 3.x 的 client.services 是 BleakGATTServiceCollection (没有 .values()),
    .characteristics 是 {handle: characteristic}; 0.x 则是 {uuid: service}.
    """
    services = client.services
    chars = getattr(services, "characteristics", None)
    if chars is not None:
        return list(chars.values()) if hasattr(chars, "values") else list(chars)
    out = []
    for svc in services.values():
        c = getattr(svc, "characteristics", [])
        out.extend(c.values() if hasattr(c, "values") else c)
    return out


class Resp:
    def __init__(self):
        self.buf = ""
        self.ids = set()

    def feed(self, data: str):
        self.buf += data
        while "\n" in self.buf:
            line, self.buf = self.buf.split("\n", 1)
            if not line.strip():
                continue
            try:
                self.ids.add(str(json.loads(line).get("id")))
            except Exception:
                pass


async def connect():
    """连上设备. ⚠️ Windows 蓝牙栈会缓存 '连上的设备', 有时连上的是**另一台**
    (服务里没有我们的 characteristic). 所以每次连完都要**校验服务列表**,
    不对就断开重试."""
    for attempt in range(12):
        client = None
        try:
            devs = await BleakScanner.discover(timeout=6.0, return_adv=True)
            addrs = [d.address for d, _ in devs.values() if d.name == DEVICE_NAME]
            if not addrs:
                addrs = ["B8:1F:3F:BA:3A:C5"]
            for addr in addrs:
                try:
                    client = BleakClient(addr)
                    await client.connect()
                except Exception:
                    client = None
                    continue
                # 校验: 服务里必须有我们的 TX characteristic
                uuids = [str(ch.uuid) for ch in _all_characteristics(client)]
                if TX_UUID in uuids:
                    return client
                print(f"  连上了 {addr} 但服务不对 ({uuids}), 断开重试")
                try:
                    await client.disconnect()
                except Exception:
                    pass
                client = None
        except Exception as e:
            print(f"  连接尝试 {attempt + 1} 失败: {type(e).__name__}: {str(e)[:60]}")
        await asyncio.sleep(1.5)
    raise RuntimeError("连不上设备 (或服务不对)")


async def measure(client, resp, op, args, n=N):
    times = []
    for i in range(n):
        cid = f"{op}{i}"
        payload = (json.dumps({"id": cid, "op": op, "args": args}) + "\n").encode()
        t0 = time.perf_counter()
        await client.write_gatt_char(RX_UUID, payload, response=False)
        deadline = time.perf_counter() + 3.0
        while cid not in resp.ids and time.perf_counter() < deadline:
            await asyncio.sleep(0.0005)
        if cid in resp.ids:
            times.append((time.perf_counter() - t0) * 1000)
            resp.ids.discard(cid)
        else:
            print(f"    ⚠️ {cid} 超时")
    return times


async def main():
    print("连接中 ...")
    client = await connect()
    resp = Resp()
    async with client:
        await client.start_notify(TX_UUID,
                                  lambda _c, d: resp.feed(d.decode("utf-8", "replace")))
        print(f"已连接, MTU = {client.mtu_size}\n")

        print(f"各跑 {N} 次, 取最小值 (过滤 BLE 抖动):\n")
        ping = await measure(client, resp, "ping", {})
        await asyncio.sleep(0.5)
        show = await measure(client, resp, "led.show", {})
        await asyncio.sleep(0.5)
        status = await measure(client, resp, "status", {})

        def stat(name, ts):
            if not ts:
                print(f"  {name:12s} 没有数据")
                return None
            s = sorted(ts)
            print(f"  {name:12s} 最小 {s[0]:7.2f} ms   中位 {s[len(s) // 2]:7.2f} ms   "
                  f"最大 {s[-1]:7.2f} ms")
            return s[0]

        p_min = stat("ping", ping)
        sh_min = stat("led.show", show)
        st_min = stat("status", status)

        if p_min is not None and sh_min is not None:
            delta = sh_min - p_min
            print(f"\n  show - ping (设备端 show 耗时) = {delta:+.2f} ms")
            print(f"  理论值 (176 × 24bit × 1.25µs)  =   5.30 ms")
            if delta > 12:
                print(f"  → ⚠️ 远超理论值! bit-bang 被**中断打断**了")
                print(f"     (中断把 bit 的高低电平拉长 → WS2811 解码错颜色 → 乱闪+像素错位)")
            elif delta > 7:
                print(f"  → 略高于理论值, 有轻微中断干扰")
            else:
                print(f"  → ✓ 接近理论值, bit-bang 基本干净")

        await client.write_gatt_char(
            RX_UUID, (json.dumps({"id": "off", "op": "led.off", "args": {}}) + "\n").encode(),
            response=False)

    print("\n诊断结束")


if __name__ == "__main__":
    asyncio.run(main())
