/**
 * 更新提醒弹窗（对标 Datelife 机制）
 * - 版本更新：APP_VERSION 与 localStorage 记录不符 → 弹"更新啦"小窗（每版本一次）
 * - 协议更新：AGREEMENT_VERSION 不符 → 弹协议更新小窗（每次协议修订一次）
 * 两个弹窗串联：版本弹窗关闭后才检查协议弹窗
 */
import { useState, useEffect } from 'react'
import { Modal, Button } from 'antd'
import { getLatestUpdate, AGREEMENT_VERSION } from '../utils/changelog'

const UPDATE_KEY = 'stellaris_last_seen_version'
const AGREEMENT_KEY = 'stellaris_last_seen_agreement'

export default function UpdateModals({ onOpenAgreement }) {
  const [updateInfo, setUpdateInfo] = useState(null)
  const [showAgreement, setShowAgreement] = useState(false)

  // 启动检查：版本更新优先，关闭后串联检查协议更新
  useEffect(() => {
    const lastSeen = localStorage.getItem(UPDATE_KEY)
    const latest = getLatestUpdate()
    if (lastSeen !== latest.version) {
      setUpdateInfo(latest)
    } else {
      checkAgreement()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const checkAgreement = () => {
    if (localStorage.getItem(AGREEMENT_KEY) !== AGREEMENT_VERSION) {
      setShowAgreement(true)
    }
  }

  const closeUpdate = () => {
    localStorage.setItem(UPDATE_KEY, updateInfo.version)
    setUpdateInfo(null)
    checkAgreement()
  }

  const closeAgreement = () => {
    localStorage.setItem(AGREEMENT_KEY, AGREEMENT_VERSION)
    setShowAgreement(false)
  }

  return (
    <>
      {/* ── 版本更新提醒 ── */}
      <Modal
        open={!!updateInfo}
        onCancel={closeUpdate}
        footer={null}
        width={420}
        centered
      >
        {updateInfo && (
          <div style={{ textAlign: 'center', padding: '8px 4px 0' }}>
            <div style={{
              fontSize: 30, color: 'var(--accent)',
              fontFamily: "'Cormorant Garamond', serif", marginBottom: 8,
            }}>✦</div>
            <h2 className="font-display" style={{ fontSize: 20, margin: '0 0 4px' }}>
              Stellaris 更新啦
            </h2>
            <div style={{ fontSize: 12, color: 'var(--mute)', marginBottom: 18 }}>
              {updateInfo.version} · {updateInfo.codename} · {updateInfo.date}
            </div>
            <ul style={{
              textAlign: 'left', margin: '0 0 20px', paddingLeft: 20,
            }}>
              {updateInfo.items.map((item, i) => (
                <li key={i} style={{ fontSize: 13.5, color: 'var(--body)', lineHeight: 2 }}>{item}</li>
              ))}
            </ul>
            <Button type="primary" size="large" block onClick={closeUpdate}>
              知道了
            </Button>
          </div>
        )}
      </Modal>

      {/* ── 协议更新提醒 ── */}
      <Modal
        open={showAgreement}
        onCancel={closeAgreement}
        footer={null}
        width={420}
        centered
      >
        <div style={{ textAlign: 'center', padding: '8px 4px 0' }}>
          <h2 className="font-display" style={{ fontSize: 18, margin: '0 0 8px' }}>
            协议与政策更新
          </h2>
          <p style={{ fontSize: 13, color: 'var(--mute)', lineHeight: 1.8, marginBottom: 20 }}>
            《用户协议》《隐私政策》与《会员协议》已于 {AGREEMENT_VERSION.replace(/\.\d+$/, '')} 更新，
            继续使用本服务即表示你同意最新条款。
          </p>
          <div style={{ display: 'flex', gap: 10 }}>
            <Button block onClick={() => { onOpenAgreement?.(); closeAgreement() }}>
              查看协议
            </Button>
            <Button type="primary" block onClick={closeAgreement}>
              我已知晓
            </Button>
          </div>
        </div>
      </Modal>
    </>
  )
}
