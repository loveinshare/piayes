#!/usr/bin/env python3
"""WebSocket <-> TCP bridge for LED control.

Listens on WS_PORT (default 8080), forwards each message to the existing
TCP LED server on 127.0.0.1:7777 (started by led_remote.py), and returns
the response to the WebSocket client.

为什么用 bridge 而不是直接控制 strip:
- 现有 TCP server 拥有 /dev/mem 句柄, rpi_ws281x 只能单实例
- TCP server 已处理自动重连等, 不重复造轮子
- bridge 本身无需 root

安全加固 (spec P1-10 / §7):
旧版本每个同网段主机都能连上来随意控制 176 颗 LED, 且能刷爆 Pi 的 CPU.
现在叠了五层防护 (任一层失败时其他层仍然生效):

1. **共享 token** —— 连接后第一条消息必须是 {"op":"auth","token":"..."}.
   token 从 ``/opt/bt-gpio/led_token`` (chmod 600) 或环境变量 ``LED_TOKEN`` 读.
   未配置 token 时只打警告并放行 (向后兼容); 设 ``LED_REQUIRE_TOKEN=1`` 则强制.
2. **Origin 白名单** —— 默认放行 ``file://`` / ``null`` / ``localhost`` / ``127.0.0.1``,
   其余用 ``LED_ALLOW_ORIGINS`` (逗号分隔) 补充.
   WebSocket 不受同源策略保护 —— 任何页面都能连上来, 所以这层必要.
3. **连接数上限** —— 默认 4 (``LED_MAX_CLIENTS``).
4. **每客户端限流** —— 令牌桶, 默认 200 msg/s (``LED_MAX_MSG_PER_SEC``).
5. **单条消息大小上限** —— 64KB (``LED_MAX_MSG_SIZE``).

部署建议:
- 前端直连 Pi 时 ``WS_HOST`` 保持 ``0.0.0.0`` (默认), 但确保上面的 token/Origin 生效.
- 有反向代理 (nginx/Caddy) 时设 ``LED_WS_HOST=127.0.0.1``, 由代理负责 TLS / 白名单 / 连接数.

依赖: pip3 install websockets
"""
import asyncio
import hmac
import json
import logging
import os
import sys
import time
from urllib.parse import urlparse

TCP_HOST = "127.0.0.1"
TCP_PORT = int(os.environ.get("LED_TCP_PORT", "7777"))
WS_HOST = os.environ.get("LED_WS_HOST", "0.0.0.0")
WS_PORT = int(os.environ.get("LED_WS_PORT", "8080"))

# --- 安全参数 (env 可覆盖) ---------------------------------
TOKEN_FILE = os.environ.get("LED_TOKEN_FILE", "/opt/bt-gpio/led_token")
REQUIRE_TOKEN = os.environ.get("LED_REQUIRE_TOKEN", "").lower() in ("1", "true", "yes")
MAX_CLIENTS = int(os.environ.get("LED_MAX_CLIENTS", "4"))
MAX_MSG_PER_SEC = float(os.environ.get("LED_MAX_MSG_PER_SEC", "200"))
MAX_MSG_SIZE = int(os.environ.get("LED_MAX_MSG_SIZE", str(64 * 1024)))
# 鉴权握手超时 (秒) —— 连上但不发 auth 的客户端不能一直占着连接名额
AUTH_TIMEOUT_S = float(os.environ.get("LED_AUTH_TIMEOUT_S", "10"))
# 额外允许的 Origin (逗号分隔). 默认允许本机场景.
ALLOW_ORIGINS = [o.strip() for o in os.environ.get("LED_ALLOW_ORIGINS", "").split(",") if o.strip()]

log = logging.getLogger("ws_bridge")

# 运行时状态
_clients = 0  # 当前连接数 (事件循环单线程, 不需要锁)


def load_token():
    """读取共享 token. 返回 None 表示未配置."""
    tok = os.environ.get("LED_TOKEN")
    if tok and tok.strip():
        return tok.strip()
    try:
        with open(TOKEN_FILE, "r", encoding="utf-8") as f:
            tok = f.read().strip()
        return tok or None
    except OSError:
        return None


TOKEN = load_token()
if TOKEN:
    log.info("token 已加载 (源: %s)", "env" if os.environ.get("LED_TOKEN") else TOKEN_FILE)
elif REQUIRE_TOKEN:
    log.error("LED_REQUIRE_TOKEN=1 但没有 token (%s) —— 全部连接将被拒绝", TOKEN_FILE)
