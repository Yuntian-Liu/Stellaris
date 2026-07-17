/**
 * Stellaris 根组件 — Starlight 设计系统
 *
 * 设计哲学：
 *   Apple 极简克制 + Claude 衬线编辑感 + Vercel 开发者精度
 *   暖白底 / Indigo 品牌色 / 零装饰性渐变 / 堆叠微投影
 */
import { useState, useCallback } from 'react'
import { Layout } from 'antd'
import HomePage from './pages/HomePage'
import ProgressPage from './pages/ProgressPage'
import ResultPage from './pages/ResultPage'

const { Content } = Layout

export default function App() {
  const [page, setPage] = useState('home')
  const [taskId, setTaskId] = useState(null)
  const [taskData, setTaskData] = useState(null)

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
      <Content style={{
        maxWidth: 760,
        margin: '0 auto',
        padding: '72px 24px 96px',
        width: '100%',
      }}>
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

        /* ── Steps ── */
        .ant-steps-item-title {
          font-size: 13px !important;
          color: var(--mute) !important;
        }
        .ant-steps-item-process .ant-steps-item-title {
          color: var(--body) !important;
          font-weight: 500 !important;
        }

        /* ── Collapse ghost ── */
        .ant-collapse-ghost > .ant-collapse-item > .ant-collapse-header {
          padding: 8px 0 !important;
        }
      `}</style>
    </Layout>
  )
}
