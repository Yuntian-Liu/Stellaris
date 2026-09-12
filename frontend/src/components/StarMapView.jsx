/**
 * 版本星图（V1.4.0 · 第 60 版纪念）
 *
 * 60 个版本连成一条有方向的星轨：左下 Nebula（一切的起点）蜿蜒升至右上最新版。
 * 交互：滚轮缩放（指针锚点）· 拖拽平移 · 双击复位 · 右下缩放控制条（−/滑杆/＋/⟲）
 * 版本巡游：点击任意星 → 详情卡 + 上一颗/下一颗，切换时地图平滑飞过去（rAF 缓动）。
 * 自适应详情：放大 ≥1.8x 后补丁星浮现版本号。星点/文字 ÷√k 温和增长（放大 4x = 屏幕大 2x）。
 * 大星 = minor/major（星名只标首颗），小星 = 补丁；位置 mulberry32 确定性抖动，刷新不闪位。
 * 数据：utils/versionStars.json（tmp/gen_version_stars.py 生成，发新版按 SOP 手添一行）。
 *
 * 实现要点：滚轮监听必须 { passive:false } 才能拦页面滚动；巡游动画从 viewRef 读最新视图
 * 起步（而非闭包旧值）；用户滚轮/按下立即 cancelAnimationFrame 接管控制权。
 */
import { useMemo, useRef, useState, useEffect, useCallback } from 'react'
import { ReloadOutlined } from '@ant-design/icons'
import stars from '../utils/versionStars.json'

const VW = 1200, VH = 700
const MIN_K = 1, MAX_K = 6

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const clampK = (k) => Math.min(MAX_K, Math.max(MIN_K, k))

