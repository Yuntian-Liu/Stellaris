/**
 * InfoTip — 术语微提示 ⓘ
 * 小图标 + Popover：PC hover 浮出，移动端点按浮出（trigger 双通道）
 * 文案来自 utils/glossary.js（轻提醒，与帮助中心详细文档刻意不共用）
 */
import { Popover } from 'antd'
import { InfoCircleOutlined } from '@ant-design/icons'

export default function InfoTip({ text }) {
  return (
    <Popover
      content={<div style={{ maxWidth: 240, fontSize: 12, lineHeight: 1.8, color: 'var(--body)' }}>{text}</div>}
      trigger={['hover', 'click']}
      placement="top"
    >
      <InfoCircleOutlined
        onClick={(e) => e.stopPropagation()}
        style={{ fontSize: 12, color: 'var(--mute)', cursor: 'pointer', marginLeft: 6 }}
      />
    </Popover>
  )
}
