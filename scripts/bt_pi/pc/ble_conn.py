"""连 ESP32 (pianoflow) 的稳健封装 —— Windows 蓝牙栈很难搞.

踩过的坑:
  1. 扫描能找到设备, 但按地址直连报 "Device ... was not found"
     → Windows 会缓存设备, 得让设备**重新广播**才行.
  2. 连上了但服务里没有我们的 characteristic
     → 缓存连到了**另一台**设备, 必须校验服务列表.
  3. 连上后设备掉广播 → 用串口 RTS 复位 ESP32 (EN 脚), 它会重新广播.

所以这里做三件事:
  * 扫不到 → 用串口复位, 再扫
  * 连不上 → 换地址重试
  * 连上了 → 校验 characteristic 在不在, 不在就断开重来
"""

import asyncio
import time

from bleak import BleakClient, BleakScanner

SERVICE_UUID = "6e400001-b5a3-f393-e0a9-e50e24dcca9e"
RX_UUID = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"
TX_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"
DEVICE_NAME = "pianoflow"
KNOWN_ADDR = "B8:1F:3F:BA:3A:C5"
COM_PORT = "COM5"


def reset_device(com_port: str = COM_PORT) -> bool:
    """用串口 RTS 复位 ESP32 (EN 脚), 让它重新广播."""
    try:
        import serial
    except ImportError:
        return False
    try:
        s = serial.Serial(com_port, 115200, timeout=0.3)
        s.dtr = False
        s.rts = True
        time.sleep(0.4)
        s.rts = False
        time.sleep(0.2)
        s.close()
        return True
    except Exception:
        return False


def all_characteristics(client):
    """列出设备上的全部 characteristic —— 兼容 bleak 0.x/1.x/2.x/3.x.

    bleak 各版的 client.services 结构不一样:
      0.x  : {uuid: service}                    (dict)
      1.x/2.x: BleakGATTServiceCollection, .characteristics 是 list
      3.x  : BleakGATTServiceCollection, .characteristics 是 {handle: char}
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


def _has_our_service(client) -> bool:
    try:
        uuids = [str(ch.uuid) for ch in all_characteristics(client)]
    except Exception:
        return False
    return TX_UUID in uuids and RX_UUID in uuids


async def scan_addresses(timeout: float = 6.0) -> list:
    """扫到所有叫 pianoflow 的设备 (可能扫不到 —— 已经连着就不广播了)."""
    try:
        devs = await BleakScanner.discover(timeout=timeout, return_adv=True)
    except Exception:
        return []
    return [d.address for d, _ in devs.values() if d.name == DEVICE_NAME]


async def connect(max_attempts: int = 12, verbose: bool = True):
    """连上设备并校验服务. 返回已连接的 BleakClient."""
    for attempt in range(max_attempts):
        addrs = await scan_addresses()
        if not addrs:
            addrs = [KNOWN_ADDR]
        for addr in addrs:
            client = None
            try:
                client = BleakClient(addr)
                await client.connect()
            except Exception:
                client = None
                continue
            if _has_our_service(client):
                return client
            if verbose:
                print(f"  {addr} 服务不对, 断开")
            try:
                await client.disconnect()
            except Exception:
                pass
        if verbose:
            print(f"  尝试 {attempt + 1}/{max_attempts} 失败")
        reset_device()
        await asyncio.sleep(2.0)
    raise RuntimeError("连不上 ESP32")


class Resp:
    """按 id 收集响应."""

    def __init__(self):
        self.buf = ""
        self.lines = []
        self.ids = set()
        self.raw_unknown = []   # 认不出的响应 (空 id 的错误响应会进这里)

    def feed(self, data: str):
        self.buf += data
        while "\n" in self.buf:
            line, self.buf = self.buf.split("\n", 1)
            if not line.strip():
                continue
            try:
                obj = json.loads(line)
            except Exception:
                self.raw_unknown.append({"RAW": line[:200]})
                continue
            cid = str(obj.get("id"))
            self.lines.append(obj)
            if cid:
                self.ids.add(cid)
            else:
                # ⚠️ 空 id 的响应 = 固件没认出是哪条命令 (行被截断/损坏)
                self.raw_unknown.append(obj)

    async def wait_for(self, cid, timeout: float = 10.0):
        t0 = time.perf_counter()
        while time.perf_counter() - t0 < timeout:
            if str(cid) in self.ids:
                self.ids.discard(str(cid))
                return True
            await asyncio.sleep(0.001)
        return False


import json  # noqa: E402  (放在后面只是为了让文件顶部好读)
