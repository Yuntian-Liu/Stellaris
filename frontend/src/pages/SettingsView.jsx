/**
 * 设置页 — 对标 Datelife 信息架构的 Starlight 实现
 *
 * 分区：用户信息行 / 数据统计卡 / 个人资料 / 会员权益(占位) /
 *       账号安全(修改密码双通道) / 关于(版本+协议+版本日志) / 退出登录
 */
import { useState, useEffect } from 'react'
import { Button, Input, Modal, Tabs, message } from 'antd'
import {
  ArrowLeftOutlined, RightOutlined, UserOutlined, MailOutlined,
  IdcardOutlined, CrownOutlined, LockOutlined, FileTextOutlined,
  SafetyCertificateOutlined, HistoryOutlined, LogoutOutlined,
  EditOutlined, GithubOutlined, DownOutlined, DotChartOutlined,
} from '@ant-design/icons'
import api, { authApi, getToken } from '../hooks/api'
import { useAuth } from '../contexts/AuthContext'
import AgreementModal from '../components/AgreementModal'
import TurnstileField from '../components/auth/TurnstileField'
import ExchangeModal from '../components/ExchangeModal'
import { APP_VERSION, CHANGELOG } from '../utils/changelog'

const avatarUrl = (seed) => `https://api.dicebear.com/7.x/micah/svg?seed=${seed}`

/** 每日星语（按日期轮换，同一天所有人看到同一句） */
const STAR_LINES = [
  '今夜星空清澈，适合聆听。',
  '每一段声音，都是一颗星。',
  '星光不问赶路人。',
  '你的每一次提取，都在点亮星图。',
  '听见，然后读懂。',
  '宇宙的回声，落在文字里。',
  '慢慢读，星光不散。',
]
function dailyStarLine() {
  const day = Math.floor(Date.now() / 86400000)
  return STAR_LINES[day % STAR_LINES.length]
}

