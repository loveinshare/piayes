// 图标集 —— 全站统一的线性图标 (24×24 网格, 1.75 描边, currentColor).
//
// 为什么不用 emoji:
//   emoji 在 Windows / macOS / Android 上渲染成完全不同的插画风格 —— 同一个 🎹
//   在 Win 是彩色小钢琴, 在 macOS 是黑白符号, 在手机是蓝底 emoji. 跟周围的
//   细线条 UI 放在一起非常刺眼, 而且不同平台下尺寸/基线都不一致.
//
// 规范:
//   - 24×24 viewBox, 1.75 描边, round 端点/转角, 全部 currentColor
//   - 实心图标 (播放/暂停) 用 fill=currentColor + stroke=none
//   - 尺寸由 size 属性控制 (默认 16), 颜色交给父级的 text-* 类
//   - 所有图标 aria-hidden —— 语义由旁边的文字/aria-label 承担

import type { ReactNode, SVGProps } from 'react'

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'children'> {
  /** 边长 (px). 默认 16 —— 跟 UI 里 h-7 控件里的 13px 文字配平. */
  size?: number
}

function Svg({ size = 16, children, ...rest }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  )
}

/* ---------------- 品牌 / 主功能 ---------------- */

/**
 * 派亚鹃 —— Piayes 的标志.
 *
 * 这不是线图标, 是**实心剪影** (Piaya 属的杜鹃: 圆头、细喙、尾巴比身子还长),
 * 所以单独一个 64×64 的 viewBox, 颜色交给父级的 text-* 类.
 * 眼睛在这个尺寸下只有一两个像素 —— 省略, 反而更干净.
 */
export function IconPiayes(props: IconProps) {
  const { size = 16, ...rest } = props
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {/* 尾巴 */}
      <path d="M20 34C12 43 6 53 3 61c5-4 12-12 20-19z" />
      {/* 身子 */}
      <ellipse cx="29" cy="31" rx="10.5" ry="8.8" transform="rotate(-30 29 31)" />
      {/* 头 */}
      <circle cx="42" cy="18" r="7.6" />
      {/* 喙 */}
      <path d="M48.5 16.6q6.5 2 9 6-5.5-1-9.9-3z" />
    </svg>
  )
}

/** 钢琴键 —— app logo、钢琴模式、电钢. */
export function IconPiano(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="2.5" y="5" width="19" height="14" rx="2.5" />
      <path d="M7.5 5v14M12 5v14M16.5 5v14" />
    </Svg>
  )
}

/** 音符 —— 乐库. */
export function IconMusic(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M9 17.5V6.2l10-2v11.1" />
      <circle cx="6.2" cy="17.6" r="2.6" />
      <circle cx="16.2" cy="15.4" r="2.6" />
    </Svg>
  )
}

/** 折线图 —— 统计. */
export function IconChart(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3.5 3.5v16a1 1 0 0 0 1 1h16" />
      <path d="m7 15 3.5-4.5 3 3L18.5 7" />
    </Svg>
  )
}

/* ---------------- 顶栏 / 导航 ---------------- */

/** 用户 —— 账号. */
export function IconUser(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="8.2" r="3.6" />
      <path d="M4.8 20a7.2 7.2 0 0 1 14.4 0" />
    </Svg>
  )
}

/** 滑块 —— 设置. */
export function IconSliders(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 7.5h8.5M17.5 7.5H20M4 16.5h3.5M12.5 16.5H20" />
      <circle cx="15" cy="7.5" r="2.4" />
      <circle cx="10" cy="16.5" r="2.4" />
    </Svg>
  )
}

/** 四角展开 —— 全屏. */
export function IconExpand(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M8.5 3.5H6a2.5 2.5 0 0 0-2.5 2.5v2.5M15.5 3.5H18a2.5 2.5 0 0 1 2.5 2.5v2.5M8.5 20.5H6A2.5 2.5 0 0 1 3.5 18v-2.5M15.5 20.5H18a2.5 2.5 0 0 0 2.5-2.5v-2.5" />
    </Svg>
  )
}

/** 收起 —— 退出全屏. */
export function IconCollapse(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3.5 9H6a2.5 2.5 0 0 0 2.5-2.5v-3M20.5 9H18A2.5 2.5 0 0 1 15.5 6.5v-3M3.5 15H6a2.5 2.5 0 0 1 2.5 2.5v3M20.5 15H18a2.5 2.5 0 0 0-2.5 2.5v3" />
    </Svg>
  )
}

