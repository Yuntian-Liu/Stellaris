/**
 * 流星雨彩蛋 — 连点 logo ✦ 7 次触发
 * 全屏安静的流星划过（约 4s），纯 CSS，pointerEvents:none 不挡交互
 * 触发/卸载由 App.jsx 控制
 */

const METEORS = Array.from({ length: 14 }, (_, i) => ({
  top: `${(i * 7.3) % 55}%`,                    // 分布在上半屏
  left: `${35 + ((i * 11.7) % 65)}%`,           // 从右侧滑向左下
  delay: `${(i % 7) * 0.45}s`,
  duration: `${0.9 + (i % 3) * 0.35}s`,
  size: 1.5 + (i % 3) * 0.6,
}))

export default function MeteorShower() {
  return (
    <div aria-hidden style={{
      position: 'fixed', inset: 0, overflow: 'hidden',
      pointerEvents: 'none', zIndex: 1000,
    }}>
      {METEORS.map((m, i) => (
        <div key={i} style={{
          position: 'absolute',
          top: m.top,
          left: m.left,
          width: 90 * m.size,
          height: m.size,
          borderRadius: 9999,
          background: 'linear-gradient(90deg, rgba(129,140,248,0) 0%, #c7d2fe 55%, #ffffff 100%)',
          filter: 'drop-shadow(0 0 4px rgba(165,180,252,0.8))',
          transform: 'rotate(-38deg)',
          transformOrigin: 'right center',
          opacity: 0,
          animation: `meteorFly ${m.duration} ease-out ${m.delay} forwards`,
        }} />
      ))}
      <style>{`
        @keyframes meteorFly {
          0%   { opacity: 0; transform: rotate(-38deg) translateX(0) scaleX(0.3); }
          12%  { opacity: 1; }
          100% { opacity: 0; transform: rotate(-38deg) translateX(-52vw) scaleX(1); }
        }
        @media (prefers-reduced-motion: reduce) {
          @keyframes meteorFly { 0%, 100% { opacity: 0; } }
        }
      `}</style>
    </div>
  )
}
