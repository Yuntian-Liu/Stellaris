/**
 * 头像步 — DiceBear 9 宫格随机头像 + 换一批
 * 风格 STYLE 待碳碳定(候选 lorelei / notionists / adventurer),改这一处即可
 */
import { useState } from 'react'
import { Button } from 'antd'
import { avatarUrl } from '../../utils/avatar'

const STYLE = 'micah'

function randomSeed() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let s = ''
  for (let i = 0; i < 8; i++) s += chars[Math.floor(Math.random() * chars.length)]
  return s
}


export default function AvatarStep({ onSelect, onBack }) {
  const [pool, setPool] = useState(() => Array.from({ length: 9 }, () => randomSeed()))
  const [selected, setSelected] = useState(null)

  const regenerate = () => {
    setPool(Array.from({ length: 9 }, () => randomSeed()))
    setSelected(null)
  }

  return (
    <div className="page-enter" style={{ maxWidth: 380, margin: '0 auto' }}>
      <h2 className="font-display font-display-sm" style={{ marginBottom: 8 }}>选择头像</h2>
      <p className="font-caption" style={{ marginBottom: 20 }}>挑一个喜欢的,或换一批重新生成</p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 16 }}>
        {pool.map((seed, i) => (
          <div
            key={seed + i}
            onClick={() => setSelected(seed)}
            style={{
              cursor: 'pointer', borderRadius: 12, padding: 4,
              border: selected === seed ? '2px solid var(--accent)' : '2px solid var(--hairline)',
              background: selected === seed ? 'var(--accent-light)' : 'var(--surface-1)',
              transition: 'all 0.15s ease',
            }}
          >
            <img src={avatarUrl(seed)} alt="头像" style={{ width: '100%', display: 'block', borderRadius: 8 }} />
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
        <Button onClick={onBack}>返回</Button>
        <Button onClick={regenerate} style={{ flex: 1 }}>换一批</Button>
      </div>
      <Button type="primary" size="large" block disabled={!selected} onClick={() => onSelect(selected)}>
        下一步
      </Button>
    </div>
  )
}