/** 关闭 —— ✕. */
export function IconClose(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
    </Svg>
  )
}

/** 勾 —— 成功 / 已连接. */
export function IconCheck(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </Svg>
  )
}

/* ---------------- 灯带 / 硬件 ---------------- */

/** 灯泡 —— LED 灯带入口. */
export function IconBulb(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M9.2 17.5h5.6M10.4 20.5h3.2" />
      <path d="M12 2.8a6.2 6.2 0 0 0-3.6 11.2c.6.5.9 1.1.9 1.8v.7h5.4v-.7c0-.7.3-1.3.9-1.8A6.2 6.2 0 0 0 12 2.8Z" />
    </Svg>
  )
}

/** 芯片 —— ESP32 设备. */
export function IconChip(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="7" y="7" width="10" height="10" rx="2.2" />
      <path d="M10 3.5V7M14 3.5V7M10 17v3.5M14 17v3.5M3.5 10H7M3.5 14H7M17 10h3.5M17 14h3.5" />
    </Svg>
  )
}

/** DIN 插头 —— MIDI 设备. */
export function IconMidi(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="8.6" />
      <path d="M12 6.8h.01M8.9 8.6h.01M15.1 8.6h.01M10.1 11.9h.01M13.9 11.9h.01" />
    </Svg>
  )
}

/** 服务器 —— 树莓派主机. */
export function IconServer(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3" y="4" width="18" height="6.5" rx="2" />
      <rect x="3" y="13.5" width="18" height="6.5" rx="2" />
      <path d="M7 7.2h.01M7 16.8h.01M11 7.2h4M11 16.8h4" />
    </Svg>
  )
}

/** 单条灯带 —— 单灯带模式. */
export function IconStrip(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="2.5" y="9" width="19" height="6" rx="2" />
      <path d="M6.5 12h.01M10.5 12h.01M14.5 12h.01M18.5 12h.01" />
    </Svg>
  )
}

/** 双条灯带 —— 双色带模式. */
export function IconStripDual(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="2.5" y="6" width="19" height="5.5" rx="2" />
      <rect x="2.5" y="12.5" width="19" height="5.5" rx="2" />
      <path d="M6.5 8.7h.01M12 8.7h.01M17.5 8.7h.01M6.5 15.2h.01M12 15.2h.01M17.5 15.2h.01" />
    </Svg>
  )
}

/** 信号波 —— 灯带状态 / 跟随. */
export function IconWave(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M2 12h3l2-6 3 12 3-9 2 6 2-3h5" />
    </Svg>
  )
}

/* ---------------- 输入 / 输出 ---------------- */

/** 键盘 —— 电脑键盘输入. */
export function IconKeyboard(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="2.5" y="6" width="19" height="12" rx="2.5" />
      <path d="M6.5 10h.01M10 10h.01M13.5 10h.01M17 10h.01M6.5 14h.01M17 14h.01M9 14h6" />
    </Svg>
  )
}

/** 收件箱 —— MIDI 输入. */
export function IconInbox(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 13.5h4l1.4 2.6h5.2l1.4-2.6h4" />
      <path d="M5.4 5h13.2l2.4 7v4.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V12z" />
    </Svg>
  )
}

/** 喇叭 —— MIDI 输出. */
export function IconSpeaker(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 9.5h3.5L12 5.5v13L7.5 14.5H4a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1Z" />
      <path d="M15.5 9.2a4 4 0 0 1 0 5.6M18 6.7a7.5 7.5 0 0 1 0 10.6" />
    </Svg>
  )
}

/** 插头 —— 配对 / 连接. */
export function IconPlug(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M9 3v5M15 3v5" />
      <path d="M6.5 8h11v3a5.5 5.5 0 0 1-11 0z" />
      <path d="M12 16.5V21" />
    </Svg>
  )
}

/* ---------------- 文件 / 乐库 ---------------- */

/** 文件夹 —— 文件页. */
export function IconFolder(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3 8a2 2 0 0 1 2-2h3.6L11 8.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </Svg>
  )
}

/** 上传 —— 拖文件进来 / 上传谱子. */
export function IconUpload(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 15.5V3.5m0 0L8 7.5m4-4 4 4" />
      <path d="M3.5 15v3.5a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2V15" />
    </Svg>
  )
}

