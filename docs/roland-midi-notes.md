# 与 Roland 电钢通信的笔记

> 来源:mido + python-rtmidi 直接探测 Windows 11 上的罗兰 USB-MIDI。
> 适用型号:罗* Digital Piano(在用户机器上具体型号未确认)。
> 验证日期:2026-10-13。

---

## 1. 硬件 / 驱动

- **连接方式**:USB(不是蓝牙)。Win11 免驱,直接出 2 个 MIDI 端口。
- **如果用蓝牙**:Web MIDI / mido 看不到 BLE-MIDI 设备。需走 loopMIDI 桥或 USB。
- **不需要罗兰官方驱动**(本机不装也能跑 mido)。

---

## 2. 端口枚举(mido 输出)

```
=== INPUTS ===
  Roland Digital Piano 0

=== OUTPUTS ===
  Microsoft GS Wavetable Synth 0
  Roland Digital Piano 1
```

**关键事实**:
- 罗兰在 Web MIDI 里呈现为**两个独立端口**:input `0` 和 output `1`。末尾的 `0`/`1` 是端口号,不是通道。
- Web MIDI 的 `MIDIAccess.inputs.values()` 和 `MIDIAccess.outputs.values()` 各取一遍,不要假设 in/out 共用同一 `id`。
- 注意:某些型号的罗兰同一台会暴露 2 in + 2 out,但用户这台是 1 in + 1 out(够了)。

---

## 3. MIDI 通道(用户实测)

- 用户**所有按键都在 channel 0**。也就是说:罗兰默认 transmit channel = 0。
- 项目的 `Accompaniment.ts` 把左手走 ch=0、右手走 ch=1 — 这意味着右手从罗兰出来**可能没声音**(罗兰本地接收 channel 固定)。
- **建议**:发送伴奏用 **单一 channel(0)**,所有 note 用同一通道;如果非要分声部,用 ch=9(鼓)或在不同 channel 间轮换。

---

## 4. MIDI 消息格式

### 发音(Note On / Off)
```
status byte = 0x90 | channel   # 0x90..0x9F = note on (ch 0..15)
             = 0x80 | channel   # 0x80..0x8F = note off (ch 0..15)
data1 = midi note (0..127, C4=60)
data2 = velocity (1..127 for on, 0..127 for off)
```

### 收尾安全:All Notes Off
```
control_change, channel=ch, control=123, value=0
```
**重要**:任何暂停 / seek / 异常退出前,**16 个 channel 全发一遍 CC#123**,否则电钢里挂住的音会一直响。

### 收音(从电钢到软件)
- `note_on` status = `0x90 | ch`,velocity > 0
- `note_off` status = `0x80 | ch`,或 `0x90 | ch` velocity=0(罗兰两种都会发)

---

## 5. 时序

- **不要假设瞬时**:发送一条 `note_on` 后立即发 `note_off`,罗兰来不及反应。**最小持续 ~50ms**(实测 0.06s 以上 OK)。
- **msgs 是流式的**:罗兰的 USB-MIDI 缓冲小,如果长时间不发,罗兰不会主动 ping,也没问题。但**累积太多未消 note 会占内存**,所以发送端要严格每个 note 对应一个 off。
- **不能依赖 setTimeout 收尾**:必须在主循环里 `for n in playingNotes` 主动发 off。**seek/pause 时也要扫一遍**。
- **tempo 跟踪**:`MIDIFile.play()` 输出的 `msg.time` 是 **delta-in-seconds**(tempo-aware),累加即绝对秒数。**不要用 `merge_tracks` 后取 `msg.time`**(那是 ticks,不是秒)。

---

## 6. 实测数据(用户弹奏)

### 力度行为
- 按键 vel 范围 **3 ~ 127**(用户实测最弱 vel=3 是「摸键」)
- **note_off velocity 经常 > note_on velocity**(罗兰特有的「释放感」映射),**不是 bug**

### 常见错误
| 症状 | 根因 | 修法 |
|---|---|---|
| 没声音 | 选了「双手」模式 → MIDI Out 不发任何东西 | 切单手,或全走 MIDI Out |
| 没声音 | 罗兰 Local Off | 罗兰面板打开 Local Control |
| 没声音 | 通道不匹配 | 项目目前 ch=0/1,罗兰默认收 ch=0 |
| 输入收不到 | MIDI Thru 被回环 | `list()` 过滤掉名字含 `through` 的端口 |
| 暂停后音卡住 | 忘了发 All Notes Off | `pause()` 里强制停所有 playing notes |
| seek 后音卡住 | 同上 | `seek()` 后扫一遍 |

---

## 7. 已验证的链路(mido 直测)

| 测试 | 命令 | 结果 |
|---|---|---|
| 端口枚举 | `mido.get_input_names()` | 看到罗兰 in |
| 发单音 C4 | `out.send([0x90, 60, 100])` | ✅ 用户听到 |
| 播放 sample.mid | `for msg in mid.play()` | ✅ 592 msgs / 63.36s |
| 接收按键 | `inp.callback = ...` | ✅ 100+ msgs,识别旋律 |

---

## 8. Web MIDI 对照表(mido → Web MIDI)

| mido 操作 | Web MIDI 对应 |
|---|---|
| `mido.open_output(name)` | 拿到 `MIDIAccess`,从 `access.outputs.values()` 找 |
| `out.send(msg)` | `output.send([status, data1, data2])`(注意是数组) |
| `mido.open_input(name)` | `access.inputs.get(id)` |
| `inp.callback = fn` | `input.addEventListener('midimessage', fn)` |
| `msg.note` / `msg.velocity` | `event.data[1]` / `event.data[2]` |
| `msg.type == 'note_on'` | `event.data[0] >> 4 == 9 && event.data[2] > 0` |
| `msg.type == 'note_off'` | `event.data[0] >> 4 == 8 \|\| (data[0]>>4==9 && data[2]==0)` |

---

## 9. 关键设计原则(从踩坑总结)

1. **状态驱动,不要 setTimeout**:`note_off` 必须由主循环 / 状态机在「该音结束时」显式发。seek、暂停、退出都必须扫一遍 playing notes。
2. **All Notes Off 是兜底**:任何异常路径(用户切歌、刷新页面、tab 隐藏)前都要发一遍 CC#123,16 个 channel。
3. **通道默认 0**:罗兰默认收 ch=0,**别发到 1/2 除非用户主动配**。伴奏全走 ch=0;真要分声部,在罗兰面板切换接收通道。
4. **「双手」模式 ≠ 全走 MIDI**:明确语义 — 双手=全走浏览器合成,只有**单手**才有「非活动手 → MIDI Out」概念。
5. **设备选择先 in 后 out**:浏览器要求用户手势触发 `requestMIDIAccess`,按钮必须等用户点;拿到 access 后**分别**枚举 in / out。
6. **罗兰 output 1 端口名是固定的**:`"Roland Digital Piano 1"`,不要试图按部分名字匹配。
7. **测试夹具**:在自动化测试里,罗兰 = 输入端口 `0` + 输出端口 `1`,消息 channel=0。

---

## 10. 测试脚本(留底)

- `scripts/test_tone.py` — 发单个 C4,验证发声链路
- `scripts/test_input.py` — 监听输入,验证按键接收
- `scripts/play_midi.py` — 播放任意 .mid,罗兰自动演奏
- `scripts/record_input.py` — 录制用户弹奏,落盘 JSON+CSV
- `scripts/match_melody.py` — 方向串 LCS 匹配内置曲目库
