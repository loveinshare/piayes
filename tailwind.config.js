/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#0f1014',
        panel: '#1a1c23',
        raised: '#22252d',      // 卡片 / 输入框 / 进度条轨道 (比 panel 亮一档)
        border: '#2a2c35',
        borderStrong: '#3a3c45', // hover 边框 / 描边控件
        track: '#3a3c45',       // range 轨道 (必须在 panel 上可见)
        text: '#e5e7eb',
        muted: '#9ca3af',
        subtle: '#8b8f9a',      // 辅助说明文字
        accent: '#60a5fa',
        good: '#a78bfa',       // 良好 (介于命中绿和错过红之间, 一眼能分开)
        left: '#60a5fa',   // 左手 - 蓝
        right: '#ef4444',  // 右手 - 红
        hit: '#22c55e',    // 命中 - 绿
        miss: '#ef4444',   // 错过 - 红
      },
    },
  },
  plugins: [],
}
