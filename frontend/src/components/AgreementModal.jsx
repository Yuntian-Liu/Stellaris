/**
 * 协议弹窗 — AntD Modal + Tabs 展示用户协议 / 隐私政策
 * 内容来自 legal/agreement.js 静态 HTML(dangerouslySetInnerHTML 渲染)
 */
import { Modal, Tabs } from 'antd'
import { USER_AGREEMENT_HTML, PRIVACY_POLICY_HTML, MEMBERSHIP_AGREEMENT_HTML } from '../legal/agreement'

export default function AgreementModal({ open, type = 'agreement', onClose }) {
  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      width={560}
      centered
      destroyOnClose
      title={<span className="font-display">法律文件</span>}
    >
      <Tabs
        defaultActiveKey={type}
        items={[
          {
            key: 'agreement',
            label: '用户协议',
            children: <div className="legal-doc" dangerouslySetInnerHTML={{ __html: USER_AGREEMENT_HTML }} />,
          },
          {
            key: 'privacy',
            label: '隐私政策',
            children: <div className="legal-doc" dangerouslySetInnerHTML={{ __html: PRIVACY_POLICY_HTML }} />,
          },
          {
            key: 'membership',
            label: '会员协议',
            children: <div className="legal-doc" dangerouslySetInnerHTML={{ __html: MEMBERSHIP_AGREEMENT_HTML }} />,
          },
        ]}
      />
      <style>{`
        .legal-doc { max-height: 55vh; overflow-y: auto; padding-right: 8px; }
        .legal-doc h3 { font-size: 15px; font-weight: 600; color: var(--ink); margin: 18px 0 8px; }
        .legal-doc h3:first-child { margin-top: 0; }
        .legal-doc p { font-size: 13px; color: var(--body); line-height: 1.75; margin: 6px 0; }
        .legal-doc ol { font-size: 13px; color: var(--body); line-height: 1.75; padding-left: 20px; margin: 6px 0; }
        .legal-doc ol li { margin: 4px 0; }
        .legal-doc strong { color: var(--ink); font-weight: 600; }
        .legal-doc .legal-updated { color: var(--mute); font-size: 12px; margin-top: 20px; }
      `}</style>
    </Modal>
  )
}