/** 千分位缩写 */
function fmt(n) {
  if (n >= 10000) return `${(n / 10000).toFixed(1)}w`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

export default function SettingsView({ onBack }) {
  const { user, logout, refresh } = useAuth()
  const [stats, setStats] = useState(null)
  const [billing, setBilling] = useState(null)
  const [agreementOpen, setAgreementOpen] = useState(false)
  const [agreementType, setAgreementType] = useState('agreement')
  const [changelogOpen, setChangelogOpen] = useState(false)
  const [ossOpen, setOssOpen] = useState(false)
  const [nicknameOpen, setNicknameOpen] = useState(false)
  const [avatarOpen, setAvatarOpen] = useState(false)
  const [passwordOpen, setPasswordOpen] = useState(false)
  const [exchangeOpen, setExchangeOpen] = useState(false)

  useEffect(() => {
    api.getStats().then(setStats).catch(() => setStats(null))
    const loadBilling = () => api.getBilling().then(setBilling).catch(() => {})
    loadBilling()
    window.addEventListener('stellaris:billing-changed', loadBilling)
    return () => window.removeEventListener('stellaris:billing-changed', loadBilling)
  }, [])

  const openAgreement = (type) => { setAgreementType(type); setAgreementOpen(true) }

  // 导出诊断日志（带 token 的 fetch 下载，脱敏 JSON）
  const downloadDiagnostics = async () => {
    try {
      const res = await fetch('/api/diagnostics/export', {
        headers: { Authorization: `Bearer ${getToken()}` },
      })
      if (!res.ok) throw new Error(`导出失败 (${res.status})`)
      const blob = await res.blob()
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `stellaris-diagnostics-${Date.now()}.json`
      a.click()
      URL.revokeObjectURL(a.href)
      message.success('诊断日志已导出，可发给开发者排查问题')
    } catch (e) {
      message.error(e.message)
    }
  }

  const handleLogout = () => {
    Modal.confirm({
      title: '退出登录？',
      content: '退出后需要重新验证邮箱或输入密码才能登录。',
      okText: '退出登录',
      okButtonProps: { danger: true },
      cancelText: '再想想',
      onOk: () => { logout(); onBack() },
    })
  }

  return (
    <div className="page-enter" style={{ maxWidth: 560, margin: '-14px auto 0' }}>
      {/* 顶部：返回 + 标题 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <Button type="text" icon={<ArrowLeftOutlined />} onClick={onBack} />
        <h1 className="font-display font-display-sm" style={{ margin: 0 }}>设置</h1>
      </div>

      {/* ── 用户信息行 ── */}
      <div className="card" style={{
        padding: '16px 18px', display: 'flex', alignItems: 'center', gap: 14, marginBottom: 16,
      }}>
        <img
          src={avatarUrl(user.avatar_seed)} alt="头像"
          style={{ width: 56, height: 56, borderRadius: '50%', border: '1px solid var(--hairline)' }}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 16, color: 'var(--ink)', display: 'flex', alignItems: 'center', gap: 8 }}>
            {user.nickname}
            <span style={{
              fontSize: 11, fontWeight: 500, color: 'var(--accent)',
              background: 'var(--accent-light)', borderRadius: 9999, padding: '1px 8px',
            }}>免费版</span>
          </div>
          <div style={{ fontSize: 12, color: 'var(--mute)', marginTop: 3 }}>{user.email}</div>
        </div>
      </div>

      {/* ── 数据统计卡（星光品牌横幅）── */}
      <div style={{
        position: 'relative',
        borderRadius: 'var(--r-card)',
        padding: '20px 22px 16px',
        marginBottom: 24,
        background: 'linear-gradient(135deg, #4f46e5 0%, #6d28d9 100%)',
        color: '#fff',
        overflow: 'hidden',
      }}>
        {/* 角落装饰 */}
        <div style={{
          position: 'absolute', top: -30, right: -20, width: 120, height: 120,
          borderRadius: '50%', background: 'rgba(255,255,255,0.08)',
        }} />
        <span style={{
          position: 'absolute', top: 16, right: 20, fontSize: 18,
          fontFamily: "'Cormorant Garamond', serif", opacity: 0.9,
        }}>✦</span>
        <div style={{ position: 'relative' }}>
          <div style={{ fontSize: 13, opacity: 0.85, marginBottom: 6 }}>在 Stellaris 的星轨上</div>
          <div style={{ fontSize: 15, lineHeight: 1.7 }}>
            已提取 <b style={{ fontSize: 22 }}>{stats ? stats.videos_extracted : '-'}</b> 个视频
            · 转写 <b style={{ fontSize: 22 }}>{stats ? fmt(stats.chars_transcribed) : '-'}</b> 字
          </div>
          <div style={{
            display: 'flex', gap: 10, marginTop: 14, paddingTop: 12,
            borderTop: '1px solid rgba(255,255,255,0.18)',
          }}>
            <MiniStat label="MD 笔记" value={stats ? fmt(stats.md_notes) : '-'} />
            <MiniStat label="AI 解读" value={stats ? fmt(stats.chat_rounds) : '-'} />
            <MiniStat label="累计 tokens" value={stats ? fmt(stats.tokens_used) : '-'} />
          </div>
          <div style={{ fontSize: 11, opacity: 0.7, marginTop: 12 }}>{dailyStarLine()}</div>
        </div>
      </div>

      {/* ── 个人资料 ── */}
      <SectionTitle>个人资料</SectionTitle>
      <SectionCard>
        <RowItem icon={<UserOutlined />} tint="#ec4899" label="头像"
          value={<img src={avatarUrl(user.avatar_seed)} alt="" style={{ width: 28, height: 28, borderRadius: '50%' }} />}
          onClick={() => setAvatarOpen(true)} />
        <Divider />
        <RowItem icon={<EditOutlined />} tint="#3b82f6" label="昵称"
          value={user.nickname} onClick={() => setNicknameOpen(true)} />
        <Divider />
        <RowItem icon={<MailOutlined />} tint="#10b981" label="邮箱" value={user.email} />
        <Divider />
        <RowItem icon={<IdcardOutlined />} tint="#8b5cf6" label="UID"
          value={<span className="font-mono">{user.uid}</span>} />
      </SectionCard>

      {/* ── 会员权益（兑换说明 + 余额）── */}
      <SectionTitle>会员权益</SectionTitle>
      <SectionCard>
        <RowItem icon={<CrownOutlined />} tint="#f59e0b" label="会员权益"
          value="敬请期待"
          onClick={() => message.info('会员功能正在路上，敬请期待')} />
        <Divider />
        <RowItem icon={<DotChartOutlined />} tint="#6366f1" label="货币兑换"
          value={billing ? `量子波⇄引力波 · 本月还可兑 ${billing.exchange_month_cap - billing.exchange_month_used} 次` : '量子波⇄引力波'}
          onClick={() => setExchangeOpen(true)} />
      </SectionCard>

      {/* ── 账号安全 ── */}
      <SectionTitle>账号安全</SectionTitle>
      <SectionCard>
        <RowItem icon={<LockOutlined />} tint="#6366f1" label="修改密码"
          value="旧密码 / 验证码" onClick={() => setPasswordOpen(true)} />
      </SectionCard>

      {/* ── 关于 ── */}
      <SectionTitle>关于</SectionTitle>
      <SectionCard>
        <RowItem icon={<FileTextOutlined />} tint="#0ea5e9" label="当前版本" value={APP_VERSION} />
        <Divider />
        <RowItem icon={<SafetyCertificateOutlined />} tint="#10b981" label="用户协议"
          onClick={() => openAgreement('agreement')} />
        <Divider />
        <RowItem icon={<SafetyCertificateOutlined />} tint="#14b8a6" label="隐私政策"
          onClick={() => openAgreement('privacy')} />
        <Divider />
        <RowItem icon={<HistoryOutlined />} tint="#f97316" label="版本日志"
          onClick={() => setChangelogOpen(true)} />
        <Divider />
        <RowItem icon={<FileTextOutlined />} tint="#64748b" label="导出诊断日志"
          value="排查问题用"
          onClick={downloadDiagnostics} />
        <Divider />
        <RowItem icon={<GithubOutlined />} tint="#334155" label="开源声明"
          value="MIT" onClick={() => setOssOpen(true)} />
      </SectionCard>

      {/* ── 退出登录 ── */}
      <SectionCard style={{ marginTop: 24 }}>
        <div
          onClick={handleLogout}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
            padding: '13px 16px', cursor: 'pointer', color: 'var(--error)',
            fontSize: 14, fontWeight: 500,
          }}
        >
          <LogoutOutlined />退出登录
        </div>
      </SectionCard>

      {/* ── 弹窗群 ── */}
      <AgreementModal open={agreementOpen} type={agreementType} onClose={() => setAgreementOpen(false)} />
      <ChangelogModal open={changelogOpen} onClose={() => setChangelogOpen(false)} />
      <OpenSourceModal open={ossOpen} onClose={() => setOssOpen(false)} />
      <NicknameModal
        open={nicknameOpen} current={user.nickname}
        onClose={() => setNicknameOpen(false)} onSaved={refresh}
      />
      <AvatarModal
        open={avatarOpen} current={user.avatar_seed}
        onClose={() => setAvatarOpen(false)} onSaved={refresh}
      />
      <PasswordModal open={passwordOpen} email={user.email} onClose={() => setPasswordOpen(false)} />
      <ExchangeModal
        open={exchangeOpen}
        billing={billing}
        onClose={() => setExchangeOpen(false)}
        onDone={() => api.getBilling().then(setBilling).catch(() => {})}
      />
    </div>
  )
}

