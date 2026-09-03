/**
 * 用户交流群二维码 — 双形态共享组件
 * GroupQrCard：设置页 RowItem 悬浮气泡（PC hover，小号图）
 * GroupQrModal：点击弹层（移动端兜底 + 反馈页「用户交流群」卡片入口）
 */
import { Modal } from 'antd'

const QR_SRC = '/feishu-group-qr.png'

/** 悬浮气泡内容：小号二维码 + 一句话 */
export function GroupQrCard() {
  return (
    <div style={{ textAlign: 'center', width: 168 }}>
      <img
        src={QR_SRC} alt="飞书群二维码"
        style={{ width: 160, height: 'auto', borderRadius: 8, display: 'block', margin: '0 auto' }}
      />
      <div style={{ fontSize: 12, color: 'var(--mute)', marginTop: 8 }}>飞书扫码进群</div>
    </div>
  )
}

/** 点击弹层：大号二维码 + 群说明（群=讨论/动态；报障仍引导工单——群聊没有诊断日志） */
export function GroupQrModal({ open, onClose }) {
  return (
    <Modal open={open} onCancel={onClose} footer={null} centered width={320}>
      <div style={{ textAlign: 'center', padding: '6px 4px 2px' }}>
        <div className="font-display" style={{ fontSize: 17, fontWeight: 600, color: 'var(--ink)' }}>
          Stellaris 用户交流群
        </div>
        <img
          src={QR_SRC} alt="飞书群二维码"
          style={{
            width: 216, height: 'auto', marginTop: 14, borderRadius: 10,
            border: '1px solid var(--hairline)',
          }}
        />
        <div style={{ fontSize: 12.5, color: 'var(--mute)', lineHeight: 1.9, marginTop: 14 }}>
          新功能动态、版本进展抢先看，和开发者与同好随时交流。<br />
          遇到故障请优先提交工单——自动附带诊断日志，定位更快。
        </div>
      </div>
    </Modal>
  )
}
