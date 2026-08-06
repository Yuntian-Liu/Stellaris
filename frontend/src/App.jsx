/**
 * Stellaris 根组件 — Starlight 设计系统
 *
 * 设计哲学：
 *   Apple 极简克制 + Claude 衬线编辑感 + Vercel 开发者精度
 *   暖白底 / Indigo 品牌色 / 零装饰性渐变 / 堆叠微投影
 */
import { useState, useCallback, useEffect, useRef, lazy, Suspense } from 'react'
import { Layout, Tooltip, Button, Dropdown, Avatar, Popover, Modal, Spin, Progress } from 'antd'
import { WalletOutlined, LogoutOutlined, LoginOutlined, SettingOutlined, QuestionCircleOutlined, GlobalOutlined, DotChartOutlined, HistoryOutlined, DashboardOutlined } from '@ant-design/icons'
import api from './hooks/api'
import { clientLog } from './utils/clientLog'
import HomePage from './pages/HomePage'
import ProgressPage from './pages/ProgressPage'
import ResultPage from './pages/ResultPage'
import AuthPage from './pages/AuthPage'
import SettingsView from './pages/SettingsView'
// 管理看板（含 recharts）代码分割：仅 admin 点进看板时才加载，不进主包
const AdminView = lazy(() => import('./pages/AdminView'))
import UpdateModals from './components/UpdateModals'
import AgreementModal from './components/AgreementModal'
import MeteorShower from './components/MeteorShower'
import BillingPills from './components/BillingPills'
import Confetti from './components/Confetti'
import GuideModal from './components/GuideModal'
import HistoryModal from './components/HistoryModal'
import TierBadge from './components/TierBadge'
import { tierMeta } from './utils/tier'
import { pushAnonHistory } from './utils/anonHistory'
import { avatarUrl } from './utils/avatar'
import { useAuth } from './contexts/AuthContext'

const { Content } = Layout

// 移动端判定（V0.11 适配）：matchMedia 768px，与全局 @media (max-width:768px) 同阈值
// PC 视口 >768 永远 false → 所有依赖它的分支走原路径，PC 视觉零影响
function useMobile() {
  const [m, setM] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches)
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)')
    const h = (e) => setM(e.matches)
    mq.addEventListener('change', h)
    return () => mq.removeEventListener('change', h)
  }, [])
  return m
}