/* ── 小组件 ── */

function MiniStat({ label, value }) {
  return (
    <div style={{ flex: 1 }}>
      <div style={{ fontSize: 16, fontWeight: 700 }}>{value}</div>
      <div style={{ fontSize: 11, opacity: 0.75, marginTop: 2 }}>{label}</div>
    </div>
  )
}

function SectionTitle({ children }) {
  return (
    <div className="font-caption" style={{
      fontSize: 13, fontWeight: 600, color: 'var(--mute)', margin: '18px 4px 8px',
    }}>
      {children}
    </div>
  )
}

function SectionCard({ children, style }) {
  return (
    <div className="card" style={{ overflow: 'hidden', ...style }}>{children}</div>
  )
}

function Divider() {
  return <div style={{ borderTop: '1px solid var(--hairline)', margin: '0 16px' }} />
}

/** 行条目：图标 chip + 标签 + 值 + chevron（可点） */
function RowItem({ icon, tint, label, value, onClick }) {
  return (
    <div
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '12px 16px',
        cursor: onClick ? 'pointer' : 'default',
      }}
    >
      <div style={{
        width: 34, height: 34, borderRadius: 10, flexShrink: 0,
        background: `${tint}14`, color: tint,
        display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15,
      }}>
        {icon}
      </div>
      <span style={{ flex: 1, fontSize: 14, fontWeight: 500, color: 'var(--ink)' }}>{label}</span>
      {value && <span style={{ fontSize: 13, color: 'var(--mute)', maxWidth: '50%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</span>}
      {onClick && <RightOutlined style={{ fontSize: 11, color: 'var(--hairline-strong)' }} />}
    </div>
  )
}

/* ── 版本日志弹窗（折叠卡片：最新版默认展开）── */
function ChangelogModal({ open, onClose }) {
  const [expanded, setExpanded] = useState(0)   // 默认展开最新版本
  useEffect(() => { if (open) setExpanded(0) }, [open])

  return (
    <Modal open={open} onCancel={onClose} footer={null} title="版本日志" width={520}>
      <div style={{ maxHeight: '60vh', overflowY: 'auto', paddingRight: 4 }}>
        {CHANGELOG.map((v, idx) => {
          const isOpen = expanded === idx
          return (
            <div
              key={v.version}
              style={{
                marginBottom: 10,
                border: `1px solid ${isOpen ? 'var(--accent)' : 'var(--hairline)'}`,
                borderRadius: 'var(--r-input)',
                overflow: 'hidden',
                transition: 'border-color 0.2s',
              }}
            >
              {/* 版本头部（点击折叠/展开） */}
              <div
                onClick={() => setExpanded(isOpen ? -1 : idx)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '10px 14px', cursor: 'pointer',
                  background: isOpen ? 'var(--accent-light)' : 'var(--surface-1)',
                  transition: 'background 0.2s',
                }}
              >
                <span style={{ fontWeight: 600, fontSize: 14, color: 'var(--ink)' }}>{v.version}</span>
                <span style={{
                  fontSize: 12, color: 'var(--accent)',
                  fontFamily: "'Cormorant Garamond', serif",
                }}>{v.codename}</span>
                <span style={{ flex: 1 }} />
                <span style={{ fontSize: 11, color: 'var(--mute)' }}>{v.date}</span>
                <DownOutlined style={{
                  fontSize: 10, color: 'var(--mute)',
                  transform: isOpen ? 'rotate(180deg)' : 'none',
                  transition: 'transform 0.2s',
                }} />
              </div>
              {/* 更新内容（展开态）：minor 整体亮点 + 嵌套 patch */}
              {isOpen && (
                <div style={{
                  padding: '10px 14px 12px',
                  borderTop: '1px solid var(--hairline)',
                  background: 'var(--surface-1)',
                }}>
                  <ul style={{ margin: 0, paddingLeft: 18 }}>
                    {v.items.map((item, i) => (
                      <li key={i} style={{ fontSize: 13, color: 'var(--body)', lineHeight: 1.9 }}>{item}</li>
                    ))}
                  </ul>
                  {v.patches?.length > 0 && (
                    <div style={{ marginTop: 10 }}>
                      <div style={{
                        fontSize: 11, fontWeight: 600, color: 'var(--mute)',
                        letterSpacing: '0.05em', marginBottom: 6,
                      }}>
                        补丁更新
                      </div>
                      {v.patches.map((p, pi) => {
                        const isLatest = idx === 0 && pi === 0   // 最新 minor 的首个 patch = 全站最新
                        return (
                          <div
                            key={p.version}
                            style={{
                              padding: '6px 10px',
                              marginBottom: 6,
                              borderRadius: 8,
                              background: 'var(--surface-2)',
                              borderLeft: isLatest
                                ? '2px solid var(--accent)'
                                : '2px solid var(--hairline)',
                            }}
                          >
                            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                              <span style={{
                                fontSize: 12, fontWeight: 600,
                                color: isLatest ? 'var(--accent)' : 'var(--body)',
                              }}>
                                {p.version}
                              </span>
                              <span style={{ fontSize: 11, color: 'var(--mute)' }}>{p.date}</span>
                            </div>
                            <ul style={{ margin: '2px 0 0', paddingLeft: 16 }}>
                              {p.items.map((item, i) => (
                                <li key={i} style={{ fontSize: 12, color: 'var(--mute)', lineHeight: 1.8 }}>{item}</li>
                              ))}
                            </ul>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </Modal>
  )
}

/* ── 开源声明弹窗（项目卡 + 开发者 + MIT + 致谢）── */
function OpenSourceModal({ open, onClose }) {
  return (
    <Modal open={open} onCancel={onClose} footer={null} title="开源声明" width={480}>
      <div style={{ maxHeight: '62vh', overflowY: 'auto', paddingRight: 4 }}>

        {/* 项目仓库卡（高亮） */}
        <a
          href="https://github.com/Yuntian-Liu/stellaris" target="_blank" rel="noreferrer"
          style={{ textDecoration: 'none', display: 'block' }}
        >
          <div style={{
            display: 'flex', alignItems: 'center', gap: 14,
            padding: '14px 16px',
            background: 'linear-gradient(135deg, #4f46e5 0%, #6d28d9 100%)',
            borderRadius: 'var(--r-card)',
            color: '#fff',
            marginBottom: 14,
          }}>
            <span style={{ fontSize: 26, fontFamily: "'Cormorant Garamond', serif", lineHeight: 1 }}>✦</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 700, fontSize: 16, letterSpacing: '0.02em' }}>Stellaris</div>
              <div style={{ fontSize: 12, opacity: 0.85, marginTop: 2 }}>把视频里说的话，变成可以阅读的文字</div>
            </div>
            <div style={{
              fontSize: 12, fontWeight: 500,
              background: 'rgba(255,255,255,0.18)', borderRadius: 9999,
              padding: '5px 12px', flexShrink: 0,
            }}>
              GitHub →
            </div>
          </div>
        </a>

        {/* 开发者 */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 12,
          padding: '12px 16px',
          background: 'var(--surface-2)',
          borderRadius: 'var(--r-card)',
          marginBottom: 14,
        }}>
          <img
            src="https://github.com/Yuntian-Liu.png" alt="开发者"
            style={{ width: 40, height: 40, borderRadius: '50%', border: '1px solid var(--hairline)' }}
          />
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--ink)' }}>Yuntian-Liu</div>
            <div style={{ fontSize: 12, color: 'var(--mute)', marginTop: 2 }}>独立开发者 · 设计与实现</div>
          </div>
          <a
            href="https://github.com/Yuntian-Liu" target="_blank" rel="noreferrer"
            style={{ fontSize: 12, color: 'var(--accent)', flexShrink: 0 }}
          >
            主页 →
          </a>
        </div>

        {/* MIT 许可 */}
        <div style={{
          padding: '12px 16px',
          border: '1px solid var(--hairline)',
          borderRadius: 'var(--r-card)',
          marginBottom: 14,
          fontSize: 12.5, color: 'var(--body)', lineHeight: 1.8,
        }}>
          本项目基于 <b>MIT 许可证</b> 开源——任何人都可以自由使用、修改和分发源代码，
          只需保留版权声明。欢迎通过 GitHub 参与共建。
        </div>

        {/* 开源致谢（整齐行） */}
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink)', margin: '4px 2px 8px' }}>
          开源致谢
        </div>
        <div style={{
          border: '1px solid var(--hairline)',
          borderRadius: 'var(--r-card)',
          overflow: 'hidden',
        }}>
          {[
            ['React', '前端框架'],
            ['Ant Design', 'UI 组件库'],
            ['FastAPI', '后端框架'],
            ['yt-dlp', '视频解析'],
            ['SQLAlchemy', '数据库 ORM'],
          ].map(([name, desc], i, arr) => (
            <div key={name} style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '9px 16px',
              borderTop: i === 0 ? 'none' : '1px solid var(--hairline)',
              fontSize: 12.5,
            }}>
              <span style={{
                width: 6, height: 6, borderRadius: '50%',
                background: 'var(--accent)', flexShrink: 0, opacity: 0.6,
              }} />
              <span style={{ fontWeight: 500, color: 'var(--ink)', width: 96 }}>{name}</span>
              <span style={{ color: 'var(--mute)' }}>{desc}</span>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  )
}

/* ── 昵称编辑弹窗 ── */
function NicknameModal({ open, current, onClose, onSaved }) {
  const [value, setValue] = useState(current)
  const [saving, setSaving] = useState(false)
  useEffect(() => { if (open) setValue(current) }, [open, current])

  const save = async () => {
    const nickname = value.trim()
    if (!nickname) return
    setSaving(true)
    try {
      await authApi.updateProfile({ nickname })
      message.success('昵称已更新')
      onSaved()
      onClose()
    } catch (e) {
      message.error(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open={open} onCancel={onClose} title="修改昵称" footer={null} width={360}>
      <Input
        value={value} onChange={e => setValue(e.target.value)}
        maxLength={24} showCount onPressEnter={save}
        style={{ marginBottom: 16 }}
      />
      <Button type="primary" block loading={saving} disabled={!value.trim()} onClick={save}>
        保存
      </Button>
    </Modal>
  )
}

/* ── 头像编辑弹窗（DiceBear 九宫格）── */
function randomSeed() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let s = ''
  for (let i = 0; i < 8; i++) s += chars[Math.floor(Math.random() * chars.length)]
  return s
}

function AvatarModal({ open, current, onClose, onSaved }) {
  const [pool, setPool] = useState(() => Array.from({ length: 9 }, () => randomSeed()))
  const [selected, setSelected] = useState(current)
  const [saving, setSaving] = useState(false)
  useEffect(() => { if (open) setSelected(current) }, [open, current])

  const save = async () => {
    setSaving(true)
    try {
      await authApi.updateProfile({ avatar_seed: selected })
      message.success('头像已更新')
      onSaved()
      onClose()
    } catch (e) {
      message.error(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open={open} onCancel={onClose} title="更换头像" footer={null} width={400}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginBottom: 14 }}>
        {pool.map((seed, i) => (
          <div
            key={seed + i}
            onClick={() => setSelected(seed)}
            style={{
              cursor: 'pointer', borderRadius: 12, padding: 4,
              border: selected === seed ? '2px solid var(--accent)' : '2px solid var(--hairline)',
              background: selected === seed ? 'var(--accent-light)' : 'var(--surface-1)',
            }}
          >
            <img src={avatarUrl(seed)} alt="" style={{ width: '100%', display: 'block', borderRadius: 8 }} />
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 10, marginBottom: 14 }}>
        <Button style={{ flex: 1 }} onClick={() => setPool(Array.from({ length: 9 }, () => randomSeed()))}>
          换一批
        </Button>
      </div>
      <Button type="primary" block loading={saving} onClick={save}>
        保存
      </Button>
    </Modal>
  )
}

/* ── 修改密码弹窗（旧密码 / 验证码双通道）── */
function PasswordModal({ open, email, onClose }) {
  const [tab, setTab] = useState('old')
  const [oldPwd, setOldPwd] = useState('')
  const [newPwd, setNewPwd] = useState('')
  const [code, setCode] = useState('')
  const [turnstileToken, setTurnstileToken] = useState(null)
  const [codeSent, setCodeSent] = useState(false)
  const [countdown, setCountdown] = useState(0)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (open) {
      setTab('old'); setOldPwd(''); setNewPwd(''); setCode('')
      setCodeSent(false); setCountdown(0)
    }
  }, [open])

  useEffect(() => {
    if (countdown <= 0) return
    const t = setTimeout(() => setCountdown(c => c - 1), 1000)
    return () => clearTimeout(t)
  }, [countdown])

  const sendCode = async () => {
    if (!turnstileToken) { message.warning('请完成人机验证'); return }
    try {
      await authApi.sendCode(email, turnstileToken)
      setCodeSent(true)
      setCountdown(60)
      message.success('验证码已发送到你的邮箱')
    } catch (e) {
      message.error(e.message)
    }
  }

  const submit = async () => {
    if (newPwd.length < 8) { message.warning('新密码至少 8 位'); return }
    setSaving(true)
    try {
      if (tab === 'old') {
        await authApi.changePassword(oldPwd, newPwd)
      } else {
        await authApi.resetPassword(email, code, newPwd)
      }
      message.success('密码已更新，下次登录请使用新密码')
      onClose()
    } catch (e) {
      message.error(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open={open} onCancel={onClose} title="修改密码" footer={null} width={400}>
      <Tabs
        activeKey={tab} onChange={setTab}
        items={[
          { key: 'old', label: '旧密码验证' },
          { key: 'code', label: '邮箱验证码' },
        ]}
        style={{ marginBottom: 4 }}
      />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {tab === 'old' && (
          <Input.Password
            placeholder="当前密码" value={oldPwd}
            onChange={e => setOldPwd(e.target.value)}
          />
        )}
        {tab === 'code' && (
          <>
            <TurnstileField onToken={setTurnstileToken} />
            <div style={{ display: 'flex', gap: 8 }}>
              <Input
                placeholder="6 位验证码" value={code} maxLength={6}
                onChange={e => setCode(e.target.value.replace(/\D/g, ''))}
              />
              <Button onClick={sendCode} disabled={countdown > 0} style={{ flexShrink: 0 }}>
                {countdown > 0 ? `${countdown}s` : codeSent ? '重新发送' : '发送验证码'}
              </Button>
            </div>
          </>
        )}
        <Input.Password
          placeholder="新密码（至少 8 位，含字母+数字+符号）" value={newPwd}
          onChange={e => setNewPwd(e.target.value)}
        />
        <Button
          type="primary" block loading={saving} onClick={submit}
          disabled={tab === 'old' ? !oldPwd || !newPwd : !code || !newPwd}
        >
          确认修改
        </Button>
      </div>
    </Modal>
  )
}
