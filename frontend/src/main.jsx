import React from 'react'
import ReactDOM from 'react-dom/client'
import { ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import 'katex/dist/katex.min.css'
import App from './App'
import { AuthProvider } from './contexts/AuthContext'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ConfigProvider
      locale={zhCN}
      theme={{
        token: {
          /* ── Brand ── */
          colorPrimary: '#4f46e5',
          colorSuccess: '#16a34a',
          colorError: '#dc2626',

          /* ── Radius: Apple/Notion克制 ── */
          borderRadius: 8,
          borderRadiusLG: 10,
          borderRadiusSM: 6,

          /* ── Font: Inter body (serif headings handled in CSS) ── */
          fontFamily: "'Inter', -apple-system, 'SF Pro Text', sans-serif",

          /* ── Controls: Apple 44px touch target ── */
          controlHeight: 44,
          controlHeightLG: 48,
          paddingContentHorizontal: 16,

          /* ── Surface: Vercel near-white ── */
          colorBgContainer: '#ffffff',
          colorBgLayout: '#fafafa',
          colorBorder: '#eaeaea',
          colorBorderSecondary: '#f0f0f0',

          /* ── Text: Vercel ink scale ── */
          colorText: '#171717',
          colorTextSecondary: '#525252',
          colorTextTertiary: '#a3a3a3',

          /* ── Shadow: stacked micro, never heavy ── */
          boxShadow: '0 1px 1px rgba(0,0,0,0.04), 0 2px 2px rgba(0,0,0,0.03)',
          boxShadowSecondary: '0 2px 4px rgba(0,0,0,0.05), 0 4px 12px rgba(0,0,0,0.03)',
        },
        components: {
          Button: {
            primaryShadow: 'none',           /* Apple: CTA 无默认投影 */
            borderRadius: 8,
            controlHeight: 44,
            fontWeight: 500,
          },
          Input: {
            borderRadius: 8,
            activeBorderColor: '#4f46e5',
            hoverBorderColor: '#c7d2fe',
          },
          Card: {
            borderRadiusLG: 10,
          },
          Steps: {
            dotCurrentColor: '#4f46e5',
            dotSize: 6,
          },
          Progress: {
            defaultColor: '#eaeaea',
            lineRadius: 100,
          },
          Collapse: {
            headerBg: 'transparent',
            contentBg: 'transparent',
            borderRadiusLG: 8,
          },
          Upload: {
            borderRadius: 10,
          },
          Tabs: {
            inkBarColor: '#4f46e5',
            itemActiveColor: '#171717',
            itemSelectedColor: '#171717',
          },
        },
      }}
    >
      <AuthProvider>
        <App />
      </AuthProvider>
    </ConfigProvider>
  </React.StrictMode>,
)