export default function App() {
  const [page, setPage] = useState('home')
  const prevPage = useRef('home')
  // 导航埋点（V0.10.1）：监听 page 变化自动记录，覆盖所有 setPage 调用点
  useEffect(() => {
    if (page !== prevPage.current) {
      clientLog.add('nav', `${prevPage.current} → ${page}`)
      prevPage.current = page
    }
  }, [page])
  const [taskId, setTaskId] = useState(null)
  const [taskData, setTaskData] = useState(null)
  const [chatOpen, setChatOpen] = useState(false)   // AI 解读分栏态（容器扩宽 760→1180）
  const [agreementView, setAgreementView] = useState(null)  // 更新弹窗"查看协议"联动
  const [guideOpen, setGuideOpen] = useState(false) // 计费引导
  const [historyOpen, setHistoryOpen] = useState(false) // 历史记录
  const [meteorOn, setMeteorOn] = useState(false)   // 流星雨彩蛋
  const [balances, setBalances] = useState(null)    // 头像下拉双货币余额
  const [dropOpen, setDropOpen] = useState(false)   // 头像下拉开合（点菜单后需手动收起）
  const [memberOpen, setMemberOpen] = useState(false) // 会员权益二级界面（标题栏随其展开）
  const adminOpen = page === 'admin' // 管理看板独立页面（派生态，page 变化即自动复位）
  const [ledgerInit, setLedgerInit] = useState(false) // 余额区「消耗记录 →」下钻设置页
  const [celebrateTier, setCelebrateTier] = useState(null) // 会员开通欢迎弹窗（档位跃迁检测）
  const clickRef = useRef({ count: 0, timer: null })
  const { user, loading, logout } = useAuth()
  const isMobile = useMobile()

  // 双货币余额（下拉面板显示；兑换/扣费后广播同步）
  useEffect(() => {
    if (!user) { setBalances(null); return }
    const load = () => api.getBilling().then(setBalances).catch(() => {})
    load()
    window.addEventListener('stellaris:billing-changed', load)
    // 站外支付（爱发电）回页：重新拉余额 + 广播（三处显示同步），触发档位跃迁欢迎弹窗
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        load()
        window.dispatchEvent(new CustomEvent('stellaris:billing-changed'))
      }
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.removeEventListener('stellaris:billing-changed', load)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [user])

  // 离开设置页即复位会员二级界面态（防展开态泄漏到其他页面：品牌点击/历史回看等路径）
  useEffect(() => {
    if (page !== 'settings') setMemberOpen(false)
  }, [page])

  // 管理看板防呆：非 admin 进入 admin 页（如登录态切换）弹回首页
  useEffect(() => {
    if (page === 'admin' && user && !user.is_admin) setPage('home')
  }, [page, user])

  // 会员开通检测：爱发电付款在站外完成，webhook 发货后用户回站时档位跃迁 → 撒花欢迎
  useEffect(() => {
    const tier = balances?.tier
    if (!tier) return
    const prev = localStorage.getItem('stellaris_tier')
    localStorage.setItem('stellaris_tier', tier)
    // UID 100001（专属礼）跃迁到 Stella 时强制弹窗 —— 绕过「首次访问 prev 为空」的常规门槛
    const isChenXing = user?.uid === 100001
    if (isChenXing && tier === 'stella' && prev !== 'stella') {
      setCelebrateTier(tier)
      return
    }
    if (prev && prev !== tier
        && ['trial', 'stargazer', 'voyager', 'odyssey', 'stella'].includes(tier)) {
      setCelebrateTier(tier)
    }
  }, [balances?.tier, user?.uid])

  // 彩蛋：3 秒内连点 logo ✦ 7 次 → 流星雨
  // 提取进行中点品牌先弹确认（防误点前功尽弃；不导航、不计流星雨）——确认后仍是"防卡死关机键"
  const [leaveConfirm, setLeaveConfirm] = useState(false)
  const goHome = () => {
    setPage('home')
    const c = clickRef.current
    c.count += 1
    clearTimeout(c.timer)
    c.timer = setTimeout(() => { c.count = 0 }, 3000)
    if (c.count >= 7) {
      c.count = 0
      setMeteorOn(true)
      setTimeout(() => setMeteorOn(false), 4500)
    }
  }
  const handleBrandClick = () => {
    if (page === 'progress') { setLeaveConfirm(true); return }
    goHome()
  }

  // 401(token 失效)→ 跳登录页
  useEffect(() => {
    const handler = () => setPage('auth')
    window.addEventListener('stellaris:unauthorized', handler)
    return () => window.removeEventListener('stellaris:unauthorized', handler)
  }, [])

  // 首页匿名提示条「了解权益」→ 开计费引导（事件总线，同 stellaris:open-exchange 先例）
  useEffect(() => {
    const handler = () => setGuideOpen(true)
    window.addEventListener('stellaris:open-guide', handler)
    return () => window.removeEventListener('stellaris:open-guide', handler)
  }, [])

  const handleSubmit = useCallback((data) => {
    setTaskId(data.task_id)
    setPage('progress')
  }, [])

  const handleComplete = useCallback((data) => {
    // 匿名历史：服务端不为匿名建记录，完成时记进浏览器 localStorage（见 utils/anonHistory.js）
    if (!user) {
      pushAnonHistory({
        task_id: data.task_id,
        title: data.video_title,
        platform: data.source_platform,
      })
    }
    setTaskData(data)
    setPage('result')
  }, [user])

  const handleBack = useCallback(() => {
    setPage('home')
    setTaskId(null)
    setTaskData(null)
  }, [])

  return (
    <Layout style={{ minHeight: '100vh', background: 'var(--canvas)' }}>
      {/* ── 顶部导航栏（常驻吸顶：返回二级界面不缺席 + 随时可见额度）── */}
      <div style={{
        position: 'sticky',
        top: 0,
        zIndex: 100,
        background: 'color-mix(in srgb, var(--canvas) 88%, transparent)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        borderBottom: '1px solid var(--hairline)',
      }}>
      <div className="app-shell-nav" style={{
        maxWidth: (chatOpen || memberOpen || adminOpen) ? 1312 : 760,
        margin: '0 auto',
        width: '100%',
        padding: '14px 24px 12px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        transition: 'max-width 0.45s cubic-bezier(0.4, 0, 0.2, 1)',
      }}>
        {/* 品牌 wordmark(可点回首页;连点 7 次触发流星雨彩蛋) */}
        <div
          onClick={handleBrandClick}
          style={{ display: 'flex', alignItems: 'center', gap: 9, cursor: 'pointer' }}
          role="button"
        >
          <span className="brand-star" style={{ color: 'var(--accent)', fontSize: 24, lineHeight: 1, fontFamily: "'Cormorant Garamond', serif" }}>✦</span>
          <span className="font-display" style={{
            fontSize: 22, fontWeight: 600, color: 'var(--ink)', letterSpacing: '0.02em',
          }}>
            Stellaris
          </span>
        </div>
        {/* 右侧入口位:loading 占位;已登录→三胶囊+头像 Dropdown;未登录→登录按钮 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {/* 计费引导问号（所有状态可见） */}
          <Popover
            placement="bottomRight"
            content={<div style={{ fontSize: 12, color: 'var(--mute)' }}>计费与额度说明</div>}
          >
            <QuestionCircleOutlined
              onClick={() => setGuideOpen(true)}
              style={{ fontSize: 15, color: 'var(--mute)', cursor: 'pointer' }}
            />
          </Popover>
          {/* 历史记录入口（登录/匿名都可见；匿名读浏览器本地记录，见 HistoryModal） */}
          {!loading && (
            <Popover
              placement="bottomRight"
              content={<div style={{ fontSize: 12, color: 'var(--mute)' }}>提取历史</div>}
            >
              <HistoryOutlined
                onClick={() => setHistoryOpen(true)}
                style={{ fontSize: 15, color: 'var(--mute)', cursor: 'pointer' }}
              />
            </Popover>
          )}
          {loading ? (
            <div style={{ width: 64, height: 30 }} />
          ) : user ? (
            <>
              <BillingPills onOpenLedger={(c) => { setLedgerInit(c); setMemberOpen(false); setPage('settings') }} />
              <Dropdown
                open={dropOpen}
                onOpenChange={setDropOpen}
                dropdownRender={() => (
                  <div style={{
                    width: 240,
                    maxWidth: 'calc(100vw - 32px)',
                    background: 'var(--surface-1)',
                    borderRadius: 'var(--r-card)',
                    border: '1px solid var(--hairline)',
                    boxShadow: '0 8px 28px rgba(0, 0, 0, 0.08)',
                    overflow: 'hidden',
                  }}>
                    {/* 用户卡 */}
                    <div style={{ padding: '14px 16px 12px', display: 'flex', alignItems: 'center', gap: 12 }}>
                      <Avatar
                        size={42}
                        src={avatarUrl(user.avatar_seed)}
                        style={{
                          border: '1px solid var(--hairline)', flexShrink: 0,
                          boxShadow: tierMeta(balances?.tier).ring
                            ? `0 0 0 2px ${tierMeta(balances?.tier).ring}` : 'none',
                        }}
                      />
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {user.nickname}
                        </div>
                        <div className="font-mono" style={{ fontSize: 11, color: 'var(--mute)', marginTop: 2 }}>
                          UID {user.uid}
                        </div>
                      </div>
                    </div>
                    {/* 会员等级 + 双货币余额（图标极简） */}
                    <div style={{
                      margin: '0 12px 10px',
                      padding: '8px 12px',
                      background: 'var(--surface-2)',
                      borderRadius: 'var(--r-input)',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      fontSize: 12,
                      color: 'var(--mute)',
                    }}>
                      <TierBadge tier={balances?.tier} />
                      <span className="font-mono" style={{ display: 'inline-flex', gap: 10 }}>
                        <span>
                          <GlobalOutlined style={{ fontSize: 11, color: 'var(--accent)', marginRight: 3 }} />
                          {balances?.gravity ?? '--'}
                        </span>
                        <span>
                          <DotChartOutlined style={{ fontSize: 11, color: 'var(--accent)', marginRight: 3 }} />
                          {balances ? balances.quantum_gift + balances.quantum_perm : '--'}
                        </span>
                      </span>
                    </div>
                    {/* 移动端：三胶囊 CSS 隐藏后，余额详情（分钟进度 + 兑换入口）并入头像下拉。
                        兑换按钮 dispatch stellaris:open-exchange 事件 → BillingPills 内的 ExchangeModal 弹出 */}
                    {isMobile && balances && (
                      <div style={{ margin: '0 12px 10px', padding: '4px 0 8px' }}>
                        {[['日', balances.minutes?.day], ['周', balances.minutes?.week], ['月', balances.minutes?.month]].map(([label, m]) => {
                          if (!m) return null
                          const noCap = m.limit == null
                          return (
                            <div key={label} style={{ marginBottom: 8 }}>
                              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12, marginBottom: 3 }}>
                                <span style={{ color: 'var(--mute)' }}>{label}分钟</span>
                                <span className="font-mono" style={{ color: 'var(--body)' }}>
                                  {noCap ? `${m.used} / ∞` : `${m.used} / ${m.limit}`}
                                </span>
                              </div>
                              <Progress
                                percent={noCap ? 100 : Math.round(m.used / m.limit * 100)}
                                showInfo={false} size="small"
                                strokeColor={noCap ? { '0%': '#c7d2fe', '100%': '#a5b4fc' } : (m.used / m.limit > 0.8 ? '#f59e0b' : 'var(--accent)')}
                              />
                            </div>
                          )
                        })}
                        <div style={{ marginTop: 4 }}>
                          <Button size="small" block onClick={() => { setDropOpen(false); window.dispatchEvent(new CustomEvent('stellaris:open-exchange', { detail: 'q2g' })) }}>
                            货币兑换
                          </Button>
                        </div>
                      </div>
                    )}
                    <div style={{ borderTop: '1px solid var(--hairline)' }}>
                      {user.is_admin && (
                        <div
                          className="dropdown-item"
                          onClick={() => { setDropOpen(false); setMemberOpen(false); setPage('admin') }}
                        >
                          <DashboardOutlined style={{ marginRight: 8 }} />管理后台
                        </div>
                      )}
                      <div
                        className="dropdown-item"
                        onClick={() => { setDropOpen(false); setPage('settings') }}
                      >
                        <SettingOutlined style={{ marginRight: 8 }} />设置
                      </div>
                      <div
                        className="dropdown-item dropdown-item--danger"
                        onClick={() => { setDropOpen(false); logout(); setPage('home') }}
                      >
                        <LogoutOutlined style={{ marginRight: 8 }} />退出登录
                      </div>
                    </div>
                  </div>
                )}
                placement="bottomRight"
                trigger={['click']}
              >
                <Avatar
                  size={30}
                  src={avatarUrl(user.avatar_seed)}
                  style={{
                    cursor: 'pointer', border: '1px solid var(--hairline)',
                    // 档位头像框（Google One 式）：颜色 = 档位色，免费版无框
                    boxShadow: tierMeta(balances?.tier).ring
                      ? `0 0 0 2px ${tierMeta(balances?.tier).ring}` : 'none',
                  }}
                />
              </Dropdown>
            </>
          ) : (
            <Button type="primary" icon={<LoginOutlined />} onClick={() => setPage('auth')}>
              登录
            </Button>
          )}
        </div>
      </div>
      </div>

      <Content className="app-shell-content" style={{
        maxWidth: (chatOpen || memberOpen || adminOpen) ? 1312 : 760,
        margin: '0 auto',
        padding: '48px 24px 96px',
        width: '100%',
        transition: 'max-width 0.45s cubic-bezier(0.4, 0, 0.2, 1)',
      }}>
        {page === 'auth' && (
          <AuthPage
            onSuccess={() => setPage('home')}
            onBack={() => setPage('home')}
          />
        )}
        {page === 'home' && (
          <HomePage onSubmit={handleSubmit} onNeedAuth={() => setPage('auth')} />
        )}
        {page === 'settings' && (
          <SettingsView
            onBack={() => { setMemberOpen(false); setPage('home') }}
            memberView={memberOpen}
            setMemberView={setMemberOpen}
            initLedger={ledgerInit}
            onConsumeInit={() => setLedgerInit(false)}
            onOpenHistory={() => setHistoryOpen(true)}
          />
        )}
        {/* 管理看板（仅 is_admin 可达；渲染守卫双保险，非 admin 直接改 state 也看不到） */}
        {page === 'admin' && user?.is_admin && (
          <Suspense fallback={
            <div style={{ display: 'flex', justifyContent: 'center', padding: '120px 0' }}>
              <Spin />
            </div>
          }>
            <AdminView onBack={() => setPage('home')} />
          </Suspense>
        )}
        {page === 'progress' && taskId && (
          <ProgressPage
            taskId={taskId}
            onComplete={handleComplete}
            onBack={handleBack}
            onBackGuarded={() => setLeaveConfirm(true)}
          />
        )}
        {page === 'result' && taskData && (
          <ResultPage
            key={taskData.task_id}
            taskData={taskData}
            onBack={handleBack}
            onNew={() => handleBack()}
            onChatToggle={setChatOpen}
            onNeedAuth={() => setPage('auth')}
          />
        )}
      </Content>

      {/* 更新提醒（版本 + 协议，每版本只弹一次） */}
      <UpdateModals onOpenAgreement={() => setAgreementView('agreement')} />
      <AgreementModal
        open={!!agreementView}
        type={agreementView || 'agreement'}
        onClose={() => setAgreementView(null)}
      />

      {/* 计费引导（问号触发） */}
      <GuideModal open={guideOpen} onClose={() => setGuideOpen(false)} />

      {/* 提取进行中点品牌 → 确认离开（登录/匿名文案区分；「返回主页」保留防卡死关机键） */}
      <Modal
        open={leaveConfirm}
        onCancel={() => setLeaveConfirm(false)}
        footer={null}
        width={400}
        centered
        title={<span className="font-display">离开提取进度页？</span>}
      >
        <div style={{ fontSize: 13, color: 'var(--body)', lineHeight: 1.9, padding: '4px 0 16px' }}>
          字幕还在提取中，现在返回主页将离开进度页。
          {user
            ? '提取会继续在后台完成，你可以稍后在历史记录中找到它。'
            : '未登录状态下，提取结果将不会保留。'}
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <Button block onClick={() => setLeaveConfirm(false)}>再等等</Button>
          <Button
            block
            danger
            onClick={() => { setLeaveConfirm(false); goHome() }}
            style={{ borderRadius: 'var(--r-btn)' }}
          >
            返回主页
          </Button>
        </div>
      </Modal>

      {/* 历史记录（点记录直接回结果页） */}
      <HistoryModal
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        onOpenRecord={(data) => { setChatOpen(false); setTaskData(data); setPage('result') }}
      />

      {/* 会员开通欢迎（webhook 发货后回站，档位跃迁触发撒花） */}
      {celebrateTier && <Confetti />}
      <Modal
        open={!!celebrateTier}
        footer={null}
        onCancel={() => setCelebrateTier(null)}
        centered
        width={360}
      >
        {celebrateTier && (() => {
          const isChenXing = user?.uid === 100001 && celebrateTier === 'stella'
          if (isChenXing) {
            // UID 100001 专属寄语（仅首位逐星者兑换 Stella 时呈现）
            return (
              <div style={{ textAlign: 'center', padding: '12px 0 4px' }}>
                <div className="font-display" style={{ fontSize: 30, color: 'var(--accent)', lineHeight: 1 }}>✦</div>
                <h2 className="font-display font-display-sm" style={{ margin: '10px 0 6px' }}>
                  欢迎登船，{user?.nickname || 'Stella'}
                </h2>
                <div style={{ fontSize: 13, color: 'var(--mute)', lineHeight: 1.9, marginBottom: 14 }}>
                  Stella · 启明 会员权益已生效
                </div>
                <div className="font-display" style={{
                  fontSize: 16, color: 'var(--ink)', lineHeight: 1.8,
                  padding: '12px 16px', marginBottom: 8,
                  background: 'var(--surface-2)', borderRadius: 'var(--r-input)',
                  fontFamily: "'Cormorant Garamond', serif", fontStyle: 'normal',
                }}>
                  「星！希望你喜欢，有问题随时可以和我反馈~」
                </div>
                <Button
                  type="primary" style={{ marginTop: 14, borderRadius: 'var(--r-btn)' }}
                  onClick={() => setCelebrateTier(null)}
                >
                  开始远航
                </Button>
              </div>
            )
          }
          return (
            <div style={{ textAlign: 'center', padding: '12px 0 4px' }}>
              <div className="font-display" style={{ fontSize: 30, color: 'var(--accent)', lineHeight: 1 }}>✦</div>
              <h2 className="font-display font-display-sm" style={{ margin: '10px 0 6px' }}>
                欢迎登船，{tierMeta(celebrateTier).label}
              </h2>
              <div style={{ fontSize: 13, color: 'var(--mute)', lineHeight: 1.9 }}>
                {tierMeta(celebrateTier).cn && <>{tierMeta(celebrateTier).cn} · </>}会员权益已生效<br />
                愿星轨常伴你左右
              </div>
              <Button
                type="primary" style={{ marginTop: 18, borderRadius: 'var(--r-btn)' }}
                onClick={() => setCelebrateTier(null)}
              >
                开始远航
              </Button>
            </div>
          )
        })()}
      </Modal>

      {/* 流星雨彩蛋（连点 logo 7 次） */}
      {meteorOn && <MeteorShower />}

      {/* ═══════════════════════════════════════════
          Starlight Design Tokens & Global Styles
         ═══════════════════════════════════════════ */}
      <style>{`
        /* ── Design Tokens ── */
        :root {
          /* Surface */
          --canvas: #fafafa;
          --surface-1: #ffffff;
          --surface-2: #f5f5f5;

          /* Border */
          --hairline: #eaeaea;
          --hairline-strong: #e0e0e0;

          /* Text */
          --ink: #171717;
          --body: #525252;
          --mute: #a3a3a3;

          /* Brand */
          --accent: #4f46e5;
          --accent-hover: #4338ca;
          --accent-light: #eef2ff;

          /* Semantic */
          --success: #16a34a;
          --success-bg: #f0fdf4;
          --error: #dc2626;
          --error-bg: #fef2f2;

          /* Radius */
          --r-btn: 8px;
          --r-card: 10px;
          --r-input: 8px;

          /* Shadow levels (Vercel stacked) */
          --shadow-l1: inset 0 0 0 1px rgba(0,0,0,0.04);
          --shadow-l2:
            0 1px 1px rgba(0,0,0,0.04),
            0 2px 2px rgba(0,0,0,0.03),
            var(--shadow-l1);
          --shadow-l3:
            0 2px 4px rgba(0,0,0,0.05),
            0 4px 12px rgba(0,0,0,0.03),
            var(--shadow-l1);
          --shadow-focus: 0 0 0 3px rgba(79,70,229,0.10);
        }

        /* ── Reset & Base ── */
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

        body {
          font-family: 'Inter', -apple-system, 'SF Pro Text', sans-serif;
          font-size: 15px;
          line-height: 1.55;
          color: var(--body);
          background: var(--canvas);
          -webkit-font-smoothing: antialiased;
          -moz-osx-font-smoothing: grayscale;
          letter-spacing: -0.01em;
        }

        /* ── Typography Scale (Claude-inspired serif/sans split) ── */

        /* Display: Cormorant Garamond serif — for hero & section headings only */
        .font-display {
          font-family: 'Cormorant Garamond', 'Times New Roman', serif;
          font-weight: 600;
          letter-spacing: -0.02em;
          color: var(--ink);
        }

        .font-display-lg { font-size: 40px; line-height: 1.15; letter-spacing: -0.03em; }
        .font-display-md { font-size: 28px; line-height: 1.2; letter-spacing: -0.015em; }
        .font-display-sm { font-size: 22px; line-height: 1.25; letter-spacing: -0.01em; }
        .font-display-xs { font-size: 18px; line-height: 1.3; }
        .tier-benefit b { color: var(--accent); font-weight: 600; }

        /* Body: Inter sans */
        .font-body {
          font-family: 'Inter', -apple-system, sans-serif;
          color: var(--body);
        }

        .font-body-strong { font-weight: 500; color: var(--ink); }

        /* Caption / Label */
        .font-caption {
          font-size: 13px;
          font-weight: 500;
          color: var(--mute);
          letter-spacing: 0.02em;
        }

        .font-mono {
          font-family: 'JetBrains Mono', ui-monospace, monospace;
          font-size: 13px;
        }

        /* ── Card System (flat white + hairline + stacked micro-shadow) ── */
        .card {
          background: var(--surface-1);
          border-radius: var(--r-card);
          box-shadow: var(--shadow-l1);
          transition: box-shadow 0.2s ease;
        }
        .card:hover {
          box-shadow: var(--shadow-l3);
        }
        .card--elevated {
          box-shadow: var(--shadow-l2);
        }

        /* ── Primary CTA Button Override ── */
        .ant-btn-primary {
          background: var(--accent) !important;
          border-color: var(--accent) !important;
          color: #fff !important;
          border-radius: var(--r-btn) !important;
          font-weight: 500 !important;
          box-shadow: none !important;
          height: 44px !important;
          transition: all 0.15s ease !important;
        }
        .ant-btn-primary:hover {
          background: var(--accent-hover) !important;
          border-color: var(--accent-hover) !important;
          box-shadow: 0 2px 12px rgba(79,70,229,0.20) !important;
        }
        .ant-btn-primary:active {
          transform: scale(0.98);
        }

        /* ── Input Override ── */
        .ant-input,
        .ant-input-affix-wrapper,
        .ant-input-password {
          border-radius: var(--r-input) !important;
          border-color: var(--hairline) !important;
          font-size: 15px !important;
          transition: all 0.15s ease !important;
        }
        .ant-input:focus,
        .ant-input-affix-wrapper-focused,
        .ant-input-password:focus-within {
          border-color: var(--accent) !important;
          box-shadow: var(--shadow-focus) !important;
        }

        /* ── Upload.Dragger ── */
        .ant-upload-drag {
          border-radius: var(--r-card) !important;
          border-color: var(--hairline) !important;
          background: var(--surface-2) !important;
          transition: border-color 0.15s ease !important;
        }
        .ant-upload-drag:hover {
          border-color: var(--accent) !important;
        }

        /* ── Tabs ── */
        .ant-tabs-nav::before {
          border-bottom: 1px solid var(--hairline) !important;
        }

        /* ── Collapse ghost ── */
        .ant-collapse-ghost > .ant-collapse-item > .ant-collapse-header {
          padding: 8px 0 !important;
        }

        /* ── 下载行 hover 微反馈 ── */
        .dl-row { transition: background 0.15s ease; }
        .dl-row:hover { background: var(--surface-2); }

        /* ═══════════════════════════════════════
           Motion System（Apple 式克制动效）
           时长 0.2-0.6s，ease 曲线统一，无弹跳
           ═══════════════════════════════════════ */

        /* 页面级进入：轻微上浮 + 淡入 */
        @keyframes pageEnter {
          from { opacity: 0; transform: translateY(10px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        .page-enter { animation: pageEnter 0.4s cubic-bezier(0.4, 0, 0.2, 1) both; }

        /* 预估确认卡滑入 */
        @keyframes estimateEnter {
          from { opacity: 0; transform: translateY(-6px) scale(0.99); }
          to   { opacity: 1; transform: translateY(0) scale(1); }
        }
        .estimate-enter { animation: estimateEnter 0.35s cubic-bezier(0.4, 0, 0.2, 1) both; }

        /* 进行中节点：呼吸脉冲光环 */
        @keyframes pulseRing {
          0%   { transform: scale(1);    opacity: 0.5; }
          70%  { transform: scale(1.75); opacity: 0; }
          100% { transform: scale(1.75); opacity: 0; }
        }
        .pulse-ring {
          position: absolute;
          border-radius: 50%;
          border: 2px solid var(--accent);
          animation: pulseRing 1.8s cubic-bezier(0.4, 0, 0.2, 1) infinite;
          pointer-events: none;
        }

        /* 节点内转动指示（比 Spin 更轻的线性旋转） */
        @keyframes nodeSpin {
          to { transform: rotate(360deg); }
        }
        .node-spin { animation: nodeSpin 1s linear infinite; }

        /* 完成打勾弹入 */
        @keyframes checkPop {
          0%   { transform: scale(0.4); opacity: 0; }
          60%  { transform: scale(1.15); opacity: 1; }
          100% { transform: scale(1); }
        }
        .check-pop { animation: checkPop 0.35s cubic-bezier(0.4, 0, 0.2, 1) both; }

        /* 进度条流光（缓冲感）：高光条持续扫过 */
        .progress-shimmer {
          position: absolute;
          top: 0; left: 0; right: 0; bottom: 0;
          background: linear-gradient(
            90deg,
            transparent 0%,
            rgba(255,255,255,0.45) 50%,
            transparent 100%
          );
          background-size: 40% 100%;
          background-repeat: no-repeat;
          animation: shimmerSweep 1.6s ease-in-out infinite;
        }
        @keyframes shimmerSweep {
          from { background-position: -40% 0; }
          to   { background-position: 140% 0; }
        }

        /* 状态文字省略号逐个浮现 */
        .ellipsis-anim span {
          display: inline-block;
          animation: ellipsisFade 1.4s infinite;
          opacity: 0;
        }
        .ellipsis-anim span:nth-child(2) { animation-delay: 0.25s; }
        .ellipsis-anim span:nth-child(3) { animation-delay: 0.5s; }
        @keyframes ellipsisFade {
          0%, 60%, 100% { opacity: 0; }
          30% { opacity: 1; }
        }

        /* ── AI 解读面板 ── */
        /* 右栏滑入：等容器扩宽后再入场（延迟 0.15s） */
        @keyframes chatPanelEnter {
          from { opacity: 0; transform: translateX(24px); }
          to   { opacity: 1; transform: translateX(0); }
        }
        .chat-panel-enter {
          animation: chatPanelEnter 0.4s cubic-bezier(0.4, 0, 0.2, 1) 0.15s both;
        }

        /* 设置二级界面推入（iOS push 感：右滑入 + 淡入） */
        @keyframes subviewEnter {
          from { opacity: 0; transform: translateX(28px); }
          to   { opacity: 1; transform: translateX(0); }
        }
        .subview-enter { animation: subviewEnter 0.38s cubic-bezier(0.4, 0, 0.2, 1) both; }
        /* 二级界面退出（右滑出 + 淡出；覆盖式结构，主界面始终在底下不卸载） */
        @keyframes subviewExit {
          from { opacity: 1; transform: translateX(0); }
          to   { opacity: 0; transform: translateX(28px); }
        }
        .subview-exit { animation: subviewExit 0.32s cubic-bezier(0.4, 0, 0.2, 1) both; }

        /* 会员卡 hover：克制的浮起（抬离桌面感，非弹跳） */
        .member-card {
          transition: transform 0.35s cubic-bezier(0.4, 0, 0.2, 1),
                      box-shadow 0.35s cubic-bezier(0.4, 0, 0.2, 1);
        }
        .member-card:hover {
          transform: translateY(-5px);
          box-shadow: 0 16px 44px rgba(49, 46, 129, 0.10),
                      0 4px 14px rgba(0, 0, 0, 0.05);
        }
        .member-card-head { transition: filter 0.35s cubic-bezier(0.4, 0, 0.2, 1); }
        .member-card:hover .member-card-head { filter: brightness(1.07); }

        /* AntD 弹窗 ✕：去掉 focus 紫框，保持纯字符（a11y 由 Esc/点击遮罩兜底） */
        .ant-modal-close:focus,
        .ant-modal-close:focus-visible,
        .ant-drawer-close:focus,
        .ant-drawer-close:focus-visible {
          outline: none !important;
          box-shadow: none !important;
        }

        /* 消息气泡入场 */
        @keyframes chatMsgEnter {
          from { opacity: 0; transform: translateY(8px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        .chat-msg-enter { animation: chatMsgEnter 0.25s cubic-bezier(0.4, 0, 0.2, 1) both; }

        /* 三点弹跳 loading */
        .chat-dot {
          display: inline-block;
          width: 6px; height: 6px;
          border-radius: 50%;
          background: var(--hairline-strong);
          margin-right: 5px;
          animation: chatDotBounce 1.2s ease-in-out infinite;
        }
        .chat-dot:nth-child(2) { animation-delay: 0.15s; }
        .chat-dot:nth-child(3) { animation-delay: 0.3s; margin-right: 0; }
        @keyframes chatDotBounce {
          0%, 60%, 100% { transform: translateY(0); opacity: 0.5; }
          30% { transform: translateY(-4px); opacity: 1; }
        }

        /* 建议问题 chip */
        .chat-chip {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          text-align: left;
          padding: 9px 14px;
          background: var(--surface-1);
          border: 1px solid var(--hairline);
          border-radius: var(--r-input);
          color: var(--body);
          font-size: 13px;
          cursor: pointer;
          transition: border-color 0.2s, color 0.2s, transform 0.15s;
        }
        .chat-chip:hover {
          border-color: var(--accent);
          color: var(--accent);
          transform: translateX(2px);
        }
        .chat-chip-cost {
          font-size: 11px;
          color: var(--mute);
          font-family: 'JetBrains Mono', ui-monospace, monospace;
          flex-shrink: 0;
        }
        .chat-chip:hover .chat-chip-cost { color: var(--accent); opacity: 0.8; }

        /* AI 气泡额度行：用量信息 + 复制按钮（沉浸行内，右端） */
        .chat-usage { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
        .chat-usage-base { order: 1; }
        .chat-usage-extra { order: 2; display: inline-flex; gap: 0; }
        .chat-usage-copy {
          order: 3;
          margin-left: auto;
          font-size: 11px;
          color: var(--hairline-strong);
          cursor: pointer;
          transition: color 0.15s;
        }
        .chat-usage-copy:hover { color: var(--accent); }

        /* 本次消耗扣费段：PC 与前段同行（::before 补分隔点）；移动端换块级到第二行 */
        .consume-charges::before { content: ' · '; }

        /* AI 解读入口卡 */
        .chat-entry {
          display: flex;
          align-items: center;
          gap: 12px;
          width: 100%;
          padding: 14px 16px;
          background: var(--accent-light);
          border: 1px solid transparent;
          border-radius: var(--r-card);
          cursor: pointer;
          transition: border-color 0.2s, transform 0.15s, box-shadow 0.2s;
        }
        .chat-entry:hover {
          border-color: var(--accent);
          transform: translateY(-1px);
          box-shadow: 0 4px 14px rgba(0, 0, 0, 0.06);
        }
        .chat-entry:disabled {
          opacity: 0.4;
          cursor: not-allowed;
          transform: none;
          box-shadow: none;
        }

        /* 窄屏：分栏折行为上下堆叠，面板给固定高度 */
        @media (max-width: 1100px) {
          .chat-panel-enter { height: 70vh !important; min-width: 0 !important; }
        }

        /* ═══ MOBILE ONLY — 所有规则必须包在此 @media 内，拆出会污染 PC（PC 视口>768 不命中）═══ */
        @media (max-width: 768px) {
          /* 三胶囊隐藏（内联 pillStyle 有 display:inline-flex，需 !important 压制）；余额并入头像下拉 */
          .billing-pill { display: none !important; }
          /* 容器两侧 padding 收紧 */
          .app-shell-nav { padding: 12px 14px 10px !important; }
          .app-shell-content { padding: 36px 14px 80px !important; }
          /* Modal 兜底：不强制宽度（尊重各弹窗设计宽度），只约束不超出视口；
             两边各留 24px 边距让弹窗浮于中央，避免贴边臃肿；长内容纵向滚动 */
          .ant-modal {
            max-width: calc(100vw - 64px) !important;
            margin: 16px auto !important;
          }
          .ant-modal-body { max-height: calc(100vh - 160px); overflow-y: auto; }
          /* 结果页分栏栈式：左卡固定宽失效，AI 解读面板下沉全宽 */
          .result-card-chat { width: 100% !important; flex: 1 1 100% !important; }
          .chat-panel-enter {
            flex: 1 1 100% !important;
            min-width: 0 !important;
            height: auto !important;
            min-height: 60vh !important;
          }
          /* 元信息标签列缩窄 */
          .result-meta-grid { grid-template-columns: 56px 1fr !important; }
          /* 内容概要标题栏：消耗信息换到第二行（标题 + 增值标签 + 操作按钮一行排不下） */
          .summary-header-cost { display: block; margin-left: 0 !important; margin-top: 3px; }
          /* 本次消耗：扣费段换第二行（第一行消耗量、第二行扣费，不跨行） */
          .consume-charges { display: block; }
          .consume-charges::before { content: ''; }
          /* AI 解读顶栏累计引力波：移动端隐藏（一行排不下，PC 保留完整显示） */
          .chat-total-gravity { display: none; }
          /* 首页 hero 光晕裁切（480px 绝对定位光晕超出窄屏视口 → 撑宽容器的元凶） */
          .hero-glow-container { overflow: hidden; }
          /* 首页副标题换行：PC 端一行，移动端拆两行更均衡 */
          .hero-subtitle-line2 { display: block; }
          /* 结果页按钮组窄屏折行 */
          .result-actions .ant-space { display: flex !important; flex-wrap: wrap; justify-content: center; }
          /* 进度条 4 步骤改成 2×2 拼图卡片，每块撑满 50%，宽度 = 下方百分比条 */
          .progress-steps { display: grid !important; grid-template-columns: 1fr 1fr; gap: 10px; }
          .progress-steps > div {
            flex: 1 !important;
            max-width: 100% !important;
            background: var(--surface-2);
            border-radius: var(--r-input);
            padding: 12px 6px;
            justify-content: center !important;
          }
          .progress-connector { display: none !important; }
        }
        /* ═══ END MOBILE ONLY ═══ */

        /* ── 全局质感细节 ── */
        /* 细滚动条：透明轨道 + 弱色滑块，hover 稍深 */
        ::-webkit-scrollbar { width: 8px; height: 8px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb {
          background: var(--hairline);
          border-radius: 9999px;
        }
        ::-webkit-scrollbar-thumb:hover { background: var(--hairline-strong); }
        * { scrollbar-width: thin; scrollbar-color: var(--hairline) transparent; }

        /* 文本选中色：淡品牌色底，不刺眼 */
        ::selection { background: var(--accent-light); color: var(--accent); }

        /* 输入框焦点：2px 柔和光晕（替代 AntD 默认硬边） */
        .ant-input:focus,
        .ant-input-focused,
        .ant-input-affix-wrapper:focus,
        .ant-input-affix-wrapper-focused {
          box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.12) !important;
          border-color: var(--accent) !important;
        }

        /* 星点闪烁（藏星主题基调动效） */
        @keyframes starTwinkle {
          0%, 100% { opacity: 0.15; transform: scale(0.85); }
          50%      { opacity: 0.9;  transform: scale(1.1); }
        }
        .star-dot {
          position: absolute;
          color: var(--accent);
          font-family: 'Cormorant Garamond', serif;
          line-height: 1;
          pointer-events: none;
          animation: starTwinkle 3.2s ease-in-out infinite;
        }

        /* 品牌 logo 悬停闪烁（心意彩蛋 · 其一） */
        @keyframes logoSparkle {
          0%, 100% { transform: rotate(0deg) scale(1); }
          25%      { transform: rotate(-12deg) scale(1.15); }
          75%      { transform: rotate(10deg) scale(1.1); }
        }
        .brand-star { display: inline-block; transition: transform 0.3s ease; }
        .brand-star:hover { animation: logoSparkle 0.6s ease-in-out; }

        /* 进度条彗星头：前缘一点柔光，像星轨划过 */
        .comet-head {
          position: absolute;
          right: -4px;
          top: 50%;
          transform: translateY(-50%);
          width: 10px;
          height: 10px;
          border-radius: 50%;
          background: #fff;
          box-shadow: 0 0 8px 2px rgba(129, 140, 248, 0.55);
        }

        /* 下拉面板条目 */
        .dropdown-item {
          padding: 10px 16px;
          font-size: 13px;
          color: var(--body);
          cursor: pointer;
          transition: background 0.15s;
        }
        .dropdown-item:hover { background: var(--surface-2); }
        .dropdown-item--danger { color: var(--error); }

        /* 页脚小诗：默认隐去，悬停签名区浮现 */
        .footer-poem {
          opacity: 0;
          transform: translateY(4px);
          transition: opacity 0.4s ease, transform 0.4s ease;
        }
        .footer-sig:hover .footer-poem {
          opacity: 0.9;
          transform: translateY(0);
        }

        /* 卡片悬停微浮起（精化微交互） */
        .card { transition: transform 0.2s ease, box-shadow 0.2s ease; }
        .card:hover {
          transform: translateY(-1px);
          box-shadow: 0 4px 16px rgba(0, 0, 0, 0.05);
        }

        /* 按钮按压回弹 */
        .ant-btn:active { transform: scale(0.97); }

        /* 尊重系统减弱动效设置 */
        @media (prefers-reduced-motion: reduce) {
          .page-enter, .estimate-enter, .check-pop,
          .pulse-ring, .node-spin, .progress-shimmer,
          .ellipsis-anim span, .chat-panel-enter, .subview-enter, .subview-exit,
          .chat-msg-enter, .chat-dot,
          .star-dot, .brand-star:hover { animation: none !important; }
        }
      `}</style>
    </Layout>
  )
}
