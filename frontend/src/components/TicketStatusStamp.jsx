/**
 * 工单状态盖章标签（V0.9.4）
 * 倾斜、虚线边框的"盖章"质感，替代 AntD Tag。
 * 用户列表 / 管理员列表 / 详情弹窗三处共用。
 */
const STAMP = {
  pending:    { color: '#d97706', border: '#fbbf24', bg: '#fffbeb', label: '待处理' },
  processing: { color: '#2563eb', border: '#93c5fd', bg: '#eff6ff', label: '处理中' },
  replied:    { color: '#16a34a', border: '#86efac', bg: '#f0fdf4', label: '已回复' },
  closed:     { color: '#737373', border: '#d4d4d4', bg: '#fafafa', label: '已关闭' },
}

export default function TicketStatusStamp({ status, style }) {
  const m = STAMP[status] || STAMP.pending
  return (
    <span style={{
      display: 'inline-block',
      padding: '2px 10px',
      fontSize: 11,
      fontWeight: 600,
      letterSpacing: '0.05em',
      borderRadius: 3,
      transform: 'rotate(-2deg)',
      color: m.color,
      background: m.bg,
      border: `1.5px dashed ${m.border}`,
      whiteSpace: 'nowrap',
      ...style,
    }}>
      {m.label}
    </span>
  )
}
