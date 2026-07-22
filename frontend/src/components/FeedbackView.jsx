/**
 * 反馈与建议（V0.9.4）— 设置页二级界面（overlay 滑入）
 * 四个并列入口卡片：提交工单 / 我的工单 / 发送邮件 / GitHub Issues
 * - 提交工单 / 我的工单：点开都是弹窗（语义统一）
 * - 邮件：mailto 外链；GitHub：新窗口打开 Issues
 * 主次区分：提交工单高亮（accent 边框 + 推荐 胶囊），其余常规卡片
 */
import { useState, useEffect, useCallback } from 'react'
import { Button } from 'antd'
import {
  ArrowLeftOutlined, EditOutlined, UnorderedListOutlined,
  MailOutlined, GithubOutlined,
} from '@ant-design/icons'
import { ticketApi } from '../hooks/api'
import TicketSubmitModal from './TicketSubmitModal'
import TicketListModal from './TicketListModal'

const GITHUB_ISSUES = 'https://github.com/Yuntian-Liu/stellaris/issues/new'
const CONTACT_EMAIL = 'liuyuntian@ytunx.com'   // TODO: 碳碳确认公开反馈邮箱

export default function FeedbackView({ onBack }) {
  const [submitOpen, setSubmitOpen] = useState(false)
  const [listOpen, setListOpen] = useState(false)
  const [listRefreshKey, setListRefreshKey] = useState(0)
  const [hasUnread, setHasUnread] = useState(false)

  // 检查是否有未读回复（「我的工单」卡片红点）
  const checkUnread = useCallback(async () => {
    try {
      const r = await ticketApi.listMine()
      setHasUnread((r.items || []).some((t) => t.unread))
    } catch {
      setHasUnread(false)
    }
  }, [])

  useEffect(() => { checkUnread() }, [checkUnread])

  // 提交成功后 → 打开列表弹窗 + 刷新未读
  const handleSubmitted = () => {
    setListRefreshKey((k) => k + 1)
    setListOpen(true)
    checkUnread()
  }

  const entries = [
    {
      key: 'submit',
      icon: <EditOutlined />,
      title: '提交工单',
      desc: '系统化反馈问题或建议，附带诊断日志协助排查，在线追踪处理进度',
      primary: true,
      onClick: () => setSubmitOpen(true),
    },
    {
      key: 'mine',
      icon: <UnorderedListOutlined />,
      title: '我的工单',
      desc: '查看你提交过的工单与开发者回复',
      badge: hasUnread,
      onClick: () => { setListRefreshKey((k) => k + 1); setListOpen(true); checkUnread() },
    },
    {
      key: 'mail',
      icon: <MailOutlined />,
      title: '发送邮件',
      desc: '紧急问题或需私下沟通，直达开发者邮箱',
      href: `mailto:${CONTACT_EMAIL}`,
    },
    {
      key: 'github',
      icon: <GithubOutlined />,
      title: 'GitHub Issues',
      desc: '开发者与相关从业者，通过 Issue 跟踪技术问题',
      href: GITHUB_ISSUES,
      external: true,
    },
  ]

  return (
    <div style={{ maxWidth: 560, margin: '-14px auto 0' }}>
      {/* 返回 + 标题（与会员权益/消耗记录二级界面同款） */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <Button type="text" icon={<ArrowLeftOutlined />} onClick={onBack} />
        <h1 className="font-display font-display-sm" style={{ margin: 0 }}>反馈与建议</h1>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 20 }}>
        {entries.map((e) => {
          const cardStyle = {
            display: 'block', textDecoration: 'none',
            padding: '16px 18px', position: 'relative',
            background: 'var(--surface-1)',
            borderRadius: 'var(--r-card)',
            boxShadow: e.primary
              ? '0 0 0 1.5px var(--accent), var(--shadow-l2)'
              : 'var(--shadow-l1)',
            transition: 'transform 0.2s ease, box-shadow 0.2s ease',
            cursor: 'pointer',
          }
          const onHover = (ev) => {
            ev.currentTarget.style.transform = 'translateY(-3px)'
            ev.currentTarget.style.boxShadow = e.primary
              ? '0 0 0 1.5px var(--accent), var(--shadow-l3)'
              : 'var(--shadow-l3)'
          }
          const onLeave = (ev) => {
            ev.currentTarget.style.transform = 'translateY(0)'
            ev.currentTarget.style.boxShadow = e.primary
              ? '0 0 0 1.5px var(--accent), var(--shadow-l2)'
              : 'var(--shadow-l1)'
          }
          const inner = (
            <>
              {e.primary && (
                <span style={{
                  position: 'absolute', top: 12, right: 14,
                  fontSize: 11, fontWeight: 500, letterSpacing: '0.05em',
                  color: 'var(--accent)', background: 'var(--accent-light)',
                  borderRadius: 9999, padding: '2px 10px',
                }}>
                  推荐
                </span>
              )}
              {e.badge && (
                <span style={{
                  position: 'absolute', top: 14, right: 16,
                  width: 8, height: 8, borderRadius: '50%', background: 'var(--accent)',
                }} />
              )}
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                <span style={{
                  fontSize: 18, color: e.primary ? 'var(--accent)' : 'var(--ink)',
                  marginTop: 2, flexShrink: 0,
                }}>
                  {e.icon}
                </span>
                <div style={{ flex: 1, minWidth: 0, paddingRight: e.primary ? 48 : 0 }}>
                  <div style={{
                    fontSize: 15, fontWeight: 600, color: 'var(--ink)', marginBottom: 4,
                  }}>
                    {e.title}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--mute)', lineHeight: 1.7 }}>
                    {e.desc}
                  </div>
                </div>
              </div>
            </>
          )
          // 外链用 <a>，站内动作用 <div>（避免动态组件标签的小写解析陷阱）
          if (e.href) {
            return (
              <a key={e.key} href={e.href}
                {...(e.external ? { target: '_blank', rel: 'noreferrer' } : {})}
                style={cardStyle} onMouseEnter={onHover} onMouseLeave={onLeave}>
                {inner}
              </a>
            )
          }
          return (
            <div key={e.key} style={cardStyle} onClick={e.onClick}
              onMouseEnter={onHover} onMouseLeave={onLeave}>
              {inner}
            </div>
          )
        })}
      </div>

      <TicketSubmitModal
        open={submitOpen}
        onClose={() => setSubmitOpen(false)}
        onSubmitted={handleSubmitted}
      />
      <TicketListModal
        open={listOpen}
        onClose={() => setListOpen(false)}
        refreshKey={listRefreshKey}
        onTicketRead={() => checkUnread()}
      />
    </div>
  )
}
