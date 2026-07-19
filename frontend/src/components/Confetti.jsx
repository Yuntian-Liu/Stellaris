/**
 * 撒花效果 — 纯 CSS keyframes,零依赖(搬 Datelife 思路,React 化)
 * fixed 全屏覆盖,pointerEvents:none 不挡交互
 */
const COLORS = ['#4f46e5', '#818cf8', '#22c55e', '#f59e0b', '#ec4899', '#06b6d4', '#a855f7', '#ef4444']

export default function Confetti() {
  return (
    <div aria-hidden style={{
      position: 'fixed', inset: 0, overflow: 'hidden',
      pointerEvents: 'none', zIndex: 1000,
    }}>
      {Array.from({ length: 40 }).map((_, i) => (
        <span key={i} style={{
          position: 'absolute',
          left: `${(i * 2.5) % 100}%`,
          top: '-20px',
          width: 8 + (i % 3) * 2,
          height: 12 + (i % 3) * 3,
          background: COLORS[i % COLORS.length],
          borderRadius: 2,
          animation: `confettiFall ${2.5 + (i % 3) * 0.5}s ease-in ${(i % 10) * 0.12}s infinite`,
        }} />
      ))}
      <style>{`
        @keyframes confettiFall {
          0% { transform: translateY(0) rotate(0deg); opacity: 1; }
          80% { opacity: 1; }
          100% { transform: translateY(100vh) rotate(720deg); opacity: 0; }
        }
        @media (prefers-reduced-motion: reduce) {
          @keyframes confettiFall { 0%, 100% { opacity: 0; } }
        }
      `}</style>
    </div>
  )
}
