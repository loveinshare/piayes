#!/usr/bin/env python
"""旋律识别器 v2: 用「方向串」(= 相同 / U 上行 / D 下行)而不是 interval,
避免「同一音连续弹两次」导致 interval 全 0 的误判。

用法:
    python match_melody.py [path/to/recordings/X.json]
"""
import sys
import os
import json
import glob

NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

# 旋律库: 方向串 (U 上 / D 下 / = 同)
MELODIES = {
    # 中国
    "生日快乐 (Happy Birthday)":      "=UU=D==D=DU=",
    "小星星 (Twinkle)":               "=UU=UD=DD=DD==",
    "两只老虎 (Two Tigers)":          "U=U===U=U==UU=",
    "茉莉花 (Jasmine)":               "U=D==DU=UD=D==",
    "新年好 (New Year)":              "=UU=D==D=DU=",
    "世上只有妈妈好":                  "UU=UD=UD=D==",
    "小燕子":                          "UU=UD==UD===",
    "送别":                            "UD=DUDUD=UD=",
    "童年":                            "DD=UD=U=DDU=",

    # 西方经典
    "Für Elise 主旋律":                "DDDD=DUUDUD",
    "Canon in D 主旋律":               "UUU=U=UDDD=D",
    "Ode to Joy 主旋律":               "=UUD=DD==UD=UUD=DD==U=UD=",
    "Mary 有只小羊羔":                  "D=D=UUU===UUUDD=",

    # 周杰伦
    "晴天 (主歌起)":                    "UUUD=UDUD==",
    "简单爱 (前奏)":                    "UUU=UD=UD==",
    "七里香 (主歌起)":                  "UU=UDUD===",
}

def to_direction(seq):
    """pitch 序列 → 方向串"""
    out = []
    for i in range(len(seq)-1):
        d = seq[i+1] - seq[i]
        if d > 0: out.append("U")
        elif d < 0: out.append("D")
        else: out.append("=")
    return "".join(out)

def levenshtein(a, b):
    n, m = len(a), len(b)
    if n == 0: return m
    if m == 0: return n
    dp = [[0]*(m+1) for _ in range(n+1)]
    for i in range(n+1): dp[i][0] = i
    for j in range(m+1): dp[0][j] = j
    for i in range(1, n+1):
        for j in range(1, m+1):
            cost = 0 if a[i-1] == b[j-1] else 1
            dp[i][j] = min(dp[i-1][j]+1, dp[i][j-1]+1, dp[i-1][j-1]+cost)
    return dp[n][m]

def load_recording(path):
    with open(path, encoding="utf-8") as f:
        items = json.load(f)
    items.sort(key=lambda x: x["t"])
    # Step 1: 同时按下的音合并成单音 (取最高)
    merged = []
    cur_t = -1
    cur_notes = []
    for it in items:
        if abs(it["t"] - cur_t) > 0.08:
            if cur_notes:
                merged.append(max(cur_notes))
            cur_t = it["t"]
            cur_notes = [it["midi"]]
        else:
            cur_notes.append(it["midi"])
    if cur_notes:
        merged.append(max(cur_notes))
    # 不去重 — 用户是合法重复弹奏
    return merged

def best_lcs(a, b):
    """最长公共子序列长度"""
    n, m = len(a), len(b)
    dp = [[0]*(m+1) for _ in range(n+1)]
    for i in range(1, n+1):
        for j in range(1, m+1):
            if a[i-1] == b[j-1]:
                dp[i][j] = dp[i-1][j-1] + 1
            else:
                dp[i][j] = max(dp[i-1][j], dp[i][j-1])
    return dp[n][m]

def main():
    if len(sys.argv) > 1:
        path = sys.argv[1]
    else:
        files = sorted(glob.glob("recordings/*.json"))
        if not files:
            print("没有 recordings/*.json。先跑 record_input.py。")
            sys.exit(1)
        path = files[-1]
        print(f"(自动选用最新: {path})")

    seq = load_recording(path)
    if len(seq) < 4:
        print(f"录到的音太少({len(seq)}),不够识别。")
        sys.exit(1)

    user_dir = to_direction(seq)
    print(f"\n录到 {len(seq)} 个 onset:")
    print(f"  pitches: {' '.join(f'{NOTE_NAMES[n%12]}{(n//12)-1}' for n in seq)}")
    print(f"  方向串 ({len(user_dir)}): {user_dir}")
    print()

    print(f"{'rank':>4}  {'曲目':<28}  {'LCS':>5}  {'edit':>5}  {'覆盖率':>6}")
    print("-" * 70)

    results = []
    for name, ref_dir in MELODIES.items():
        lcs = best_lcs(user_dir, ref_dir)
        ed = levenshtein(user_dir, ref_dir)
        cov = lcs / max(len(ref_dir), 1)
        results.append((cov, ed, lcs, name, ref_dir))

    results.sort(reverse=True, key=lambda x: (x[0], -x[1]))
    for i, (cov, ed, lcs, name, ref_dir) in enumerate(results[:8], 1):
        print(f"  {i:>2}  {name:<28}  {lcs:>5}  {ed:>5}  {cov:>5.0%}  ref={ref_dir}")

    print()
    best = results[0]
    cov, ed, lcs, name, ref_dir = best
    if cov > 0.8:
        print(f"[OK] 最像: {name} (覆盖率 {cov:.0%}, 最长公共子序列 {lcs})")
    elif cov > 0.5:
        print(f"[?] 有点像: {name} (覆盖率 {cov:.0%}, 需确认)")
    else:
        print(f"[X] 不太像 (最高 {cov:.0%} = {name})")

if __name__ == "__main__":
    main()
