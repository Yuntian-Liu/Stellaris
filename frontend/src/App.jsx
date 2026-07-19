/**
 * Stellaris 根组件 — Starlight 设计系统
 *
 * 设计哲学：
 *   Apple 极简克制 + Claude 衬线编辑感 + Vercel 开发者精度
 *   暖白底 / Indigo 品牌色 / 零装饰性渐变 / 堆叠微投影
 */
import { useState, useCallback, useEffect } from 'react'
import { Layout, Tooltip, Button, Dropdown, Avatar } from 'antd'
import { WalletOutlined, LogoutOutlined, LoginOutlined } from '@ant-design/icons'
import HomePage from './pages/HomePage'
import ProgressPage from './pages/ProgressPage'
import ResultPage from './pages/ResultPage'
import AuthPage from './pages/AuthPage'
import { useAuth } from './contexts/AuthContext'

const { Content } = Layout

export default function App() {
  const [page, setPage] = useState('home')
  const [taskId, setTaskId] = useState(null)
  const [taskData, setTaskData] = useState(null)
  const { user, loading, logout } = useAuth()

  // 401(token 失效)→ 跳登录页
  useEffect(() => {
    const handler = () => setPage('auth')
    window.addEventListener('stellaris:unauthorized', handler)
    return () => window.removeEventListener('stellaris:unauthorized', handler)
  }, [])

  const handleSubmit = useCallback((data) => {
    setTaskId(data.task_id)
    setPage('progress')
  }, [])

  const handleComplete = useCallback((data) => {
    setTaskData(data)
    setPage('result')
  }, [])

  const handleBack = useCallback(() => {
    setPage('home')
    setTaskId(null)
    setTaskData(null)
  }, [])

  return (
    <Layout style={{ minHeight: '100vh', background: 'var(--canvas)' }}>
      {/* ── 顶部导航栏（预留用户系统 / 设置二级界面入口）── */}
      <div style={{
        maxWidth: 760,
        margin: '0 auto',
        width: '100%',
        padding: '18px 24px 0',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}>
        {/* 品牌 wordmark(可点回首页) */}
        <div
          onClick={() => setPage('home')}
          style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}
          role="button"
        >
          <span style={{ color: 'var(--accent)', fontSize: 17, lineHeight: 1, fontFamily: "'Cormorant Garamond', serif" }}>✦</span>
          <span className="font-display" style={{ fontSize: 17, fontWeight: 600, color: 'var(--ink)' }}>
            Stellaris
          </span>
        </div>
        {/* 右侧入口位:loading 占位;已登录→引力波额度+头像 Dropdown;未登录→登录按钮 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {loading ? (
            <div style={{ width: 64, height: 30 }} />
          ) : user ? (
            <>
              <Tooltip title="引力波额度(计费板块上线后接入)">
                <div style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '5px 12px',
                  background: 'var(--surface-1)',
                  border: '1px solid var(--hairline)',
                  borderRadius: '9999px',
                  cursor: 'default',
                }}>
                  <WalletOutlined style={{ fontSize: 12, color: 'var(--mute)' }} />
                  <span className="font-caption" style={{ fontSize: 12 }}>引力波</span>
                  <span className="font-mono" style={{ fontSize: 12, color: 'var(--hairline-strong)' }}>--</span>
                </div>
              </Tooltip>
              <Dropdown menu={{
                items: [
                  { key: 'uid', label: `UID ${user.uid}`, disabled: true },
                  { type: 'divider' },
                  { key: 'logout', label: '退出登录', icon: <LogoutOutlined />, danger: true },
                ],
                onClick: ({ key }) => {
                  if (key === 'logout') { logout(); setPage('home') }
                },
              }} placement="bottomRight">
                <Avatar
                  size={30}
                  src={`https://api.dicebear.com/7.x/micah/svg?seed=${user.avatar_seed}`}
                  style={{ cursor: 'pointer', border: '1px solid var(--hairline)' }}
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

      <Content style={{
        maxWidth: 760,
        margin: '0 auto',
        padding: '48px 24px 96px',
        width: '100%',
      }}>
        {page === 'auth' && (
          <AuthPage
            onSuccess={() => setPage('home')}
            onBack={() => setPage('home')}
          />
        )}
        {page === 'home' && (
          <HomePage onSubmit={handleSubmit} />
        )}
        {page === 'progress' && taskId && (
          <ProgressPage
            taskId={taskId}
            onComplete={handleComplete}
            onBack={handleBack}
          />
        )}
        {page === 'result' && taskData && (
          <ResultPage
            taskData={taskData}
            onBack={handleBack}
            onNew={() => handleBack()}
          />
        )}
      </Content>

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

        /* 尊重系统减弱动效设置 */
        @media (prefers-reduced-motion: reduce) {
          .page-enter, .estimate-enter, .check-pop,
          .pulse-ring, .node-spin, .progress-shimmer,
          .ellipsis-anim span { animation: none !important; }
        }
      `}</style>
    </Layout>
  )
}