else:
    log.warning("未配置 token (%s) —— 未授权的客户端也能连上来. "
                "生产环境请先生成 token 文件, 或设 LED_REQUIRE_TOKEN=1", TOKEN_FILE)


def origin_allowed(origin):
    """Origin 白名单. 无 Origin (非浏览器客户端) 放行 —— 仍要过 token."""
    if not origin:
        return True
    if origin in ALLOW_ORIGINS:
        return True
    if origin in ("null", "file://"):
        return True
    try:
        u = urlparse(origin)
    except ValueError:
        return False
    if u.scheme in ("http", "https") and u.hostname in ("localhost", "127.0.0.1", "::1"):
        return True
    return False


class RateLimiter:
    """令牌桶: 每秒 MAX_MSG_PER_SEC 条, 桶容量 = 2 倍秒度."""

    def __init__(self, rate, burst=None):
        self.rate = max(0.1, rate)
        self.burst = burst if burst is not None else max(1.0, self.rate * 2)
        self.tokens = self.burst
        self.last = time.monotonic()

    def allow(self):
        now = time.monotonic()
        self.tokens = min(self.burst, self.tokens + (now - self.last) * self.rate)
        self.last = now
        if self.tokens < 1:
            return False
        self.tokens -= 1
        return True


def _headers(ws):
    """取握手请求头 (兼容 websockets 不同版本)."""
    headers = getattr(ws, "request_headers", None)
    if headers is None:
        req = getattr(ws, "request", None)
        headers = getattr(req, "headers", None) if req is not None else None
    if headers is None:
        return {}
    try:
        return {str(k).lower(): v for k, v in headers.items()}
    except Exception:
        return {}


def _peer(ws):
    addr = getattr(ws, "remote_address", None) or getattr(ws, "peer_address", None)
    if isinstance(addr, (tuple, list)) and addr:
        return f"{addr[0]}:{addr[1]}"
    return str(addr)


async def _close(ws, code=1008, reason=""):
    try:
        await ws.close(code=code, reason=reason)
    except TypeError:
        try:
            await ws.close(code=code)
        except Exception:
            pass
    except Exception:
        pass


async def _authenticate(ws, limiter, peer):
    """token 鉴权握手 —— 第一条消息必须是 auth.

    返回 True = 已鉴权, 可以放行后续命令.
    返回 False = 已拒绝并关闭连接.

    放在**开上游 TCP 连接之前**调用: 未鉴权的客户端不该占住
    (a) 一个 client 名额 (MAX_CLIENTS 默认只有 4) 和
    (b) 一个到 LED server 的 TCP 连接 ——
    否则 4 个不鉴权的假连接就能把真正的前端挤掉 (DoS).
    """
    if not TOKEN:
        return True
    try:
        raw = await asyncio.wait_for(ws.recv(), timeout=AUTH_TIMEOUT_S)
    except asyncio.TimeoutError:
        log.warning("reject: auth timeout from %s", peer)
        await _close(ws, 1008, "auth timeout")
        return False
    except Exception:
        return False
    if isinstance(raw, bytes):
        raw = raw.decode("utf-8", errors="replace")
    # 鉴权消息也算一条 —— 同样要过限流 (否则可以狂发 auth 探测)
    if not limiter.allow():
        log.warning("reject: rate limit exceeded from %s", peer)
        await _close(ws, 1008, "rate limit exceeded")
        return False
    try:
        req = json.loads(raw)
    except Exception:
        req = {}
    token = None
    if isinstance(req, dict):
        token = req.get("token")
        if token is None:
            args = req.get("args")
            if isinstance(args, dict):
                token = args.get("token")
    if req.get("op") != "auth" or not token:
        log.warning("reject: unauthenticated command %r from %s",
                    (req.get("op") if isinstance(req, dict) else None), peer)
        try:
            await ws.send(json.dumps({"ok": False, "error": "auth required"}))
        except Exception:
            pass
        await _close(ws, 1008, "auth required")
        return False
    if not hmac.compare_digest(str(token), TOKEN):
        log.warning("reject: bad token from %s", peer)
        try:
            await ws.send(json.dumps({"ok": False, "error": "bad token"}))
        except Exception:
            pass
        await _close(ws, 1008, "bad token")
        return False
    log.info("client authenticated %s", peer)
    resp = {"ok": True, "authed": True}
    if req.get("id") is not None:
        resp["id"] = req["id"]
    try:
        await ws.send(json.dumps(resp))
    except Exception:
        return False
    return True


