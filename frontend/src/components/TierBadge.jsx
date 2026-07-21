/**
 * 档位徽章 — 彩色胶囊（头像下拉 / 设置页 / 会员卡角标共用）
 */
import { tierMeta } from '../utils/tier'

export default function TierBadge({ tier, style }) {
  const m = tierMeta(tier)
  return (
    <span style={{
      fontSize: 11, fontWeight: 500,
      color: m.color, background: m.bg,
      borderRadius: 9999, padding: '1px 8px',
      whiteSpace: 'nowrap',
      ...style,
    }}>
      {m.label}
    </span>
  )
}
