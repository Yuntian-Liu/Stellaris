/**
 * 注册成功步 — 撒花 + UID 大字 + "第 X 位用户" + 开始使用
 */
import { Button } from 'antd'
import Confetti from '../Confetti'

export default function SuccessStep({ user, onDone }) {
  const userNumber = user.uid - 99999  // 从 100000 起,所以第 N 位 = uid - 99999

  return (
    <div className="page-enter" style={{ maxWidth: 380, margin: '0 auto', textAlign: 'center' }}>
      <Confetti />

      <div style={{ fontSize: 48, marginBottom: 8 }}>🎉</div>
      <h1 className="font-display font-display-md" style={{ marginBottom: 8 }}>注册成功</h1>
      <p className="font-caption" style={{ marginBottom: 24 }}>欢迎来到 Stellaris,把声音变成文字</p>

      <div style={{
        background: 'linear-gradient(135deg, var(--accent-light), #e0e7ff)',
        border: '1px solid var(--hairline)', borderRadius: 16,
        padding: '28px 16px', marginBottom: 24,
      }}>
        <div className="font-caption" style={{ marginBottom: 8 }}>你的 UID</div>
        <div className="font-mono" style={{
          fontSize: 40, fontWeight: 700, color: 'var(--accent)', letterSpacing: 4,
        }}>
          {user.uid}
        </div>
        <div className="font-caption" style={{ marginTop: 10 }}>
          你是第 <strong style={{ color: 'var(--accent)' }}>{userNumber}</strong> 位 Stellaris 用户
        </div>
      </div>

      <Button type="primary" size="large" block onClick={onDone}>开始使用</Button>
    </div>
  )
}
