// 评分与判定窗口 —— 引擎与 UI 共用同一口径
//
// 抽出来的原因:
//  - P1-4: 准确率公式散在 StatusBar / StatsPopup 两处, 且都**漏掉了 errors**,
//          成绩系统性虚高 (打错音不算扣分).
//          现统一为 hits / (hits + misses + errors), 与 sightread 一致
//          (refs/sightread/src/features/player/player.ts:42-46).
//  - P1-5: 判定窗口原本是写死的 500ms 绝对值, 与乐曲速度完全脱钩 ——
//          慢板宽到"随便弹都算准", 快板宽到"半拍都算". 现按 bpm 缩放.

export interface ScoreSnapshot {
  hits: number
  misses: number
  errors: number
  perfects: number
  goods: number
  streak: number
  maxStreak: number
  /** 0..100 —— error 计入分母 (同 sightread) */
  accuracy: number
}

export interface ScoreInput {
  hits: number
  misses: number
  errors: number
  perfects: number
  goods: number
  streak: number
  maxStreak: number
}

/**
 * 准确率: hits / (hits + misses + errors).
 * error (弹错音) 计入分母 —— 跟 sightread 的 `hit / (hit + missed + error)` 一致.
 * 一个音都没弹过时返回 100 (空成绩不算差).
 */
export function accuracyPercent(hits: number, misses: number, errors: number): number {
  const total = hits + misses + errors
  if (total <= 0) return 100
  return Math.round((hits / total) * 100)
}

export function scoreSnapshot(s: ScoreInput): ScoreSnapshot {
  return { ...s, accuracy: accuracyPercent(s.hits, s.misses, s.errors) }
}

/** 判定窗口 (ms) */
export interface TimingWindows {
  /** 命中窗口: 文件 NoteOn 之后多久内按下仍算命中 (超出走 miss) */
  hit: number
  /** perfect 阈值: |dt| < perfect 记 perfect */
  perfect: number
  /** good 阈值: |dt| < good 记 good; 再晚仍算 hit, 只是不算好成绩 */
  good: number
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

/**
 * 按 bpm 算出判定窗口.
 *
 * - `hit` = 一拍的 50%, 夹在 [150, 300] ms:
 *   60bpm → 300ms (不再是固定 500ms 的"半拍都算准")
 *   120bpm → 250ms
 *   150bpm → 200ms
 *   同时受用户的容差设置 (`baseToleranceMs`) 封顶 —— 用户设了更宽松就以用户为准.
 * - `perfect` / `good` 由 `hit` 派生 (20% / 50%): 慢板相对误差更大, 给的绝对窗口也更大.
 *   120bpm 下 perfect = 50ms —— 与 sightread 的 PERFECT_RANGE 一致
 *   (refs/sightread/src/features/player/player.ts:15-16, GOOD_RANGE=300 / PERFECT_RANGE=50).
 * - 音符自身时长**不参与**窗口计算: 短音的"手速不够"问题由
 *   (a) 150ms 的窗口下限 和 (b) fileNoteOff 之后的 grace 机制共同兜住 ——
 *   sightread / neothesia 同样只看时间差, 不看 note duration.
 */
export function timingWindows(
  bpm: number,
  baseToleranceMs = 300,
): TimingWindows {
  const beatMs = 60000 / Math.max(20, bpm)
  const hit = Math.min(baseToleranceMs, Math.round(clamp(beatMs * 0.5, 150, 300)))
  const perfect = Math.round(clamp(hit * 0.2, 20, 50))
  const good = Math.round(clamp(hit * 0.5, 40, 150))
  return { hit, perfect, good }
}