/** 下载 —— 取谱子. */
export function IconDownload(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 3.5v12m0 0 4-4m-4 4-4-4" />
      <path d="M3.5 16.5v2a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-2" />
    </Svg>
  )
}

/** 列表 —— 我的谱子. */
export function IconList(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M8.5 6.5h12M8.5 12h12M8.5 17.5h12" />
      <path d="M4 6.5h.01M4 12h.01M4 17.5h.01" />
    </Svg>
  )
}

/** 回收站. */
export function IconTrash(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 6.5h16M9.5 6.5v-2a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v2" />
      <path d="M6.5 6.5 7.4 20a1 1 0 0 0 1 .9h7.2a1 1 0 0 0 1-.9l.9-13.5" />
    </Svg>
  )
}

/** 搜索. */
export function IconSearch(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m15.8 15.8 4.4 4.4" />
    </Svg>
  )
}

/* ---------------- 播放控制 ---------------- */

/** 播放 (实心). */
export function IconPlay(props: IconProps) {
  return (
    <Svg {...props} fill="currentColor" stroke="none">
      <path d="M7.5 4.8v14.4a.6.6 0 0 0 .92.5l11-7.2a.6.6 0 0 0 0-1l-11-7.2a.6.6 0 0 0-.92.5Z" />
    </Svg>
  )
}

/** 暂停 (实心). */
export function IconPause(props: IconProps) {
  return (
    <Svg {...props} fill="currentColor" stroke="none">
      <rect x="6" y="4.5" width="4" height="15" rx="1.4" />
      <rect x="14" y="4.5" width="4" height="15" rx="1.4" />
    </Svg>
  )
}

/** 回到开头. */
export function IconRewind(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4.5 9.5A8 8 0 1 1 4 13.2" />
      <path d="M4.5 4.5v5h5" />
    </Svg>
  )
}

/** 重新练习 / 刷新. */
export function IconRefresh(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M20 12a8 8 0 1 1-2.4-5.7" />
      <path d="M20 3.5V9h-5.5" />
    </Svg>
  )
}

/* ---------------- 练习参数 ---------------- */

/** 节拍器. */
export function IconMetronome(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M9.5 3.5h5L18.5 20.5h-13z" />
      <path d="M12 18 16.8 8" />
      <path d="M8.6 14.6h6.8" />
    </Svg>
  )
}

/** 循环 (A-B). */
export function IconRepeat(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m16.5 2.5 4 4-4 4" />
      <path d="M3.5 11.5V10a4 4 0 0 1 4-4h13" />
      <path d="m7.5 21.5-4-4 4-4" />
      <path d="M20.5 12.5V14a4 4 0 0 1-4 4h-13" />
    </Svg>
  )
}

/** 倒计时. */
export function IconTimer(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="13.5" r="7.5" />
      <path d="M12 9.8v3.7l2.4 2.4M9.5 2.5h5" />
    </Svg>
  )
}

/** 速度 (仪表). */
export function IconGauge(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3.5 17.5a9 9 0 1 1 17 0" />
      <path d="m12 17.5 4.2-6.2" />
      <circle cx="12" cy="17.5" r="1.6" />
    </Svg>
  )
}

/** 容差 (靶心). */
export function IconTarget(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="8.2" />
      <circle cx="12" cy="12" r="3.4" />
      <path d="M12 1.8v3.4M12 18.8v3.4M1.8 12h3.4M18.8 12h3.4" />
    </Svg>
  )
}

/** 音量. */
export function IconVolume(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 9.5h3.5L12 5.5v13L7.5 14.5H4a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1Z" />
      <path d="M15.5 9.2a4 4 0 0 1 0 5.6" />
    </Svg>
  )
}

/* ---------------- 状态 / 提示 ---------------- */

/** 警告三角. */
export function IconAlert(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 3.8 21.2 20H2.8z" />
      <path d="M12 9.8v4.4M12 17.4h.01" />
    </Svg>
  )
}

/** 提示圆. */
export function IconInfo(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="8.8" />
      <path d="M12 11v5.2M12 7.9h.01" />
    </Svg>
  )
}

