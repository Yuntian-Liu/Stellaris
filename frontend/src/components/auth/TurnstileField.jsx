/**
 * Turnstile 人机验证小组件（可复用）
 * 生产渲染 widget，开发模式自动 bypass。
 * 用法：<TurnstileField onToken={setToken} />，token 变化经 onToken(null|string) 回传
 */
import { useState, useEffect, useRef } from 'react'

// 复用 EmailStep 的脚本就绪通知机制(index.html 内联壳 + api.js?onload=__turnstileReady)
// 组件只读 __turnstileLoaded、只写 __turnstileOnLoad,不碰 __turnstileReady 壳
window.__turnstileLoaded = window.__turnstileLoaded || false

export default function TurnstileField({ onToken }) {
  const [pubConfig, setPubConfig] = useState(null)
  const containerRef = useRef(null)
  const widgetId = useRef(null)
  // 本机开发时显示"跳过验证"（后端对本机 IP 的 dev-bypass 直接放行）
  const isLocal = ['localhost', '127.0.0.1'].includes(window.location.hostname)

  useEffect(() => {
    fetch('/api/config').then(r => r.json()).then(c => {
      setPubConfig(c)
      if (!c.is_prod) onToken('dev-bypass')
    }).catch(() => onToken('dev-bypass'))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!pubConfig?.is_prod || !pubConfig.turnstile_site_key) return
    let cancelled = false
    const doRender = () => {
      if (cancelled || !window.turnstile || !containerRef.current || widgetId.current !== null) return
      widgetId.current = window.turnstile.render(containerRef.current, {
        sitekey: pubConfig.turnstile_site_key,
        appearance: 'always',   // 立即显示,不智能延迟
        callback: (t) => onToken(t),
        'expired-callback': () => onToken(null),
        'error-callback': () => onToken(null),
      })
    }
    if (window.__turnstileLoaded) {
      doRender()
    } else {
      window.__turnstileOnLoad = doRender
    }
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pubConfig])

  if (!pubConfig?.is_prod) return null
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'center' }}>
        <div ref={containerRef} style={{ minHeight: 65 }} />
      </div>
      {isLocal && (
        <div style={{ textAlign: 'center', marginTop: 4 }}>
          <a style={{ fontSize: 12, color: 'var(--mute)' }} onClick={() => onToken('dev-bypass')}>
            开发模式：跳过验证
          </a>
        </div>
      )}
    </div>
  )
}
