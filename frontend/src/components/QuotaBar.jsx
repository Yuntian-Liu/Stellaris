/**
 * QuotaBar — 配额进度条（V1.1.3 文件柜起用；用户版内测复用）
 *
 * 视觉定稿（碳碳 2026-08-11）：
 *   - 无限额（管理员）：浅 indigo 渐变满条 + ∞（沿用 BillingPills 不限量语义）
 *   - 有限额分档变色：0 用量灰 / >0~50% 绿 / 50~80% 品牌蓝紫 / >80% 红
 *   - 文字随条同色；紧凑单行（标签 + 条 + 用量文字）
 */
import { Progress } from 'antd'

const INF = (
  <span style={{ fontFamily: 'Georgia, "Times New Roman", serif', fontSize: 14, lineHeight: 1 }}>∞</span>
)

function fmtMB(bytes) {
  const mb = bytes / 1024 / 1024
  return mb < 0.01 && bytes > 0 ? '<0.01' : mb.toFixed(2).replace(/\.?0+$/, '')
}

/** 用量比例 → 档位色（碳碳定：0 灰 / 低绿 / 中蓝紫 / 将满红） */
function stageColor(ratio) {
  if (ratio <= 0) return '#c9cdd6'          // 未使用：灰白
  if (ratio <= 0.5) return '#34c98e'        // 较少：绿
  if (ratio <= 0.8) return 'var(--accent)'  // 一般：品牌蓝紫
  return '#f0605e'                          // 快满：红
}

export default function QuotaBar({ usedBytes, quotaMb, width = 160 }) {
  // 无限额（管理员）：浅 indigo 渐变满条表"无界"
  if (quotaMb === null || quotaMb === undefined) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
        <span style={{ width }}>
          <Progress
            percent={100}
            showInfo={false}
            size="small"
            strokeColor={{ '0%': '#c7d2fe', '100%': '#a5b4fc' }}
          />
        </span>
        <span className="font-mono" style={{ fontSize: 12, color: 'var(--mute)', whiteSpace: 'nowrap' }}>
          {fmtMB(usedBytes)} MB / {INF}
        </span>
      </span>
    )
  }

  const quotaBytes = quotaMb * 1024 * 1024
  const ratio = quotaBytes > 0 ? usedBytes / quotaBytes : 1
  const color = stageColor(ratio)
  const percent = Math.min(100, Math.round(ratio * 100))

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <span style={{ width }}>
        <Progress percent={percent} showInfo={false} size="small" strokeColor={color} />
      </span>
      <span className="font-mono" style={{ fontSize: 12, color, whiteSpace: 'nowrap' }}>
        {fmtMB(usedBytes)} / {quotaMb} MB
      </span>
    </span>
  )
}
