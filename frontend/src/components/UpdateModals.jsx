/**
 * 更新提醒弹窗（对标 Datelife 机制）
 * - 版本更新：APP_VERSION 与 localStorage 记录不符 → 弹"更新啦"小窗（每版本一次）
 * - 协议更新：AGREEMENT_VERSION 不符 → 弹协议更新小窗（每次协议修订一次）
 * - 迁移公告（V1.6.1 临时）：停服迁移通知 → 每人一次，链尾；「去导出数据」高亮引导
 * 三个弹窗串联：版本 → 协议 → 迁移公告
 */
import { useState, useEffect } from 'react'
import { Modal, Button } from 'antd'
import { getLatestUpdate, AGREEMENT_VERSION } from '../utils/changelog'
import { clientLog } from '../utils/clientLog'
import { OPEN_EXPORT_EVENT } from './DataExportModal'

const UPDATE_KEY = 'stellaris_last_seen_version'
const AGREEMENT_KEY = 'stellaris_last_seen_agreement'
const MIGRATION_KEY = 'stellaris_migration_notice_v1'   // 停服公告（10-23 迁移）每人一次

export default function UpdateModals({ onOpenAgreement }) {
  const [updateInfo, setUpdateInfo] = useState(null)
  const [showAgreement, setShowAgreement] = useState(false)
  const [showMigration, setShowMigration] = useState(false)

  // 启动检查：版本更新优先，关闭后串联检查协议更新，再串联迁移公告
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
    } else {
      checkMigration()
    }
  }

  // 停服迁移公告（V1.6.1 第三节）：迁移已于 10-23 13:03 完成，弹窗下线（V1.6.4）。
  // 代码全留：若未来再需要公告型第三弹，恢复下方判断即可。
  // const checkMigration = () => {
  //   if (!localStorage.getItem(MIGRATION_KEY)) {
  //     setShowMigration(true)
  //     clientLog.add('ui', '迁移公告弹窗已展示')
  //   }
  // }
  const checkMigration = () => {}

  const closeUpdate = () => {
    localStorage.setItem(UPDATE_KEY, updateInfo.version)
    setUpdateInfo(null)
    checkAgreement()
  }

  const closeAgreement = () => {
    localStorage.setItem(AGREEMENT_KEY, AGREEMENT_VERSION)
    setShowAgreement(false)
    checkMigration()
  }

  const closeMigration = () => {
    localStorage.setItem(MIGRATION_KEY, '1')
    setShowMigration(false)
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
            {/* 内容区限高滚动（1.0.0 长日志实测撑满屏；标题与按钮固定可见） */}
            <div style={{ maxHeight: '52vh', overflowY: 'auto', marginBottom: 20, paddingRight: 4 }}>
            {/* 开发者寄语（仅 minor 有 intro 时展示；引用块样式与正条区分） */}
            {updateInfo.intro && (
              <div style={{
                textAlign: 'left',
                fontSize: 12.5,
                color: 'var(--mute)',
                lineHeight: 1.9,
                padding: '10px 14px',
                marginBottom: 16,
                borderLeft: '3px solid var(--accent)',
                background: 'var(--surface-2)',
                borderRadius: '0 8px 8px 0',
              }}>
                {updateInfo.intro}
              </div>
            )}
            <ul style={{
              textAlign: 'left', margin: 0, paddingLeft: 20,
            }}>
              {updateInfo.items.map((item, i) => (
                <li key={i} style={{ fontSize: 13.5, color: 'var(--body)', lineHeight: 2 }}>{item}</li>
              ))}
            </ul>
            </div>
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
      {/* ── 迁移公告（V1.6.1 临时：10-23 停服维护通知，每人一次）── */}
      <Modal
        open={showMigration}
        onCancel={closeMigration}
        footer={null}
        width={420}
        centered
      >
        <div style={{ textAlign: 'center', padding: '8px 4px 0' }}>
          <h2 className="font-display" style={{ fontSize: 18, margin: '0 0 10px' }}>
            服务迁移公告
          </h2>
          <div style={{ fontSize: 13, color: 'var(--body)', lineHeight: 1.9, textAlign: 'left', marginBottom: 16 }}>
            因服务器服务商停止运营，本站将于 <strong style={{ color: 'var(--ink)' }}>10 月 23 日（周五）12:00 起</strong>停服迁移，预计 <strong style={{ color: 'var(--ink)' }}>6 小时内</strong>恢复。
            <div style={{ marginTop: 8, color: 'var(--mute)', fontSize: 12.5 }}>
              迁移前后没有任何变化：网址不变，账号、额度、会员权益、历史记录与文件柜内容完整保留。
              你无需任何操作；如希望自行留档，可导出个人数据存档。
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <Button block onClick={closeMigration}>知道了</Button>
            <Button
              type="primary" block
              onClick={() => {
                closeMigration()
                clientLog.add('ui', '迁移公告 → 点击去导出数据')
                window.dispatchEvent(new CustomEvent(OPEN_EXPORT_EVENT))
              }}
            >
              去导出数据
            </Button>
          </div>
        </div>
      </Modal>
    </>
  )
}