/** 连击火焰. */
export function IconFlame(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 2.8c3 3.4 5.2 5.8 5.2 8.8a5.2 5.2 0 0 1-10.4 0c0-1.5.6-2.9 1.6-3.9.3 1.3 1 2 1.9 2.3-.5-2.6.3-5.2 1.7-7.2Z" />
    </Svg>
  )
}

/** 加载中 (配合 .anim-spin). */
export function IconLoader(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 3.5a8.5 8.5 0 1 0 8.5 8.5" />
    </Svg>
  )
}

/**
 * 双手 (双手练习) —— 一上一下两条反向箭头.
 *
 * 画两只手在 14px 下糊成一团, 改成「双向箭头」: 右手 → / 左手 ← 的合成,
 * 一眼就知道是「两边都弹」.
 */
export function IconBothHands(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3.5 9.2h13M13 6.2l3.2 3-3.2 3" />
      <path d="M20.5 15.4h-13M11 12.4l-3.2 3 3.2 3" />
    </Svg>
  )
}

/** 右箭头 (右手). */
export function IconArrowRight(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3.5 12h16M14 6.5l5.5 5.5-5.5 5.5" />
    </Svg>
  )
}

/** 左箭头 (左手). */
export function IconArrowLeft(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M20.5 12h-16M10 6.5 4.5 12 10 17.5" />
    </Svg>
  )
}

/* ---------------- 箭头 / 方向 ---------------- */

export function IconChevronLeft(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m14.5 6-6 6 6 6" />
    </Svg>
  )
}

export function IconChevronRight(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m9.5 6 6 6-6 6" />
    </Svg>
  )
}

export function IconChevronDown(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m6 9.5 6 6 6-6" />
    </Svg>
  )
}

export function IconPlus(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 5v14M5 12h14" />
    </Svg>
  )
}

export function IconMinus(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M5 12h14" />
    </Svg>
  )
}

/** 铅笔 —— 编辑器 / 改谱入口. */
export function IconEdit(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17v3Z" />
      <path d="M14.5 7.5 17 10" />
    </Svg>
  )
}

/** 剪贴板 —— 复制按钮. */
export function IconCopy(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V6a2 2 0 0 1 2-2h9" />
    </Svg>
  )
}

/** 保存 —— 写回 / 导出. */
export function IconSave(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M5 4h11l3 3v13H5V4Z" />
      <path d="M9 4v5h6V4" />
      <path d="M8 20v-6h8v6" />
    </Svg>
  )
}

/** 下载箭头 —— 导出文件. */
export function IconDownload2(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 4v10" />
      <path d="m8 10 4 4 4-4" />
      <path d="M5 19h14" />
    </Svg>
  )
}

/** 撤销 —— 往左回退的箭头. */
export function IconUndo(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h9a6 6 0 0 1 0 12h-2" />
    </Svg>
  )
}

/** 重做 —— 撤销的镜像. */
export function IconRedo(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m15 14 5-5-5-5" />
      <path d="M20 9h-9a6 6 0 0 0 0 12h2" />
    </Svg>
  )
}

/** 停止 —— 实心方块 (播放的对照组). */
export function IconStop(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor" stroke="none" />
    </Svg>
  )
}

/** 波形 —— 音频 / 试听. */
export function IconSoundWave(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2" />
    </Svg>
  )
}

/** 网格 —— 钢琴卷帘 / 谱面视图. */
export function IconGrid(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
      <path d="M3.5 10h17M3.5 15h17M9.5 4.5v15M15 4.5v15" />
    </Svg>
  )
}

/**
 * 五角星 —— 收藏.
 *
 * filled = 实心 (已收藏, 父级给黄色); 否则描边.
 */
export function IconStar({ filled, ...rest }: IconProps & { filled?: boolean }) {
  return (
    <Svg {...rest} fill={filled ? 'currentColor' : 'none'}>
      <path d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.6 9.7l5.8-.8L12 3.6z" />
    </Svg>
  )
}

/** 链接 —— 分享 (两节链条). */
export function IconShare(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M10.6 13.4a3.8 3.8 0 0 0 5.4 0l2.4-2.4a3.8 3.8 0 0 0-5.4-5.4l-1.2 1.2" />
      <path d="M13.4 10.6a3.8 3.8 0 0 0-5.4 0l-2.4 2.4a3.8 3.8 0 1 0 5.4 5.4l1.2-1.2" />
    </Svg>
  )
}