export default function StarMapView() {
  const [view, setView] = useState({ k: 1, x: 0, y: 0 })
  const [tip, setTip] = useState(null)     // hover 浮层（巡游未激活时）
  const [tour, setTour] = useState(null)   // 巡游中的星 index（点击激活）
  // 新手引导（V1.4.0）：首次进入星图自动弹一次，之后点右上 ? 重看
  const [guideOpen, setGuideOpen] = useState(false)
  useEffect(() => {
    if (!localStorage.getItem('stellaris_starmap_guide_v1')) setGuideOpen(true)
  }, [])
  const closeGuide = () => {
    localStorage.setItem('stellaris_starmap_guide_v1', '1')
    setGuideOpen(false)
  }
  const svgRef = useRef(null)
  const drag = useRef(null)
  const dragMoved = useRef(false)
  const rafRef = useRef(null)
  const viewRef = useRef(view)
  useEffect(() => { viewRef.current = view }, [view])
  useEffect(() => () => { if (rafRef.current) cancelAnimationFrame(rafRef.current) }, [])

  const current = stars[stars.length - 1]

  // 星轨：S 形主轨迹铺满画面 + 确定性抖动；首尾两颗锚定不抖（起点/当下要有仪式感）
  const pts = useMemo(() => stars.map((s, i) => {
    const t = i / (stars.length - 1)
    const rnd = mulberry32(i * 1000 + 7)
    const anchor = i === 0 || i === stars.length - 1
    return {
      ...s, i,
      x: 70 + t * 1060 + (anchor ? 0 : (rnd() - 0.5) * 80),
      y: 600 - t * 490 + Math.sin(t * Math.PI * 2.2) * 96 + (anchor ? 0 : (rnd() - 0.5) * 64),
    }
  }), [])

  // 背景背景星点（纯装饰，不随缩放平移——当星空底布）
  const dust = useMemo(() => {
    const rnd = mulberry32(999)
    return Array.from({ length: 90 }, (_, i) => ({
      x: rnd() * VW, y: rnd() * VH,
      r: 0.6 + rnd() * 1.1, o: 0.15 + rnd() * 0.35, d: (i * 0.23) % 4,
    }))
  }, [])

  const path = pts.map((p) => `${p.x},${p.y}`).join(' ')

  const stopAnim = () => {
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null }
  }

  // 视图平滑飞行（巡游/控制条共用）：三次缓动，用户接管即中断
  const animateView = useCallback((target, dur = 650) => {
    stopAnim()
    const from = { ...viewRef.current }
    const t0 = performance.now()
    const tick = (now) => {
      const t = Math.min(1, (now - t0) / dur)
      const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
      setView({
        k: from.k + (target.k - from.k) * e,
        x: from.x + (target.x - from.x) * e,
        y: from.y + (target.y - from.y) * e,
      })
      rafRef.current = t < 1 ? requestAnimationFrame(tick) : null
    }
    rafRef.current = requestAnimationFrame(tick)
  }, [])

  // 以某锚点（屏幕坐标）为不动点缩放到 k2
  const zoomAt = useCallback((k2, ax, ay, dur = 260) => {
    const v = viewRef.current
    const k = clampK(k2)
    animateView({
      k,
      x: ax - ((ax - v.x) / v.k) * k,
      y: ay - ((ay - v.y) / v.k) * k,
    }, dur)
  }, [animateView])

  // 巡游：飞到第 i 颗星（居中 + 至少 2.4x）并展开详情卡
  const goTour = useCallback((i) => {
    const p = pts[i]
    if (!p) return
    setTour(i)
    setTip(null)
    const k = Math.max(viewRef.current.k, 2.4)
    animateView({ k, x: VW / 2 - p.x * k, y: VH / 2 - p.y * k })
  }, [pts, animateView])

  const resetView = useCallback(() => {
    setTour(null)
    animateView({ k: 1, x: 0, y: 0 })
  }, [animateView])

  // 滚轮缩放：React 的 onWheel 是 passive 拦不住页面滚动，必须原生非 passive 监听
  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const onWheel = (e) => {
      e.preventDefault()
      stopAnim()
      const rect = svg.getBoundingClientRect()
      const sx = ((e.clientX - rect.left) / rect.width) * VW
      const sy = ((e.clientY - rect.top) / rect.height) * VH
      setView((v) => {
        const k = clampK(v.k * (e.deltaY < 0 ? 1.18 : 1 / 1.18))
        const wx = (sx - v.x) / v.k
        const wy = (sy - v.y) / v.k
        return { k, x: sx - wx * k, y: sy - wy * k }
      })
    }
    svg.addEventListener('wheel', onWheel, { passive: false })
    return () => svg.removeEventListener('wheel', onWheel)
  }, [])

  const toSvg = useCallback((e) => {
    const rect = svgRef.current.getBoundingClientRect()
    return {
      x: ((e.clientX - rect.left) / rect.width) * VW,
      y: ((e.clientY - rect.top) / rect.height) * VH,
    }
  }, [])

  const onPointerDown = (e) => {
    stopAnim()
    const p = toSvg(e)
    drag.current = { sx: p.x, sy: p.y, vx: view.x, vy: view.y }
    dragMoved.current = false
    setTip(null)
  }
  const onPointerMove = (e) => {
    const d = drag.current
    if (!d) return
    const p = toSvg(e)
    const dx = p.x - d.sx
    const dy = p.y - d.sy
    if (Math.abs(dx) + Math.abs(dy) > 4) {
      if (!dragMoved.current) {
        dragMoved.current = true
        // 此刻才捕获指针：pointerdown 就捕获会把 click 事件也重定向到 svg 根元素，
        // 星星的 onClick（巡游）永远收不到——点击/拖拽分流的关键就在这里
        try { svgRef.current.setPointerCapture(e.pointerId) } catch { /* 忽略 */ }
      }
      setView((v) => ({ ...v, x: d.vx + dx, y: d.vy + dy }))
    }
  }
  const onPointerUp = () => { drag.current = null }

  // hover 浮层定位：世界坐标 → 当前视图 → 容器百分比；永远悬在星点正上方
  // （偏移 = 热区屏幕半径 + 10px，任何缩放级别都不遮挡鼠标所指的星），太靠顶翻下方；
  // 水平方向钳制在面板内（贴边星点的浮层不会被 overflow 裁掉）
  const tipPos = tip && (() => {
    const sx = tip.x * view.k + view.x
    const sy = tip.y * view.k + view.y
    return {
      left: `${(Math.min(Math.max(sx, 135), VW - 135) / VW) * 100}%`,
      top: `${(sy / VH) * 100}%`,
      off: 14 * Math.sqrt(view.k) + 10,
      // 浮层高度约 110-130px：上方空间不足时翻下方（阈值 110 估小了会顶边溢出）
      above: sy > 170,
    }
  })()

  const zoomed = view.k >= 1.8   // 自适应详情阈值：放大后补丁星显示版本号
  const tourStar = tour != null ? pts[tour] : null
  // 控制条滑杆：对数映射（1..6 倍）
  const sliderVal = Math.round((Math.log(view.k) / Math.log(MAX_K)) * 100)

  const btnStyle = {
    background: 'none', border: 'none', color: 'rgba(255,255,255,0.75)',
    fontSize: 15, cursor: 'pointer', padding: '0 4px', lineHeight: 1,
  }

  return (
    <div style={{
      position: 'relative',
      height: 'calc(100vh - 190px)',
      minHeight: 420,
      borderRadius: 16,
      overflow: 'hidden',
      background: 'linear-gradient(160deg, #0a0e27 0%, #151b3d 100%)',
      border: '1px solid rgba(255,255,255,0.08)',
    }}>
      <style>{`
        @keyframes star-twinkle { 0%,100% { opacity: 1 } 50% { opacity: 0.35 } }
        @keyframes star-pulse { 0% { transform: scale(1); opacity: 0.7 } 100% { transform: scale(2.6); opacity: 0 } }
        .starmap-svg { touch-action: none; cursor: grab; }
        .starmap-svg:active { cursor: grabbing; }
      `}</style>

      {/* 标题（叠在夜空上） */}
      <div style={{
        position: 'absolute', top: 22, left: 28, zIndex: 2, pointerEvents: 'none',
      }}>
        <div className="font-display" style={{ fontSize: 20, color: 'rgba(255,255,255,0.92)', letterSpacing: '0.04em' }}>
          从 {stars[0].name} 到{current.name || '下一颗星'}
        </div>
        <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.45)', marginTop: 4 }}>
          60 个版本 · 一条星轨 · 点击星点开启巡游
        </div>
      </div>

      <svg
        ref={svgRef}
        className="starmap-svg"
        viewBox={`0 0 ${VW} ${VH}`}
        style={{ width: '100%', height: '100%', display: 'block' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={resetView}
        onClick={() => { if (!dragMoved.current) { setTip(null); setTour(null) } }}
      >
        <defs>
          <radialGradient id="star-glow">
            <stop offset="0%" stopColor="#c7d2fe" stopOpacity="0.55" />
            <stop offset="100%" stopColor="#c7d2fe" stopOpacity="0" />
          </radialGradient>
        </defs>

        {/* 背景星点底布（固定不动） */}
        {dust.map((d, i) => (
          <circle key={`d${i}`} cx={d.x} cy={d.y} r={d.r} fill="#fff" opacity={d.o}
            style={{ animation: `star-twinkle 4s ease-in-out ${d.d}s infinite` }} />
        ))}

        {/* 星轨世界（缩放/平移都作用在这一层） */}
        <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
          <polyline points={path} fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth={1.2 / view.k} />

          {pts.map((p) => {
            const minor = p.level === 'minor'
            // 星名标注：同名星只标该星名的第一颗（一串补丁共用一颗恒星名）
            const showName = minor && (p.i === 0 || stars[p.i - 1].name !== p.name)
            // 温和增长：星点/光晕/热区/文字 ÷√k——放大 4x 屏幕大 2x，有"靠近"感又永远锐利
            const k = view.k
            const ks = Math.sqrt(k)
            const active = tour === p.i
            return (
              <g key={p.v}>
                {minor && (
                  <circle cx={p.x} cy={p.y} r={16 / ks} fill="url(#star-glow)" pointerEvents="none" />
                )}
                {p.current && (
                  <circle cx={p.x} cy={p.y} r={9 / ks} fill="none" stroke="#a5b4fc" strokeWidth={1.5 / ks}
                    style={{ transformOrigin: `${p.x}px ${p.y}px`, animation: 'star-pulse 2.2s ease-out infinite' }} />
                )}
                {/* 巡游中的星：常亮光环标记 */}
                {active && (
                  <circle cx={p.x} cy={p.y} r={11 / ks} fill="none" stroke="rgba(224,231,255,0.85)"
                    strokeWidth={1.5 / ks} pointerEvents="none" />
                )}
                {/* 可见星点 */}
                <circle
                  cx={p.x} cy={p.y}
                  r={(minor ? 5 : 2.5) / ks}
                  fill={p.current ? '#e0e7ff' : minor ? '#c7d2fe' : 'rgba(255,255,255,0.85)'}
                  opacity={0.95}
                  pointerEvents="none"
                  style={{ animation: `star-twinkle ${3.4 + (p.i % 5) * 0.4}s ease-in-out ${(p.i * 0.37) % 4}s infinite` }}
                />
                {/* 透明大热区：小星只有 2.5 半径根本戳不中，热区统一 14（随缩放补偿） */}
                <circle
                  cx={p.x} cy={p.y} r={14 / ks}
                  fill="transparent"
                  style={{ cursor: 'pointer' }}
                  onMouseEnter={() => { if (tour == null) setTip(p) }}
                  onMouseLeave={() => setTip(null)}
                  onClick={(e) => { e.stopPropagation(); if (!dragMoved.current) goTour(p.i) }}
                />
                {showName && (
                  <text x={p.x} y={p.y + 20 / ks} textAnchor="middle"
                    fill="rgba(255,255,255,0.6)" fontSize={12.5 / ks}
                    fontFamily="'Cormorant Garamond', serif" fontStyle="italic"
                    pointerEvents="none">
                    {p.name}
                  </text>
                )}
                {/* 自适应详情：放大后补丁星显示版本号 */}
                {zoomed && !minor && (
                  <text x={p.x} y={p.y + 14 / ks} textAnchor="middle"
                    fill="rgba(255,255,255,0.45)" fontSize={10 / ks}
                    pointerEvents="none">
                    {p.v}
                  </text>
                )}
                {p.i === 0 && (
                  <text x={p.x} y={p.y + 38 / ks} textAnchor="middle"
                    fill="rgba(255,255,255,0.4)" fontSize={11 / ks} pointerEvents="none">
                    一切的起点
                  </text>
                )}
                {p.current && (
                  <text x={p.x} y={p.y - 24 / ks} textAnchor="middle"
                    fill="#c7d2fe" fontSize={12 / ks} pointerEvents="none">
                    你在这里
                  </text>
                )}
              </g>
            )
          })}
        </g>
      </svg>

      {/* hover 浮层（巡游未激活时）：快速一瞥 */}
      {tip && tipPos && tour == null && (
        <div style={{
          position: 'absolute',
          left: tipPos.left,
          top: tipPos.top,
          transform: tipPos.above
            ? `translate(-50%, calc(-100% - ${tipPos.off}px))`
            : `translate(-50%, ${tipPos.off}px)`,
          background: 'rgba(13,18,45,0.92)',
          border: '1px solid rgba(165,180,252,0.25)',
          borderRadius: 10,
          padding: '10px 14px',
          maxWidth: 240,
          pointerEvents: 'none',
          zIndex: 3,
          backdropFilter: 'blur(6px)',
        }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#e0e7ff' }}>
            {tip.v}{tip.name ? ` · ${tip.name}` : ''}
          </div>
          <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)', marginTop: 2 }}>
            {tip.date || '即将发布'} · {tip.level === 'minor' ? '版本更新' : '补丁'}
          </div>
          {tip.gist && (
            <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.75)', marginTop: 6, lineHeight: 1.6 }}>
              {tip.gist}
            </div>
          )}
        </div>
      )}

      {/* 巡游详情卡（点击星点激活）：上一颗/下一颗带地图飞过去 */}
      {tourStar && (
        <div style={{
          position: 'absolute', left: 24, bottom: 46, zIndex: 3, width: 264,
          background: 'rgba(13,18,45,0.92)',
          border: '1px solid rgba(165,180,252,0.28)',
          borderRadius: 12, padding: '12px 14px',
          backdropFilter: 'blur(6px)',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: '#e0e7ff' }}>
              {tourStar.v}{tourStar.name ? ` · ${tourStar.name}` : ''}
            </div>
            <button onClick={() => setTour(null)} style={{ ...btnStyle, fontSize: 13, opacity: 0.6 }}>✕</button>
          </div>
          <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)', marginTop: 2 }}>
            {tourStar.date || '即将发布'} · {tourStar.level === 'minor' ? '版本更新' : '补丁'} · 第 {tour + 1} / {pts.length} 颗
          </div>
          {tourStar.gist && (
            <div style={{ fontSize: 12.5, color: 'rgba(255,255,255,0.8)', marginTop: 8, lineHeight: 1.7 }}>
              {tourStar.gist}
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 12 }}>
            <button
              disabled={tour === 0}
              onClick={() => goTour(tour - 1)}
              style={{ ...btnStyle, fontSize: 12, opacity: tour === 0 ? 0.3 : 1 }}
            >‹ 上一颗</button>
            <button
              disabled={tour === pts.length - 1}
              onClick={() => goTour(tour + 1)}
              style={{ ...btnStyle, fontSize: 12, opacity: tour === pts.length - 1 ? 0.3 : 1 }}
            >下一颗 ›</button>
          </div>
        </div>
      )}

      {/* 图例（左下） */}
      <div style={{
        position: 'absolute', bottom: 16, left: 28, zIndex: 2, pointerEvents: 'none',
        fontSize: 11, color: 'rgba(255,255,255,0.35)',
      }}>
        大星 = 版本更新 · 小星 = 补丁 · 2026-07-15 → 今
      </div>

      {/* 玩法说明常驻入口（右上 ?） */}
      <button
        onClick={() => setGuideOpen(true)}
        title="星图玩法说明"
        style={{
          position: 'absolute', top: 18, right: 24, zIndex: 2,
          width: 30, height: 30, borderRadius: '50%',
          background: 'rgba(13,18,45,0.72)', border: '1px solid rgba(165,180,252,0.3)',
          color: 'rgba(255,255,255,0.7)', cursor: 'pointer', fontSize: 14,
        }}
      >?</button>

      {/* 缩放控制条（右下）：− / 滑杆（对数映射）/ ＋ / 复位 */}
      <div style={{
        position: 'absolute', bottom: 12, right: 24, zIndex: 2,
        display: 'flex', alignItems: 'center', gap: 8,
        background: 'rgba(13,18,45,0.72)', border: '1px solid rgba(165,180,252,0.2)',
        borderRadius: 9999, padding: '6px 12px', backdropFilter: 'blur(6px)',
      }}>
        <button style={btnStyle} title="缩小"
          onClick={() => zoomAt(viewRef.current.k / 1.35, VW / 2, VH / 2)}>−</button>
        <input
          type="range" min={0} max={100} value={sliderVal}
          onChange={(e) => {
            stopAnim()
            const k = Math.exp((Number(e.target.value) / 100) * Math.log(MAX_K))
            const v = viewRef.current
            setView({
              k,
              x: VW / 2 - ((VW / 2 - v.x) / v.k) * k,
              y: VH / 2 - ((VH / 2 - v.y) / v.k) * k,
            })
          }}
          style={{ width: 104, accentColor: '#a5b4fc', cursor: 'pointer' }}
        />
        <button style={btnStyle} title="放大"
          onClick={() => zoomAt(viewRef.current.k * 1.35, VW / 2, VH / 2)}>＋</button>
        <button style={{ ...btnStyle, fontSize: 13, display: 'inline-flex', alignItems: 'center' }} title="复位"
          onClick={resetView}><ReloadOutlined /></button>
      </div>

      {/* 新手引导（首次进入自动弹一次；点右上 ? 重看）：星图的设计与玩法 */}
      {guideOpen && (
        <div
          onClick={closeGuide}
          style={{
            position: 'absolute', inset: 0, zIndex: 10,
            background: 'rgba(6,9,26,0.72)', backdropFilter: 'blur(4px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: 420, maxWidth: '88%',
              background: 'rgba(21,27,61,0.98)',
              border: '1px solid rgba(165,180,252,0.28)',
              borderRadius: 16, padding: '24px 26px 20px',
              color: 'rgba(255,255,255,0.85)',
            }}
          >
            <div className="font-display" style={{ fontSize: 20, color: '#e0e7ff', marginBottom: 4 }}>
              ✦ 版本星图
            </div>
            <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.45)', marginBottom: 16 }}>
              纪念 Stellaris 的第 60 个版本
            </div>

            <div style={{ fontSize: 13, lineHeight: 2.0 }}>
              <div><b style={{ color: '#e0e7ff' }}>读法</b>　每一颗星是一次发布：<b style={{ color: '#e0e7ff' }}>大星</b>是版本更新，<b style={{ color: '#e0e7ff' }}>小星</b>是补丁。左下角的 Nebula 是一切的起点，右上角最新的一颗——你在这里。</div>
              <div style={{ marginTop: 10 }}><b style={{ color: '#e0e7ff' }}>漫游</b>　滚轮缩放、拖拽平移、双击复位（右下角也有控制条）。</div>
              <div style={{ marginTop: 10 }}><b style={{ color: '#e0e7ff' }}>细看</b>　悬停任意星点看版本摘要；放大后补丁星会浮现版本号。</div>
              <div style={{ marginTop: 10 }}><b style={{ color: '#e0e7ff' }}>巡游</b>　点击星点进入巡游模式，「下一颗」带你沿星轨从 Nebula 一颗一颗走到今天。</div>
            </div>

            <div style={{
              marginTop: 16, padding: '8px 12px',
              background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.25)',
              borderRadius: 10, fontSize: 12, color: 'rgba(253,230,138,0.9)', lineHeight: 1.7,
            }}>
              星图是第 60 版的纪念限定产物，后续是否长期保留视运营情况决定。
            </div>

            <button
              onClick={closeGuide}
              style={{
                marginTop: 18, width: '100%', padding: '10px 0',
                background: '#4f46e5', border: 'none', borderRadius: 10,
                color: '#fff', fontSize: 14, fontWeight: 500, cursor: 'pointer',
              }}
            >
              开始探索
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