async def handle_client(ws, path=None):
    """Forward one WS client to one TCP connection."""
    global _clients
    peer = _peer(ws)

    # --- 防护 2: Origin 白名单 ---------------------------------
    headers = _headers(ws)
    origin = headers.get("origin")
    if not origin_allowed(origin):
        log.warning("reject: origin %r not allowed (from %s)", origin, peer)
        await _close(ws, 1008, "origin not allowed")
        return

    # --- 防护 1a: 强制 token 但配置错误 → 直接全部拒绝 ---------
    if REQUIRE_TOKEN and not TOKEN:
        log.error("reject: LED_REQUIRE_TOKEN=1 but no token loaded")
        await _close(ws, 1011, "token not configured")
        return

    # --- 防护 3: 连接数上限 ---------------------------------
    if _clients >= MAX_CLIENTS:
        log.warning("reject: too many clients (%d >= %d) from %s", _clients, MAX_CLIENTS, peer)
        await _close(ws, 1013, "too many clients")
        return
    _clients += 1
    log.info("client connected %s (active %d/%d)", peer, _clients, MAX_CLIENTS)

    try:
        limiter = RateLimiter(MAX_MSG_PER_SEC)

        # --- 防护 1: token 鉴权 (在开上游 TCP 连接**之前**) ---
        # 顺序很重要: 见 _authenticate 的说明 —— 未鉴权的客户端不该占住
        # client 名额或 LED server 的 TCP 连接 (DoS).
        if not await _authenticate(ws, limiter, peer):
            return

        try:
            reader, writer = await asyncio.open_connection(TCP_HOST, TCP_PORT)
        except Exception as e:
            log.warning(f"TCP connect {TCP_HOST}:{TCP_PORT} 失败: {e}")
            try:
                await ws.send(json.dumps({"ok": False, "error": f"TCP {e}"}))
                await ws.close()
            except Exception:
                pass
            return

        stats = {"msg": 0, "fwd": 0}

        async def tcp_to_ws():
            try:
                while True:
                    data = await reader.readline()
                    if not data:
                        break
                    await ws.send(data.decode().strip())
            except Exception:
                pass
            await _close(ws, 1000, "upstream closed")

        async def ws_to_tcp():
            try:
                async for msg in ws:
                    stats["msg"] += 1
                    if isinstance(msg, bytes):
                        msg = msg.decode("utf-8", errors="replace")

                    # --- 防护 4: 限流 ---------------------------------
                    if not limiter.allow():
                        log.warning("reject: rate limit exceeded from %s", peer)
                        await _close(ws, 1008, "rate limit exceeded")
                        return

                    # 已鉴权 (握手阶段完成) 的命令才转发到 TCP server
                    writer.write((msg + "\n").encode("utf-8"))
                    await writer.drain()
                    stats["fwd"] += 1
            except Exception:
                pass

        # 任一边结束就取消另一边 ——
        # 否则派生任务会在 reader.readline() 上永远阻塞, gather 永不返回.
        t_ws = asyncio.create_task(tcp_to_ws())
        t_tcp = asyncio.create_task(ws_to_tcp())
        try:
            await asyncio.wait({t_ws, t_tcp}, return_when=asyncio.FIRST_COMPLETED)
        finally:
            for t in (t_ws, t_tcp):
                if not t.done():
                    t.cancel()
            await asyncio.gather(t_ws, t_tcp, return_exceptions=True)
            # ★ 上游 TCP 连接**必须**在这里关掉.
            #
            # 以前只在 ws_to_tcp 自己正常结束那条路径上关 —— 而它被 cancel
            # (上游先断 / WS 先断) 时走不到, 于是桥就攒下一条条没人管的 TCP
            # 连接 (实测 4 条 SYN-SENT 僵尸). 它们各占 led_remote 的一个
            # client 槽位, 前端真正想连的时候槽位已经被僵尸占着.
            try:
                writer.close()
                await writer.wait_closed()
            except Exception:
                pass
        log.info("client disconnected %s (msg=%d forwarded=%d)", peer, stats["msg"], stats["fwd"])
    finally:
        _clients = max(0, _clients - 1)


async def main():
    try:
        import websockets
    except ImportError:
        print("需要 websockets: sudo pip3 install websockets", flush=True)
        sys.exit(1)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    log.info(f"WS bridge :{WS_PORT} -> TCP {TCP_HOST}:{TCP_PORT} (host={WS_HOST})")
    log.info(f"limits: clients<={MAX_CLIENTS} msg/s<={MAX_MSG_PER_SEC} size<={MAX_MSG_SIZE}")
    async with websockets.serve(
        handle_client,
        WS_HOST,
        WS_PORT,
        max_size=MAX_MSG_SIZE,
    ):
        log.info("ready")
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
