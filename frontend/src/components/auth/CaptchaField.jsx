/**
 * 图形验证码小组件（V1.2.2 自托管，替代 TurnstileField）
 * 生产：拉 /api/captcha 显示图片 + 输入框 + 刷新；非生产：自动 bypass 并显示提示
 * 用法：<CaptchaField onChange={(v) => setCaptcha(v)} refreshKey={n} />
 *   - onChange({ captchaId, answer }) 填了答案回传对象，否则回传 null
 *   - refreshKey 变化时重新生成（提交失败后父组件 ++，因为票据一次性已消耗）
 */
import { useState, useEffect, useCallback, useRef } from 'react'
import { Input, Button } from 'antd'
import { ReloadOutlined } from '@ant-design/icons'

export default function CaptchaField({ onChange, refreshKey = 0 }) {
  const [captcha, setCaptcha] = useState(null)  // {captcha_id, image}
  const [answer, setAnswer] = useState('')
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const genRef = useRef(0)   // 竞态防护：过期响应丢弃（Codex 06）
  // 本机联调（IS_PROD=true 时）：显示跳过入口；后端按 socket peer 判定，外网不可伪造
  const isLocal = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(window.location.hostname)

  const load = useCallback(async () => {
    const gen = ++genRef.current
    setLoading(true)
    setFailed(false)
    setAnswer('')
    onChange?.(null)
    try {
      const cfgRes = await fetch('/api/config')
      if (!cfgRes.ok) throw new Error(`config ${cfgRes.status}`)   // 500 不得误判为 dev bypass（Codex 06）
      const cfg = await cfgRes.json()
      if (cfg.is_prod === false) {
        // 开发模式：后端 IS_PROD=false 直接 bypass，值只是占位
        setCaptcha(null)
        onChange?.({ captchaId: null, answer: 'dev-bypass' })
        return
      }
      const r = await fetch('/api/captcha')
      if (!r.ok) throw new Error(`captcha ${r.status}`)
      const data = await r.json()
      if (gen !== genRef.current) return   // 已有更新的挑战，丢弃
      setCaptcha(data)
    } catch {
      // Codex 03 棒：加载失败给可读错误，不静默伪装成 bypass
      if (gen !== genRef.current) return
      setCaptcha(null)
      setFailed(true)
    } finally {
      if (gen === genRef.current) setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => { load() }, [load, refreshKey])

  const handleAnswer = (v) => {
    setAnswer(v)
    if (!captcha) return
    const a = v.trim()
    onChange?.(a ? { captchaId: captcha.captcha_id, answer: a } : null)
  }

  // 非生产：无图，显示提示
  if (!loading && !captcha && !failed) {
    return (
      <div style={{ marginBottom: 12, fontSize: 12, color: 'var(--mute)', textAlign: 'center' }}>
        开发模式：已跳过人机验证
      </div>
    )
  }

  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <Input
          size="large"
          placeholder={captcha ? '输入图中 4 位字符' : '验证码'}
          value={answer}
          onChange={e => handleAnswer(e.target.value)}
          maxLength={6}
          disabled={!captcha}
          style={{ flex: 1 }}
        />
        {captcha && (
          <img
            src={captcha.image}
            alt="验证码"
            title="看不清？点击刷新"
            onClick={load}
            style={{
              height: 40, borderRadius: 8, cursor: 'pointer', flexShrink: 0,
              border: '1px solid var(--hairline)',
            }}
          />
        )}
        <Button
          size="large"
          icon={<ReloadOutlined />}
          onClick={load}
          loading={loading}
          title="刷新验证码"
          style={{ flexShrink: 0 }}
        />
      </div>
      {failed && (
        <div style={{ fontSize: 12, color: 'var(--error)', marginTop: 6 }}>
          验证码加载失败，点击右侧刷新重试
        </div>
      )}
      {isLocal && (
        <div style={{ textAlign: 'center', marginTop: 4 }}>
          <a
            style={{ fontSize: 12, color: 'var(--mute)' }}
            onClick={() => onChange?.({ captchaId: null, answer: 'dev-bypass' })}
          >
            开发模式：跳过验证
          </a>
        </div>
      )}
    </div>
  )
}
