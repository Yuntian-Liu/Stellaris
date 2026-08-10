/**
 * 管理看板（V0.9.0）— 覆盖式二级界面，仅 is_admin 可见入口
 * 四板块（Tabs）：数据看板 / 用户管理 / 兑换码 / 订单核验
 * 数据全部走 adminApi（后端 get_admin_user 守卫，非 admin 403）
 */
import { useState, useEffect, useCallback, useRef } from 'react'
import {
  Button, Tabs, Table, Tag, Input, InputNumber, Select, Modal, DatePicker,
  Empty, Tooltip, message, Radio, Collapse, Switch, Upload, Segmented,
} from 'antd'
import {
  ArrowLeftOutlined, SearchOutlined, CopyOutlined, ReloadOutlined,
  DownOutlined, UpOutlined, ClockCircleOutlined, DotChartOutlined,
  GlobalOutlined, SwapOutlined, GiftOutlined, ToolOutlined, DownloadOutlined,
  CloudUploadOutlined, FolderOutlined, FolderAddOutlined, FileOutlined, InboxOutlined, LockOutlined,
} from '@ant-design/icons'
import {
  ResponsiveContainer, ComposedChart, BarChart, Bar, Line, AreaChart, Area,
  XAxis, YAxis, Tooltip as ChartTooltip, CartesianGrid, Legend,
} from 'recharts'
import ReactMarkdown from 'react-markdown'
import remarkMath from 'remark-math'
import remarkGfm from 'remark-gfm'
import rehypeKatex from 'rehype-katex'
import { adminApi } from '../hooks/api'
import TierBadge from '../components/TierBadge'
import PinModal from '../components/PinModal'
import TicketStatusStamp from '../components/TicketStatusStamp'
import QuotaBar from '../components/QuotaBar'
import { tierMeta, GRANT_CONFIG } from '../utils/tier'
import { MD_COMPONENTS, normalizeLatex } from './ResultPage'

/** 千分位缩写（与 SettingsView 同口径） */
function fmt(n) {
  if (n >= 10000) return `${(n / 10000).toFixed(1)}w`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false }) : '—')

/** 可调档位（free = 收回，单独走危险确认） */
const TIER_OPTIONS = ['trial', 'stargazer', 'voyager', 'odyssey', 'stella']
  .map((t) => ({ value: t, label: tierMeta(t).cn ? `${tierMeta(t).label} · ${tierMeta(t).cn}` : tierMeta(t).label }))

/** 订单异常态（看板红字计数 / 订单板块"异常"筛选共用） */
const ABNORMAL_STATUS = ['granting', 'grant_failed', 'unmapped_user', 'unknown_plan', 'bad_sign']

const ORDER_STATUS_TAG = {
  processed: { color: 'success', text: '已开通' },
  donation: { color: 'geekblue', text: '赞赏' },
  ignored: { color: 'default', text: '已忽略' },
  granting: { color: 'processing', text: '开通中' },
  grant_failed: { color: 'error', text: '开通失败' },
  unmapped_user: { color: 'error', text: '未关联用户' },
  unknown_plan: { color: 'error', text: '未知方案' },
  bad_sign: { color: 'error', text: '验签失败' },
}

const copyCode = (code) => {
  navigator.clipboard.writeText(code)
    .then(() => message.success(`已复制 ${code}`))
    .catch(() => message.error('复制失败'))
}

/** 功能名 / 图标映射（与 LedgerView 同源 + 管理员调整） */
const FEATURE_LABELS = {
  extract: '字幕提取', segment: '智能分段', summary: '总结概要', md: 'MD 笔记',
  chat: 'AI 解读', exchange: '货币兑换', signup_gift: '注册赠送',
  membership_gift: '会员赠送', admin_adjust: '管理员调整', redeem_gift: '兑换码会员赠送',
}
const FEATURE_ICONS = {
  extract: ClockCircleOutlined, segment: DotChartOutlined, summary: DotChartOutlined,
  md: GlobalOutlined, chat: GlobalOutlined, exchange: SwapOutlined,
  signup_gift: GiftOutlined, membership_gift: GiftOutlined, admin_adjust: ToolOutlined,
}
const CURRENCY_META = [
  { key: 'minute', Icon: ClockCircleOutlined, label: '分钟' },
  { key: 'quantum', Icon: DotChartOutlined, label: '量子波' },
  { key: 'gravity', Icon: GlobalOutlined, label: '引力波' },
]

const fmtTimeShort = (iso) => {
  if (!iso) return ''
  const d = new Date(iso)   // 后端已补 'Z'，浏览器按本地时区渲染
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 量子波双钱包拆分说明（同 LedgerView） */
function walletNote(item) {
  if (item.currency !== 'quantum' || item.from_gift == null) return null
  const f = (v) => (v > 0 ? `+${v}` : `${v}`)
  return `赠送 ${f(item.from_gift)} · 永久 ${f(item.from_perm ?? 0)}`
}

/** 消耗三元组文案：分钟 X · 量子波 Y · 引力波 Z */
const consumedText = (c) =>
  c ? `分钟 ${c.minute} · 量子波 ${c.quantum} · 引力波 ${c.gravity}` : '-'

/**
 * 敏感操作 PIN 流程 hook：requirePin(action) 先查状态弹设置/验证窗，
 * 验证通过才把 PIN 放进请求体执行 action(pin)。错误（409/403/423）提示后弹窗保持。
 */
function usePinFlow() {
  const [flow, setFlow] = useState(null)   // {mode: 'set'|'verify', action}
  const requirePin = async (action) => {
    try {
      const { pin_set } = await adminApi.pinStatus()
      setFlow({ mode: pin_set ? 'verify' : 'set', action })
    } catch (e) { message.error(e.message) }
  }
  const pinModal = (
    <PinModal
      open={!!flow}
      mode={flow?.mode}
      onCancel={() => setFlow(null)}
      onOk={async (pin) => {
        try {
          if (flow.mode === 'set') {
            await adminApi.setPin(pin)
            message.success('PIN 已设置，请重新执行操作')
          } else {
            await flow.action(pin)
          }
          setFlow(null)
          return true
        } catch (e) {
          message.error(e.message)
          return false   // 保持弹窗（错误/锁定可重试或取消）
        }
      }}
    />
  )
  return { requirePin, pinModal }
}

/* ───────── 趋势图（recharts，随 AdminView chunk 懒加载）───────── */

const CHART_COLORS = { main: '#4f46e5', soft: '#818cf8', pale: '#a78bfa' }

const CHART_AXIS = {
  tick: { fontSize: 11, fill: '#a3a3a3' },
  tickLine: false,
  axisLine: { stroke: '#eaeaea' },
}

const chartLabel = (iso) => {
  const [, m, d] = iso.split('-')
  return `${Number(m)}/${Number(d)}`
}

function TrendsSection() {
  const [items, setItems] = useState(null)
  const [days, setDays] = useState(30)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return   // 折叠时不拉数据，展开时才拉
    adminApi.trends(days)
      .then((r) => setItems(r.items.map((it) => ({ ...it, label: chartLabel(it.date) }))))
      .catch((e) => message.error(e.message))
  }, [days, open])

  const ChartCard = ({ title, children }) => (
    <div className="card" style={{ padding: '14px 16px 8px', flex: 1, minWidth: 280 }}>
      <div style={{ fontSize: 12, color: 'var(--mute)', marginBottom: 8 }}>{title}</div>
      {items === null
        ? <div style={{ height: 220, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--mute)', fontSize: 12 }}>加载中…</div>
        : children}
    </div>
  )

  return (
    <div style={{ marginTop: 12 }}>
      <div
        onClick={() => setOpen(!open)}
        style={{
          cursor: 'pointer', padding: '10px 16px', borderRadius: 'var(--r-card)',
          background: 'var(--surface-2)', display: 'flex', alignItems: 'center', gap: 8,
          userSelect: 'none', marginBottom: open ? 12 : 0,
        }}>
        <span style={{ fontSize: 14, transition: 'transform 0.2s', transform: open ? 'rotate(90deg)' : 'rotate(0deg)' }}>▸</span>
        <span style={{ fontSize: 12, color: 'var(--mute)' }}>趋势图</span>
        {open && (
          <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 4 }}>
            <Button size="small" type={days === 7 ? 'primary' : 'default'}
              onClick={(e) => { e.stopPropagation(); setDays(7) }}>7 天</Button>
            <Button size="small" type={days === 30 ? 'primary' : 'default'}
              onClick={(e) => { e.stopPropagation(); setDays(30) }}>30 天</Button>
          </span>
        )}
      </div>
      {open && (
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
          <ChartCard title="每日消耗（分钟 / tokens）">
            <ResponsiveContainer width="100%" height={220}>
              <ComposedChart data={items} margin={{ top: 4, right: 0, bottom: 0, left: -18 }}>
                <CartesianGrid stroke="#f5f5f5" vertical={false} />
                <XAxis dataKey="label" {...CHART_AXIS} interval={4} />
                <YAxis yAxisId="m" {...CHART_AXIS} width={46} />
                <YAxis yAxisId="t" orientation="right" {...CHART_AXIS} width={52} />
                <ChartTooltip />
                <Bar yAxisId="m" dataKey="minutes" name="分钟" fill={CHART_COLORS.soft} radius={[3, 3, 0, 0]} />
                <Line yAxisId="t" dataKey="tokens" name="tokens" stroke={CHART_COLORS.main}
                  strokeWidth={2} dot={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </ChartCard>
          <ChartCard title="每日收入（¥）">
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={items} margin={{ top: 4, right: 0, bottom: 0, left: -18 }}>
                <CartesianGrid stroke="#f5f5f5" vertical={false} />
                <XAxis dataKey="label" {...CHART_AXIS} interval={4} />
                <YAxis {...CHART_AXIS} width={46} />
                <ChartTooltip />
                <Bar dataKey="revenue" name="收入" fill={CHART_COLORS.main} radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
          <ChartCard title="每日新增注册">
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={items} margin={{ top: 4, right: 0, bottom: 0, left: -18 }}>
                <CartesianGrid stroke="#f5f5f5" vertical={false} />
                <XAxis dataKey="label" {...CHART_AXIS} interval={4} />
                <YAxis {...CHART_AXIS} width={46} allowDecimals={false} />
                <ChartTooltip />
                <Bar dataKey="signups" name="注册" fill={CHART_COLORS.pale} radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
        </div>
      )}
    </div>
  )
}

/* ───────── ① 数据看板 ───────── */

function OverviewPanel({ onGoOrders }) {
  const [data, setData] = useState(null)
  const [codesSum, setCodesSum] = useState(null)
  const [featureUsage, setFeatureUsage] = useState(null)
  const [health, setHealth] = useState(null)
  const [showFeatures, setShowFeatures] = useState(false)
  const [anonUsage, setAnonUsage] = useState(null)
  const load = useCallback(() => {
    adminApi.overview().then(setData).catch((e) => message.error(e.message))
    adminApi.codesSummary().then(setCodesSum).catch(() => {})
    adminApi.featureUsage(7).then(setFeatureUsage).catch(() => {})
    adminApi.health().then(setHealth).catch(() => {})
    adminApi.anonUsage().then(setAnonUsage).catch(() => {})
  }, [])
  useEffect(load, [load])

  const abnormal = ABNORMAL_STATUS
    .reduce((s, k) => s + (data?.order_status_counts?.[k] || 0), 0)
  const processed = data?.order_status_counts?.processed || 0
  const donation = data?.order_status_counts?.donation || 0
  const ignored = data?.order_status_counts?.ignored || 0

  const fmtUptime = (s) => {
    if (!s) return '-'
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    return h > 0 ? `${h}h${m}m` : `${m}m`
  }

  const Metric = ({ label, value, sub, danger, valueColor, onClick }) => (
    <div className="card" onClick={onClick} style={{
      padding: '14px 16px', minWidth: 150, flex: 1,
      cursor: onClick ? 'pointer' : 'default',
    }}>
      <div style={{ fontSize: 12, color: 'var(--mute)', marginBottom: 6 }}>{label}</div>
      <div className="font-mono" style={{
        fontSize: 22, fontWeight: 600, color: danger ? 'var(--error)' : (valueColor || 'var(--ink)'),
      }}>
        {value}
      </div>
      {sub && <div style={{ fontSize: 11, color: 'var(--mute)', marginTop: 4 }}>{sub}</div>}
    </div>
  )

  // 状态着色辅助
  const marginColor = data?.margin != null ? (data.margin >= 0 ? '#16a34a' : 'var(--error)') : undefined
  const diskColor = health ? (health.disk_free_pct < 10 ? 'var(--error)' : health.disk_free_pct < 30 ? '#d97706' : '#16a34a') : undefined
  const anonPct = anonUsage ? Math.round(anonUsage.minutes / anonUsage.limit * 100) : 0

  return (
    <div>
      {/* 渐变横幅卡 */}
      <div style={{
        position: 'relative', borderRadius: 'var(--r-card)',
        padding: '14px 22px 12px', marginBottom: 16,
        background: 'linear-gradient(135deg, #4f46e5 0%, #6d28d9 100%)',
        color: '#fff', overflow: 'hidden',
      }}>
        <span style={{
          position: 'absolute', top: 16, right: 20, fontSize: 18,
          fontFamily: "'Cormorant Garamond', serif", opacity: 0.9,
        }}>✦</span>
        <div style={{ position: 'relative', display: 'flex', alignItems: 'baseline', gap: 18, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13, opacity: 0.85 }}>全站概览</span>
          <span style={{ fontSize: 15 }}>累计收入 <b style={{ fontSize: 20 }}>¥{data ? data.revenue.toFixed(2) : '-'}</b></span>
          <span style={{ fontSize: 15 }}>付费订单 <b style={{ fontSize: 20 }}>{data ? data.paid_orders : '-'}</b> 笔</span>
          <span style={{ fontSize: 15 }}>累计转写 <b style={{ fontSize: 20 }}>{data ? fmt(data.consumed_total?.minute) : '-'}</b> 分钟</span>
          <span style={{ fontSize: 15 }}>累计 tokens <b style={{ fontSize: 20 }}>{data ? fmt(data.tokens_total) : '-'}</b></span>
        </div>
        <div style={{ fontSize: 11, opacity: 0.7, marginTop: 8 }}>
          「今日」以 UTC+8 凌晨 04:00 为界 · tokens 取 user_stats 累计，分钟流水无 token 字段
        </div>
      </div>

      {/* 第一行：核心指标 */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <Metric label="用户数" value={data ? fmt(data.users_total) : '-'}
          sub={`今日新增 ${data?.users_today ?? '-'}`} />
        <Metric label="任务数" value={data ? fmt(data.tasks_total) : '-'}
          sub={`今日 ${data?.tasks_today ?? '-'}`} />
        <Metric label="流水笔数" value={data ? fmt(data.ledger_total) : '-'}
          sub={`今日 ${data?.ledger_today ?? '-'}`} />
        <Metric label="异常订单" value={data ? abnormal : '-'} danger={abnormal > 0}
          sub="点击前往订单核验" onClick={onGoOrders} />
      </div>

      {/* 消耗与收入 */}
      <div style={{ margin: '16px 0 6px' }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: '#b45309' }}>消耗</span>
        <span style={{ fontSize: 11, color: 'var(--mute)', marginLeft: 6 }}>估算口径，单价见后端注释</span>
      </div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <Metric label="今日消耗" value={data ? `¥${data.cost_today.toFixed(2)}` : '-'}
          sub={`${consumedText(data?.consumed_today)}${data ? ` · 人均 ¥${(data.cost_total / Math.max(1, data.users_total)).toFixed(2)}` : ''}`} />
        <Metric label="累计消耗" value={data ? `¥${data.cost_total.toFixed(2)}` : '-'}
          sub={consumedText(data?.consumed_total)} />
        <Metric label="毛利（累计）" value={data ? `¥${data.margin.toFixed(2)}` : '-'}
          sub="收入 − 估算成本" valueColor={marginColor} />
        <Metric label="今日收入" value={data ? `¥${data.revenue_today.toFixed(2)}` : '-'}
          sub={`本周 ¥${data?.revenue_week?.toFixed(2) ?? '-'} · 累计 ¥${data?.revenue?.toFixed(2) ?? '-'}`} valueColor="#16a34a" />
      </div>

      {/* 用户与增长 */}
      <div style={{ margin: '16px 0 6px' }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: '#4f46e5' }}>用户</span>
      </div>
      {/* 会员分布（用户分组首位，档位结构一览） */}
      <div className="card" style={{ padding: '14px 16px', marginBottom: 12 }}>
        <div style={{ fontSize: 12, color: 'var(--mute)', marginBottom: 10 }}>会员分布</div>
        {(() => {
          const dist = { ...(data?.tier_distribution || {}) }
          if (data?.admin_users) dist.admin = data.admin_users
          const entries = Object.entries(dist).sort((a, b) => b[1] - a[1])
          const max = Math.max(1, ...entries.map(([, c]) => c))
          if (!entries.length) return <span style={{ fontSize: 12, color: 'var(--mute)' }}>暂无数据</span>
          return entries.map(([tier, count]) => (
            <div key={tier} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
              <TierBadge tier={tier} style={{ minWidth: 64, textAlign: 'center' }} />
              <div style={{
                flex: 1, height: 8, borderRadius: 9999, background: 'var(--surface-2)', overflow: 'hidden',
              }}>
                <div style={{
                  width: `${(count / max) * 100}%`, height: '100%', borderRadius: 9999,
                  background: tierMeta(tier).ring || 'var(--hairline-strong)',
                }} />
              </div>
              <span className="font-mono" style={{ fontSize: 12, color: 'var(--ink)', minWidth: 32, textAlign: 'right' }}>
                {count}
              </span>
            </div>
          ))
        })()}
      </div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <Metric label="今日活跃" value={data?.active_users_today ?? '-'}
          sub="今日有流水的登录用户" />
        <Metric label="本周新注册" value={data?.users_week ?? '-'}
          sub={`其中今日 ${data?.users_today ?? '-'}`} />
        <Metric label="匿名使用" value={anonUsage ? anonUsage.ips : '-'}
          sub={`${anonUsage ? anonUsage.minutes : '-'} 分钟 / ${anonUsage?.limit ?? 10} 上限${anonUsage ? `（${anonPct}%）` : ''}`} />
      </div>

      {/* 运营 */}
      <div style={{ margin: '16px 0 6px' }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: '#64748b' }}>运营</span>
      </div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <Metric label="兑换码" value={codesSum ? fmt(codesSum.total) : '-'}
          sub={`已核销 ${codesSum?.used ?? '-'} · 未核销 ${codesSum ? codesSum.unused : '-'}${codesSum?.by_tier ? ` · ${Object.entries(codesSum.by_tier).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([t,c])=>`${t}:${c}`).join(' · ')}` : ''}`} />
        <Metric label="系统健康" value={health ? `${health.disk_free_pct}%` : '-'}
          valueColor={diskColor}
          sub={health ? (
            <span>
              磁盘剩余 · 任务 {data?.running_tasks ?? '-'} · DB {health.db_size_mb}MB · {fmtUptime(health.uptime_sec)}
            </span>
          ) : '-'} />
        <Metric label="订单" value={data ? (processed + donation + abnormal) : '-'}
          sub={`已开通 ${processed} · 赞赏 ${donation} · 异常 ${abnormal}`} />
      </div>

      {/* 功能使用热度（可折叠） */}
      {featureUsage && Object.keys(featureUsage.features || {}).length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div
            onClick={() => setShowFeatures(!showFeatures)}
            style={{
              cursor: 'pointer', padding: '10px 16px', borderRadius: 'var(--r-card)',
              background: 'var(--surface-2)', display: 'flex', alignItems: 'center', gap: 8,
              userSelect: 'none',
            }}>
            <span style={{ fontSize: 14, transition: 'transform 0.2s', transform: showFeatures ? 'rotate(90deg)' : 'rotate(0deg)' }}>▸</span>
            <span style={{ fontSize: 12, color: 'var(--mute)' }}>
              近 {featureUsage.days} 天功能热度
              {!showFeatures && (
                <span style={{ marginLeft: 8, color: 'var(--ink)' }}>
                  {Object.entries(featureUsage.features).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([f, c]) => {
                    const names = { extract: '提取', segment: '分段', summary: '概要', md: 'MD', chat: '解读', exchange: '兑换' }
                    return <span key={f} style={{ marginLeft: 8 }}>{names[f] || f}: {c}</span>
                  })}
                </span>
              )}
            </span>
          </div>
          {showFeatures && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, padding: '10px 16px' }}>
              {Object.entries(featureUsage.features)
                .sort((a, b) => b[1] - a[1])
                .map(([f, c]) => {
                  const names = {
                    extract: '字幕提取', segment: '智能分段', summary: '内容概要',
                    md: 'MD 笔记', chat: 'AI 解读', exchange: '货币兑换',
                    admin_adjust: '管理员调整', signup_gift: '注册礼',
                    membership_gift: '会员发放', redeem_gift: '兑换发放',
                  }
                  return (
                    <div key={f} style={{
                      padding: '6px 12px', borderRadius: 'var(--r-input)',
                      background: 'var(--surface-2)', fontSize: 12,
                    }}>
                      <span style={{ color: 'var(--mute)', marginRight: 6 }}>{names[f] || f}</span>
                      <span className="font-mono" style={{ color: 'var(--ink)', fontWeight: 600 }}>{c}</span>
                    </div>
                  )
                })}
            </div>
          )}
        </div>
      )}

      <TrendsSection />

      <div style={{ textAlign: 'right', marginTop: 10 }}>
        <Button type="text" size="small" icon={<ReloadOutlined />} onClick={load}>刷新</Button>
      </div>
    </div>
  )
}

/* ───────── ② 用户管理 ───────── */

/** 用户详情展开区：今日/累计消耗 + 功能使用次数 + 最近流水（LedgerView 渲染风格） */
function UserDetail({ detail, loading, onRefresh }) {
  return (
    <div style={{ marginTop: 12, borderTop: '1px solid var(--hairline)', paddingTop: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--ink)' }}>用量详情</span>
        <Button type="text" size="small" icon={<ReloadOutlined />} loading={loading}
          onClick={onRefresh} />
      </div>
      <div style={{ opacity: loading ? 0.45 : 1, transition: 'opacity 0.2s' }}>
      <div className="font-mono" style={{ fontSize: 12, color: 'var(--body)', lineHeight: 1.9 }}>
        今日消耗：{consumedText(detail.consumed_today)}<br />
        累计消耗：{consumedText(detail.consumed_total)}
        {detail.stats && (
          <span style={{ color: 'var(--mute)' }}>
            {'　｜　'}累计提取 {detail.stats.videos_extracted} · 转写 {fmt(detail.stats.chars_transcribed)} 字
            · MD {detail.stats.md_notes} · 解读 {detail.stats.chat_rounds}
          </span>
        )}
      </div>
      {/* 功能使用次数（图标 + 次数小网格） */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '10px 0' }}>
        {Object.entries(detail.feature_counts).length === 0 && (
          <span style={{ fontSize: 12, color: 'var(--mute)' }}>暂无使用记录</span>
        )}
        {Object.entries(detail.feature_counts).map(([f, c]) => {
          const Icon = FEATURE_ICONS[f] || DotChartOutlined
          return (
            <div key={f} style={{
              display: 'inline-flex', alignItems: 'center', gap: 5,
              background: 'var(--surface-2)', borderRadius: 'var(--r-input)',
              padding: '4px 10px', fontSize: 12, color: 'var(--body)',
            }}>
              <Icon style={{ fontSize: 11, color: 'var(--accent)' }} />
              {FEATURE_LABELS[f] || f}
              <b className="font-mono" style={{ color: 'var(--ink)' }}>{c}</b>
            </div>
          )
        })}
      </div>
      {/* 最近 20 条流水（功能名/货币/金额着色/时间，同 LedgerView） */}
      <div style={{ background: 'var(--surface-2)', borderRadius: 'var(--r-input)', padding: '2px 12px' }}>
        {detail.recent_ledger.length === 0 && (
          <div style={{ padding: '20px 0', textAlign: 'center', fontSize: 12, color: 'var(--mute)' }}>暂无流水</div>
        )}
        {detail.recent_ledger.map((it, i) => {
          const meta = CURRENCY_META.find((c) => c.key === it.currency) || CURRENCY_META[0]
          const note = walletNote(it)
          return (
            <div key={it.id} style={{
              display: 'flex', alignItems: 'center', gap: 12, padding: '9px 0',
              borderTop: i === 0 ? 'none' : '1px solid var(--hairline)',
            }}>
              <meta.Icon style={{ color: 'var(--accent)', fontSize: 13, flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, color: 'var(--ink)' }}>
                  {FEATURE_LABELS[it.feature] || it.feature}
                </div>
                {(note || it.note) && (
                  <div className="font-mono" style={{ fontSize: 11, color: 'var(--mute)', marginTop: 1 }}>{note || it.note}</div>
                )}
              </div>
              <div style={{ textAlign: 'right', flexShrink: 0 }}>
                <div className="font-mono" style={{
                  fontSize: 13, fontWeight: 600,
                  color: it.amount > 0 ? '#16a34a' : 'var(--ink)',
                }}>
                  {it.amount > 0 ? `+${it.amount}` : it.amount}
                </div>
                <div className="font-mono" style={{ fontSize: 11, color: 'var(--mute)', marginTop: 1 }}>
                  余 {it.balance_after} · {fmtTimeShort(it.created_at)}
                </div>
              </div>
            </div>
          )
        })}
      </div>
      </div>
    </div>
  )
}

function UserCard({ u, onChanged }) {
  const [qDelta, setQDelta] = useState(null)
  const [gDelta, setGDelta] = useState(null)
  const [tier, setTier] = useState('voyager')
  const [days, setDays] = useState(30)
  const [busy, setBusy] = useState(false)
  const [detail, setDetail] = useState(null)       // null = 收起
  const [detailLoading, setDetailLoading] = useState(false)
  const { requirePin, pinModal } = usePinFlow()

  const loadDetail = useCallback(async () => {
    setDetailLoading(true)
    try {
      setDetail(await adminApi.userUsage(u.uid))
    } catch (e) { message.error(e.message) } finally { setDetailLoading(false) }
  }, [u.uid])

  const toggleDetail = () => {
    if (detail) setDetail(null)
    else loadDetail()
  }

  // 敏感操作成功后：刷新搜索列表 + 详情区（若展开）+ 广播（admin 改自己账号时用户侧即时刷新）
  const afterChange = () => {
    onChanged()
    if (detail) loadDetail()
    window.dispatchEvent(new CustomEvent('stellaris:billing-changed'))
  }

  const adjust = (field) => {
    const delta = field === 'quantum' ? qDelta : gDelta
    if (!delta) return message.warning('调整量不能为 0')
    let noteInput = { value: '' }
    Modal.confirm({
      centered: true,
      title: `${field === 'quantum' ? '量子波' : '引力波'} ${delta > 0 ? '+' : ''}${delta}`,
      content: (
        <Input
          placeholder="备注（可选，64 字内）"
          maxLength={64}
          onChange={(e) => { noteInput.value = e.target.value }}
        />
      ),
      okText: '确认调整',
      cancelText: '取消',
      onOk: () => requirePin(async (pin) => {
        setBusy(true)
        try {
          const payload = { uid: u.uid, pin, note: noteInput.value || '' }
          if (field === 'quantum') payload.quantum_delta = delta
          else payload.gravity_delta = delta
          const r = await adminApi.adjustBalance(payload)
          message.success(`已调整：量子波 ${r.applied.quantum >= 0 ? '+' : ''}${r.applied.quantum}，引力波 ${r.applied.gravity >= 0 ? '+' : ''}${r.applied.gravity}`)
          afterChange()
        } finally { setBusy(false) }
      }),
    })
  }

  const applyTier = () => {
    requirePin(async (pin) => {
      setBusy(true)
      try {
        await adminApi.setTier({ uid: u.uid, tier, days: tier === 'stella' ? null : days, pin })
        message.success('档位已更新')
        afterChange()
      } finally { setBusy(false) }
    })
  }

  const revoke = () => {
    Modal.confirm({
      title: `收回 ${u.nickname}（UID ${u.uid}）的会员档位？`,
      content: '档位将回到免费版，已赠送的货币不追回。',
      centered: true,
      okText: '确认收回',
      okButtonProps: { danger: true },
      cancelText: '再想想',
      onOk: () => requirePin(async (pin) => {
        await adminApi.setTier({ uid: u.uid, tier: 'free', pin })
        message.success('已收回档位')
        afterChange()
      }),
    })
  }

  return (
    <div className="card" style={{ padding: '14px 16px', marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 600, color: 'var(--ink)' }}>{u.nickname}</span>
        <span className="font-mono" style={{ fontSize: 11, color: 'var(--mute)' }}>UID {u.uid}</span>
        <TierBadge tier={u.tier} />
        {/* 生效档位与存储原值不一致（付费档已过期懒降级）→ 补对账小字 */}
        {u.raw_tier && u.raw_tier !== u.tier && (
          <span style={{ fontSize: 11, color: 'var(--mute)' }}>
            （原 {tierMeta(u.raw_tier).cn || u.raw_tier} 已过期）
          </span>
        )}
        {u.is_admin && <Tag color="gold" style={{ marginInlineEnd: 0 }}>admin</Tag>}
        <span style={{ fontSize: 12, color: 'var(--mute)' }}>{u.email}</span>
      </div>
      <div className="font-mono" style={{ fontSize: 12, color: 'var(--body)', margin: '8px 0 10px' }}>
        量子波 {u.quantum_gift}+{u.quantum_perm} · 引力波 {u.gravity}
        · 分钟 {u.minutes_day}/{u.minutes_week}/{u.minutes_month}（日/周/月）
        · 到期 {u.expire_at ? fmtTime(u.expire_at) : '—'}
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <InputNumber size="small" placeholder="量子波 ±" value={qDelta} onChange={setQDelta} style={{ width: 110 }} />
        <Button size="small" loading={busy} onClick={() => adjust('quantum')}>调量子波</Button>
        <InputNumber size="small" placeholder="引力波 ±" value={gDelta} onChange={setGDelta} style={{ width: 110 }} />
        <Button size="small" loading={busy} onClick={() => adjust('gravity')}>调引力波</Button>
        <Select size="small" value={tier} onChange={setTier} options={TIER_OPTIONS} style={{ width: 170 }} />
        {tier !== 'stella' && (
          <InputNumber size="small" min={1} value={days} onChange={setDays} addonAfter="天" style={{ width: 110 }} />
        )}
        <Button size="small" type="primary" loading={busy} onClick={applyTier}
          style={{ height: 24 }}>应用档位</Button>
        <Button size="small" danger onClick={revoke}>收回档位</Button>
        <Button size="small" loading={detailLoading} onClick={toggleDetail}
          icon={detail ? <UpOutlined /> : <DownOutlined />}>
          详情
        </Button>
      </div>
      {detail && <UserDetail detail={detail} loading={detailLoading} onRefresh={loadDetail} />}
      {pinModal}
    </div>
  )
}

function UsersPanel() {
  const [query, setQuery] = useState('')
  const [items, setItems] = useState(null)
  const [searching, setSearching] = useState(false)

  const search = useCallback(async (q) => {
    if (!q.trim()) { setItems(null); return }
    setSearching(true)
    try {
      const r = await adminApi.searchUsers(q.trim())
      setItems(r.items)
    } catch (e) { message.error(e.message) } finally { setSearching(false) }
  }, [])

  return (
    <div>
      <Input.Search
        placeholder="邮箱模糊搜索 / UID 精确搜索"
        prefix={<SearchOutlined style={{ color: 'var(--mute)' }} />}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onSearch={search}
        loading={searching}
        enterButton="搜索"
        style={{ maxWidth: 420, marginBottom: 16 }}
      />
      {items === null ? (
        <Empty description="输入邮箱或 UID 开始搜索" style={{ padding: '40px 0' }} />
      ) : items.length === 0 ? (
        <Empty description="没有命中的用户" style={{ padding: '40px 0' }} />
      ) : (
        items.map((u) => <UserCard key={u.uid} u={u} onChanged={() => search(query)} />)
      )}
    </div>
  )
}

/* ───────── ③ 兑换码 ───────── */

function CodesPanel() {
  const [tier, setTier] = useState('voyager')
  const [days, setDays] = useState(30)
  const [count, setCount] = useState(1)
  const [customCode, setCustomCode] = useState('')
  const [note, setNote] = useState('')
  const [expiresAt, setExpiresAt] = useState(null)
  const [grantMode, setGrantMode] = useState('regular')   // regular=周期重置 / lump=一次性入永久钱包
  const [quantumGrant, setQuantumGrant] = useState(null)  // lump 模式发放的量子波
  const [gravityGrant, setGravityGrant] = useState(null)  // lump 模式发放的引力波
  const [creating, setCreating] = useState(false)
  const [created, setCreated] = useState([])
  const [items, setItems] = useState(null)
  const { requirePin, pinModal } = usePinFlow()

  const load = useCallback(() => {
    adminApi.listCodes().then((r) => setItems(r.items)).catch((e) => message.error(e.message))
  }, [])
  useEffect(load, [load])

  const create = () => {
    requirePin(async (pin) => {
      setCreating(true)
      try {
        const r = await adminApi.createCodes({
          tier, days: tier === 'stella' ? null : days, count,
          custom_code: customCode || undefined,
          note: note || undefined,
          expires_at: expiresAt ? expiresAt.toISOString() : undefined,
          grant_mode: grantMode,
          quantum_grant: grantMode === 'lump' ? (quantumGrant || 0) : undefined,
          gravity_grant: grantMode === 'lump' ? (gravityGrant || 0) : undefined,
          pin,
        })
        setCreated(r.codes)
        message.success(`已生成 ${r.codes.length} 个兑换码`)
        load()
      } finally { setCreating(false) }
    })
  }

  return (
    <div>
      <div className="card" style={{ padding: '16px 18px', marginBottom: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--ink)', marginBottom: 12 }}>生成兑换码</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <Select size="small" value={tier} onChange={setTier} options={TIER_OPTIONS} style={{ width: 170 }} />
          {tier !== 'stella' && (
            <InputNumber size="small" min={1} value={days} onChange={setDays} addonAfter="天" style={{ width: 110 }} />
          )}
          <InputNumber size="small" min={1} max={50} value={count} onChange={setCount} addonAfter="个" style={{ width: 100 }} />
          <Input size="small" placeholder="自定义码（可选，仅 1 个时）" value={customCode}
            onChange={(e) => setCustomCode(e.target.value)} style={{ width: 190 }} />
          <Input size="small" placeholder="备注（可选）" value={note} maxLength={64}
            onChange={(e) => setNote(e.target.value)} style={{ width: 160 }} />
          <DatePicker size="small" placeholder="过期时间（可选）" value={expiresAt}
            onChange={setExpiresAt} showTime />
          <Button size="small" type="primary" loading={creating} onClick={create}
            style={{ height: 24 }}>生成</Button>
        </div>
        {tier === 'stella' && (
          <div style={{ fontSize: 11, color: 'var(--mute)', marginTop: 8 }}>
            Stella 邀请码：永久有效，建议填自定义码（如有意义的词）+ 备注
          </div>
        )}
        {/* 发放模式（V0.9.3）：regular=按档位周期重置 / lump=一次性入永久钱包 */}
        {tier !== 'stella' && (
          <div style={{ marginTop: 12, padding: '10px 12px', background: 'var(--surface-2)', borderRadius: 'var(--r-input)' }}>
            <div style={{ fontSize: 12, color: 'var(--mute)', marginBottom: 6 }}>发放模式</div>
            <Radio.Group size="small" value={grantMode} onChange={(e) => setGrantMode(e.target.value)}>
              <Radio value="regular">常规（额度按档位周期重置，适合整月）</Radio>
              <Radio value="lump">一次性（进永久钱包，适合短期/活动）</Radio>
            </Radio.Group>
            {grantMode === 'lump' && (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 8 }}>
                <InputNumber size="small" min={0} placeholder="量子波" value={quantumGrant}
                  onChange={setQuantumGrant} addonAfter="量子波" style={{ width: 150 }} />
                <InputNumber size="small" min={0} placeholder="引力波" value={gravityGrant}
                  onChange={setGravityGrant} addonAfter="引力波" style={{ width: 150 }} />
                <Button size="small" onClick={() => {
                  const cfg = GRANT_CONFIG[tier]
                  if (!cfg) return
                  setQuantumGrant(cfg.quantum_weekly * Math.ceil(days / 7))
                  setGravityGrant(Math.round(cfg.gravity_monthly * days / 30))
                }}>按 {days} 天折算</Button>
                <span style={{ fontSize: 11, color: 'var(--mute)' }}>
                  量子波 = 周赠 × ⌈天数/7⌉；引力波 = 月赠 × 天数/30
                </span>
              </div>
            )}
          </div>
        )}
        {created.length > 0 && (
          <div>
            <div style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {created.map((c) => (
                <Tag key={c} color="geekblue" style={{ cursor: 'pointer', fontSize: 13, padding: '3px 10px' }}
                  icon={<CopyOutlined />} onClick={() => copyCode(c)}>
                  {c}
                </Tag>
              ))}
            </div>
            {created.length > 1 && (
              <Button size="small" style={{ marginTop: 8 }} icon={<CopyOutlined />} onClick={() => {
                copyCode(created.join('\n'))
                message.success(`已复制 ${created.length} 个兑换码`)
              }}>一键复制全部</Button>
            )}
          </div>
        )}
      </div>
      <Table
        size="small"
        rowKey="code"
        loading={items === null}
        dataSource={items || []}
        locale={{ emptyText: <Empty description="还没有兑换码" /> }}
        pagination={{ pageSize: 20, showSizeChanger: false }}
        columns={[
          { title: '兑换码', dataIndex: 'code', render: (c, r) => (
            <span className="font-mono" style={{
              fontSize: 12, cursor: 'pointer',
              color: r.tier === 'stella' ? tierMeta('stella').color : 'var(--ink)',
              fontWeight: r.tier === 'stella' ? 600 : 400,
            }} onClick={() => copyCode(c)}>{c}</span>
          ) },
          { title: '档位', dataIndex: 'tier', render: (t) => <TierBadge tier={t} /> },
          { title: '天数', dataIndex: 'days', render: (d) => (d == null ? '永久' : `${d} 天`) },
          { title: '发放', dataIndex: 'grant_mode', render: (m, r) => m === 'lump'
            ? <span className="font-mono" style={{ fontSize: 11 }}>{r.quantum_grant}量子+{r.gravity_grant}引力<span style={{ color: 'var(--mute)' }}> ·一次性</span></span>
            : <span style={{ fontSize: 11, color: 'var(--mute)' }}>周期重置</span> },
          { title: '已用', render: (_, r) => `${r.use_count}/${r.max_uses}` },
          { title: '使用者', dataIndex: 'used_by', render: (v) => v ?? '—' },
          { title: '备注', dataIndex: 'note', render: (v) => v || '—' },
          { title: '过期时间', dataIndex: 'expires_at', render: fmtTime },
          { title: '创建时间', dataIndex: 'created_at', render: fmtTime },
          { title: '操作', render: (_, r) => {
            // 仅未核销且未过期的码可作废
            const used = r.use_count > 0
            const expired = r.expires_at && new Date(r.expires_at) < new Date()
            if (used || expired) return <span style={{ fontSize: 11, color: 'var(--mute)' }}>{used ? '已核销' : '已过期'}</span>
            return <Button type="link" size="small" danger onClick={() => {
              Modal.confirm({
                centered: true,
                title: `作废兑换码 ${r.code}？`,
                content: '作废后该码无法再被核销，已生成的码失效无法恢复。',
                okText: '确认作废', okButtonProps: { danger: true },
                cancelText: '取消',
                onOk: () => requirePin(async (pin) => {
                  try {
                    await adminApi.revokeCode(r.code, pin)
                    message.success('已作废')
                    load()
                  } catch (e) { message.error(e.message) }
                }),
              })
            }}>作废</Button>
          } },
        ]}
      />
      {pinModal}
    </div>
  )
}

/* ───────── ④ 订单核验 ───────── */

function OrdersPanel({ initialFilter }) {
  const [filter, setFilter] = useState(initialFilter || 'all')   // all | abnormal
  const [items, setItems] = useState(null)
  const [fulfillOrder, setFulfillOrder] = useState(null)         // 待补发的订单
  const [fUid, setFUid] = useState(null)
  const [fTier, setFTier] = useState('voyager')
  const [fDays, setFDays] = useState(30)
  const [busy, setBusy] = useState(false)
  const { requirePin, pinModal } = usePinFlow()

  const load = useCallback(async () => {
    try {
      if (filter === 'abnormal') {
        // 后端按单状态筛选，异常态逐个拉再合并（按时间倒序）
        const lists = await Promise.all(ABNORMAL_STATUS.map((s) => adminApi.listOrders(s)))
        const merged = lists.flatMap((r) => r.items)
        merged.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
        setItems(merged)
      } else {
        const r = await adminApi.listOrders()
        setItems(r.items)
      }
    } catch (e) { message.error(e.message) }
  }, [filter])
  useEffect(() => { setItems(null); load() }, [load])

  const openFulfill = (order) => {
    setFulfillOrder(order)
    setFUid(order.user_uid ?? null)
    setFTier('voyager')
    setFDays(30)
  }

  const doFulfill = () => {
    if (!fUid) return message.warning('请输入 UID')
    Modal.confirm({
      title: `补发订单 ${fulfillOrder.out_trade_no}？`,
      content: `将为 UID ${fUid} 开通 ${tierMeta(fTier).label}${fTier === 'stella' ? '（永久）' : ` ${fDays} 天`}，订单状态改为已开通。`,
      centered: true,
      okText: '确认补发',
      cancelText: '再想想',
      onOk: () => requirePin(async (pin) => {
        setBusy(true)
        try {
          await adminApi.fulfillOrder(fulfillOrder.out_trade_no, {
            uid: fUid, tier: fTier, days: fTier === 'stella' ? null : fDays, pin,
          })
          message.success('补发成功')
          setFulfillOrder(null)
          load()
        } finally { setBusy(false) }
      }),
    })
  }

  const recheck = async (order) => {
    try {
      const r = await adminApi.recheckOrder(order.out_trade_no)
      const o = r.orders?.[0]
      Modal.info({
        centered: true,
        title: '爱发电侧订单状态',
        content: o ? (
          <div className="font-mono" style={{ fontSize: 12, lineHeight: 2 }}>
            单号：{o.out_trade_no}<br />
            状态：{o.status === 2 ? '支付成功' : `status=${o.status}`}<br />
            金额：¥{o.total_amount} · 方案：{o.plan_id || '（自选金额）'}<br />
            备注：{o.remark || '—'}
          </div>
        ) : '爱发电侧未查到该订单',
      })
    } catch (e) { message.error(e.message) }
  }

  return (
    <div>
      <Tabs
        activeKey={filter}
        onChange={setFilter}
        size="small"
        items={[
          { key: 'all', label: '全部' },
          { key: 'abnormal', label: '异常' },
        ]}
        style={{ marginTop: -8 }}
      />
      <Table
        size="small"
        rowKey="out_trade_no"
        loading={items === null}
        dataSource={items || []}
        locale={{ emptyText: <Empty description={filter === 'abnormal' ? '没有异常订单，一切正常' : '还没有订单'} /> }}
        pagination={{ pageSize: 20, showSizeChanger: false }}
        columns={[
          { title: '单号', dataIndex: 'out_trade_no', render: (v) => (
            <Tooltip title="点击复制"><span className="font-mono" style={{ fontSize: 12, cursor: 'pointer' }}
              onClick={() => copyCode(v)}>{v}</span></Tooltip>
          ) },
          { title: '状态', dataIndex: 'status', render: (s) => {
            const t = ORDER_STATUS_TAG[s] || { color: 'default', text: s }
            return <Tag color={t.color} style={{ marginInlineEnd: 0 }}>{t.text}</Tag>
          } },
          { title: '金额', dataIndex: 'total_amount', render: (v) => `¥${v}` },
          { title: '方案', dataIndex: 'plan_id', render: (v) => v || '—' },
          { title: 'UID', dataIndex: 'user_uid', render: (v) => v ?? '—' },
          { title: '时间', dataIndex: 'created_at', render: fmtTime },
          { title: '操作', render: (_, r) => (
            ABNORMAL_STATUS.includes(r.status) ? (
              <span style={{ display: 'inline-flex', gap: 6 }}>
                <Button size="small" type="primary" style={{ height: 24 }} onClick={() => openFulfill(r)}>补发</Button>
                <Button size="small" onClick={() => recheck(r)}>反查</Button>
              </span>
            ) : null
          ) },
        ]}
      />
      {/* 补发弹窗（UID + 档位 + 天数，确认时二次 Modal.confirm） */}
      <Modal
        centered
        open={!!fulfillOrder}
        title={`补发 · ${fulfillOrder?.out_trade_no || ''}`}
        okText="补发"
        cancelText="取消"
        confirmLoading={busy}
        onOk={doFulfill}
        onCancel={() => setFulfillOrder(null)}
        width={380}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '8px 0' }}>
          <div>
            <div style={{ fontSize: 12, color: 'var(--mute)', marginBottom: 4 }}>UID</div>
            <InputNumber style={{ width: '100%' }} min={1} value={fUid} onChange={setFUid} placeholder="用户 UID" />
          </div>
          <div>
            <div style={{ fontSize: 12, color: 'var(--mute)', marginBottom: 4 }}>档位</div>
            <Select style={{ width: '100%' }} value={fTier} onChange={setFTier} options={TIER_OPTIONS} />
          </div>
          {fTier !== 'stella' && (
            <div>
              <div style={{ fontSize: 12, color: 'var(--mute)', marginBottom: 4 }}>天数</div>
              <InputNumber style={{ width: '100%' }} min={1} value={fDays} onChange={setFDays} addonAfter="天" />
            </div>
          )}
        </div>
      </Modal>
      {pinModal}
    </div>
  )
}

/* ───────── ⑤ 任务监控 ───────── */

function TasksPanel() {
  const [items, setItems] = useState(null)
  const [uidFilter, setUidFilter] = useState('')
  const [tidFilter, setTidFilter] = useState('')
  const [detail, setDetail] = useState(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const load = useCallback(() => {
    const uid = uidFilter.trim() ? parseInt(uidFilter, 10) : null
    const tid = tidFilter.trim() || null
    setDetail(null)
    adminApi.recentTasks(uid || undefined, tid || undefined).then((r) => {
      setItems(r.items)
      // 精确 task_id 搜索：自动拉取详情档案
      if (tid && r.items?.length === 1) {
        setDetailLoading(true)
        adminApi.taskDetail(tid).then(setDetail).catch(() => setDetail(null)).finally(() => setDetailLoading(false))
      }
    }).catch((e) => message.error(e.message))
  }, [uidFilter, tidFilter])
  useEffect(() => { adminApi.recentTasks().then((r) => setItems(r.items)).catch((e) => message.error(e.message)) }, [])

  const reset = () => {
    setUidFilter(''); setTidFilter(''); setDetail(null)
    adminApi.recentTasks().then((r) => setItems(r.items))
  }

  const openDetail = (tid) => {
    setDetailLoading(true)
    adminApi.taskDetail(tid).then(setDetail).catch(() => setDetail(null))
      .finally(() => setDetailLoading(false))
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
        <Input
          size="small" placeholder="Stellaris 任务 ID" value={tidFilter}
          onChange={(e) => setTidFilter(e.target.value)}
          style={{ width: 220 }} onPressEnter={load}
        />
        <Input
          size="small" placeholder="按 UID 过滤（可选）" value={uidFilter}
          onChange={(e) => setUidFilter(e.target.value)}
          style={{ width: 180 }} onPressEnter={load}
        />
        <Button size="small" onClick={load}>查询</Button>
        <Button size="small" onClick={reset}>重置</Button>
        <span style={{ fontSize: 11, color: 'var(--mute)' }}>用户反馈时贴 task_id 即可定位</span>
      </div>

      {/* 详情档案（task_id 精确查询时展示） */}
      {detail && (
        <div className="card" style={{ padding: '16px 18px', marginBottom: 16 }}>
          <div style={{ fontSize: 14, fontWeight: 500, color: 'var(--ink)', marginBottom: 12 }}>任务档案</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 24px', fontSize: 13 }}>
            <div><span style={{ color: 'var(--mute)' }}>任务 ID</span> <span className="font-mono">{detail.task_id}</span></div>
            <div><span style={{ color: 'var(--mute)' }}>UID</span> <span className="font-mono">{detail.owner_uid}</span></div>
            <div><span style={{ color: 'var(--mute)' }}>标题</span> {detail.title || '未知'}</div>
            <div><span style={{ color: 'var(--mute)' }}>来源</span> {detail.source_platform || '—'}</div>
            <div><span style={{ color: 'var(--mute)' }}>创建时间</span> {fmtTime(detail.created_at)}</div>
            <div><span style={{ color: 'var(--mute)' }}>状态</span> <Tag color={detail.status === 'completed' ? 'success' : 'default'}>{detail.status}</Tag></div>
            {detail.runtime && (
              <>
                <div><span style={{ color: 'var(--mute)' }}>实际转写字数</span> {detail.runtime.actual_chars?.toLocaleString() || '—'}</div>
                <div><span style={{ color: 'var(--mute)' }}>分段 Tokens</span> {detail.runtime.actual_seg_tokens?.toLocaleString() || '—'}</div>
                <div><span style={{ color: 'var(--mute)' }}>扣分钟</span> {detail.runtime.charged_minutes != null ? `${detail.runtime.charged_minutes} 分钟` : '—'}</div>
                <div><span style={{ color: 'var(--mute)' }}>扣量子波</span> {detail.runtime.charged_quantum != null ? detail.runtime.charged_quantum : '—'}</div>
                <div><span style={{ color: 'var(--mute)' }}>MD 笔记</span> {detail.runtime.md_status === 'ready' ? '已生成' : detail.runtime.md_status || '—'}</div>
                <div><span style={{ color: 'var(--mute)' }}>内容概要</span> {detail.runtime.summary_status === 'ready' ? '已生成' : detail.runtime.summary_status || '—'}</div>
                <div><span style={{ color: 'var(--mute)' }}>字幕来源</span> {detail.runtime.subtitle_source || '—'}</div>
                <div><span style={{ color: 'var(--mute)' }}>源标题</span> {detail.runtime.video_title || '—'}</div>
                {detail.runtime.error && <div style={{ gridColumn: '1 / -1', color: 'var(--error)', fontSize: 12 }}>错误：{detail.runtime.error}</div>}
              </>
            )}
          </div>
          {/* 成本摘要带 + 账单明细（V1.1.0 发票列；老任务显示无明细） */}
          {detail.cost_summary && (
            detail.cost_summary.has_invoice ? (
              <>
                <div style={{
                  display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap',
                  background: 'var(--accent-light)', borderRadius: 'var(--r-input)',
                  padding: '10px 14px', margin: '12px 0 8px',
                }}>
                  <span style={{ fontSize: 20, fontWeight: 600, color: 'var(--accent)' }}>
                    ¥{detail.cost_summary.total}
                  </span>
                  <span style={{ fontSize: 12, color: 'var(--body)' }}>
                    {detail.cost_summary.asr_minutes > 0 && `ASR ${detail.cost_summary.asr_minutes.toFixed(1)} 分钟 · `}
                    {detail.cost_summary.models.join(' / ')} ·
                    输入 {fmtTokens(detail.cost_summary.prompt)} · 输出 {fmtTokens(detail.cost_summary.completion)}
                    {detail.cost_summary.hit_rate != null && ` · 命中 ${detail.cost_summary.hit_rate}%`}
                  </span>
                </div>
                <div className="font-mono" style={{ fontSize: 11.5, color: 'var(--mute)', lineHeight: 1.9, padding: '0 2px' }}>
                  {detail.ledger.filter(l => l.cost_yuan != null).map((l, i) => (
                    <div key={i}>
                      {l.currency === 'minute'
                        ? `${l.feature}   ${Math.abs(l.amount).toFixed(1)} 分钟 × ¥${l.price_per_hour}/h = ¥${l.cost_yuan}`
                        : `${l.feature}   ${l.cache_miss_tokens ?? l.prompt_tokens}×${l.price_input} + ${l.cache_hit_tokens ?? 0}×${l.price_cache_hit} + ${l.completion_tokens}×${l.price_output}（¥/M）= ¥${l.cost_yuan}`}
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div style={{ fontSize: 12, color: 'var(--mute)', margin: '12px 0 8px' }}>
                历史任务，无成本明细
              </div>
            )
          )}
          {detail.ledger?.length > 0 && (
            <>
              <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--ink)', margin: '14px 0 8px' }}>计费流水</div>
              <div style={{ background: 'var(--surface-2)', borderRadius: 'var(--r-input)', padding: '6px 12px', maxHeight: 200, overflowY: 'auto' }}>
                {detail.ledger.map((l, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '5px 0', borderBottom: '1px solid var(--hairline)', fontSize: 12 }}>
                    <span style={{ color: 'var(--mute)', width: 100 }}>{fmtTimeShort(l.created_at) || l.created_at}</span>
                    <Tag color={l.amount > 0 ? 'success' : 'error'} style={{ fontSize: 10 }}>{FEATURE_LABELS[l.feature] || l.feature}</Tag>
                    <span className="font-mono" style={{ color: l.amount > 0 ? '#16a34a' : 'var(--ink)' }}>{l.amount > 0 ? '+' : ''}{l.amount} {l.currency}</span>
                    {l.from_gift != null && <span style={{ fontSize: 10, color: 'var(--mute)' }}>gift:{l.from_gift} perm:{l.from_perm}</span>}
                    {l.note && <span style={{ fontSize: 10, color: 'var(--mute)' }}>{l.note}</span>}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      <Table
        size="small"
        rowKey="task_id"
        loading={items === null}
        dataSource={items || []}
        locale={{ emptyText: <Empty description="暂无记录" /> }}
        pagination={{ pageSize: 20, showSizeChanger: false }}
        columns={[
          { title: '时间', dataIndex: 'created_at', render: fmtTime, width: 150 },
          { title: '任务 ID', dataIndex: 'task_id', width: 200, ellipsis: true, render: (v, r) => (
            // ID 即链接：定长整齐，与"搜 ID 查档案"语义对应（V1.1.0 碳碳定稿）
            <a onClick={() => openDetail(r.task_id)} className="font-mono"
              style={{ color: 'var(--accent)', cursor: 'pointer' }}>
              {v || '—'}
            </a>
          ) },
          { title: '标题', dataIndex: 'title', ellipsis: true, render: (t) => t || '未知视频' },
          { title: '来源', dataIndex: 'source_platform', width: 100, render: (s) => s || '—' },
          { title: 'UID', dataIndex: 'owner_uid', width: 80, className: 'font-mono', render: (v) => v ?? '—' },
          { title: '', width: 60, render: (_, r) => (
            <Button type="text" size="small" onClick={() => openDetail(r.task_id)}>详情</Button>
          ) },
        ]}
      />
    </div>
  )
}

/* ───────── 工单处理面板（V0.9.4）───────── */

const TICKET_CATEGORY = {
  bug: 'Bug 反馈', suggestion: '功能建议', other: '其他',
}
const TICKET_STATUS_TABS = [
  { key: 'pending', label: '待处理' },
  { key: 'processing', label: '处理中' },
  { key: 'replied', label: '已回复' },
  { key: 'closed', label: '已关闭' },
]

function TicketsPanel() {
  const [items, setItems] = useState(null)
  const [counts, setCounts] = useState({})
  const [filter, setFilter] = useState('pending')
  const [detail, setDetail] = useState(null)    // 详情弹窗
  const [replyText, setReplyText] = useState('')
  const [acting, setActing] = useState(false)
  const { requirePin, pinModal } = usePinFlow()

  const load = useCallback(async () => {
    try {
      const [cur, all] = await Promise.all([
        adminApi.listTickets(filter),
        adminApi.listTickets(),
      ])
      setItems(cur.items || [])
      const c = {}
      ;(all.items || []).forEach((t) => { c[t.status] = (c[t.status] || 0) + 1 })
      setCounts(c)
    } catch (e) {
      message.error(e.message)
    }
  }, [filter])

  useEffect(() => { load() }, [load])

  const openDetail = async (tid) => {
    try {
      const t = await adminApi.getTicket(tid)
      setDetail(t); setReplyText(t.admin_reply || '')
    } catch (e) { message.error(e.message) }
  }

  // 执行操作（PIN 二次验证后调 API）
  const doAction = async (action, pin, reply) => {
    setActing(true)
    try {
      await adminApi.replyTicket(detail.id, { action, reply, pin })
      message.success('操作成功')
      const t = await adminApi.getTicket(detail.id)
      setDetail(t); setReplyText(t.admin_reply || '')
      load()
      return true
    } catch (e) {
      message.error(e.message)
      return false
    } finally {
      setActing(false)
    }
  }

  const onAction = (action) => {
    if (action !== 'start' && action !== 'close' && action !== 'reopen') {
      // reply / reply_close 需要回复内容
      if (!replyText.trim()) { message.warning('请输入回复内容'); return }
    }
    requirePin(async (pin) => doAction(action, pin, action === 'close' || action === 'start' || action === 'reopen' ? null : replyText.trim()))
  }

  return (
    <div>
      {/* 状态筛选条 */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        {TICKET_STATUS_TABS.map((s) => (
          <Button key={s.key} size="small"
            type={filter === s.key ? 'primary' : 'default'}
            onClick={() => setFilter(s.key)}>
            {s.label}{counts[s.key] ? ` (${counts[s.key]})` : ''}
          </Button>
        ))}
      </div>

      <Table
        size="small"
        rowKey="id"
        loading={items === null}
        dataSource={items || []}
        locale={{ emptyText: <Empty description="暂无工单" /> }}
        pagination={{ pageSize: 20, showSizeChanger: false }}
        columns={[
          { title: '编号', dataIndex: 'ticket_no', width: 140, className: 'font-mono', render: (v) => v || '—' },
          { title: '标题', dataIndex: 'title', ellipsis: true },
          { title: '分类', dataIndex: 'category', width: 90, render: (c) => TICKET_CATEGORY[c] || c },
          { title: 'UID', dataIndex: 'user_uid', width: 80, className: 'font-mono' },
          { title: '状态', dataIndex: 'status', width: 80, render: (s) => <TicketStatusStamp status={s} /> },
          { title: '时间', dataIndex: 'created_at', width: 140, render: fmtTime },
          { title: '', width: 70, render: (_, r) => (
            <Button size="small" type="link" onClick={() => openDetail(r.id)}>查看</Button>
          ) },
        ]}
      />

      {/* 详情弹窗 */}
      <Modal open={!!detail} onCancel={() => setDetail(null)} width={620} centered
        footer={null} destroyOnClose
        styles={{ body: { maxHeight: '65vh', overflowY: 'auto' } }}
        title={<span className="font-display">工单 {detail?.ticket_no}</span>}
      >
        {detail && (
          <div style={{ padding: '4px 0' }}>
            <div className="font-display font-display-xs" style={{ marginBottom: 8 }}>{detail.title}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
              <span style={{ fontSize: 11, color: 'var(--mute)' }}>
                {TICKET_CATEGORY[detail.category]} · UID {detail.user_uid}
              </span>
              <TicketStatusStamp status={detail.status} />
              <span style={{ fontSize: 11, color: 'var(--mute)', marginLeft: 'auto' }}>
                {fmtTime(detail.created_at)}
              </span>
            </div>

            {detail.contact && (
              <div style={{ fontSize: 12, color: 'var(--accent)', marginBottom: 8 }}>
                联系方式：{detail.contact}
              </div>
            )}
            {(detail.occur_at || detail.repro_steps) && (
              <div style={{ fontSize: 12, color: 'var(--mute)', marginBottom: 8 }}>
                {detail.occur_at && <span>发生时间：{detail.occur_at}　</span>}
                {detail.repro_steps && <span>复现：{detail.repro_steps}</span>}
              </div>
            )}

            <div style={{
              fontSize: 13, color: 'var(--body)', lineHeight: 1.8, marginBottom: 12,
              whiteSpace: 'pre-wrap', background: 'var(--surface-2)',
              padding: '10px 12px', borderRadius: 'var(--r-input)',
            }}>
              {detail.description}
            </div>

            {detail.log_content && (
              <div style={{ marginBottom: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', marginBottom: 4 }}>
                  <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--ink)' }}>
                    诊断日志
                  </span>
                  <span style={{ flex: 1 }} />
                  <Button size="small" type="text" title="复制日志"
                    icon={<CopyOutlined />}
                    onClick={() => {
                      navigator.clipboard.writeText(detail.log_content)
                        .then(() => message.success('日志已复制'))
                        .catch(() => message.error('复制失败'))
                    }} />
                  <Button size="small" type="text" title="下载日志" onClick={() => {
                    const blob = new Blob([detail.log_content], { type: 'application/json' })
                    const a = document.createElement('a')
                    a.href = URL.createObjectURL(blob)
                    a.download = `stellaris-ticket-${detail.id}-diagnostic.json`
                    a.click()
                    URL.revokeObjectURL(a.href)
                  }} icon={<DownloadOutlined />} />
                </div>
                <pre className="font-mono" style={{
                  maxHeight: 200, overflow: 'auto', fontSize: 11,
                  background: 'var(--surface-2)', padding: 8, borderRadius: 4,
                  whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                }}>{detail.log_content}</pre>
              </div>
            )}

            {/* 历史回复（如有） */}
            {detail.admin_reply && (
              <div style={{
                background: 'var(--accent-light)', borderRadius: 'var(--r-input)',
                padding: '10px 12px', marginBottom: 12,
              }}>
                <div style={{ fontSize: 12, color: 'var(--accent)', fontWeight: 500, marginBottom: 4 }}>
                  上次回复
                </div>
                <div style={{ fontSize: 13, color: 'var(--ink)', lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>
                  {detail.admin_reply}
                </div>
              </div>
            )}

            {/* pending 态：不显示回复框，只显示【开始处理】 */}
            {detail.status === 'pending' && (
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <Button loading={acting} type="primary" onClick={() => onAction('start')}>开始处理</Button>
              </div>
            )}

            {/* 非 pending 态：显示回复框 + 对应操作按钮 */}
            {(detail.status === 'processing' || detail.status === 'replied') && (
              <>
                {/* 内测申请类工单：一键预填回复（可再编辑） */}
                {detail.category === 'vault_apply' && (
                  <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                    <span style={{ fontSize: 12, color: 'var(--mute)', lineHeight: '24px' }}>快速填充：</span>
                    <Button size="small" onClick={() => setReplyText(
                      '已为你开通文件柜内测～去 设置 → 关于 → 星轨实验室 就能看到它了。玩得开心，有建议随时来工单聊。'
                    )}>已开通</Button>
                    <Button size="small" onClick={() => setReplyText(
                      '感谢你的申请！文件柜目前还在小范围内测，名额会逐步放开，这次暂时未能为你开通，还请见谅。我们会记录你的申请，扩大范围时优先联系你。'
                    )}>未通过</Button>
                  </div>
                )}
                <Input.TextArea rows={3} value={replyText} maxLength={2000}
                  placeholder="输入回复内容"
                  onChange={(e) => setReplyText(e.target.value)}
                  style={{ marginBottom: 12 }} />
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                  <Button loading={acting} onClick={() => onAction('reply')}>回复</Button>
                  <Button loading={acting} danger onClick={() => onAction('reply_close')}>回复并关闭</Button>
                </div>
              </>
            )}

            {detail.status === 'closed' && (
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <Button loading={acting} onClick={() => onAction('reopen')}>重新打开</Button>
              </div>
            )}
          </div>
        )}
      </Modal>
      {pinModal}
    </div>
  )
}

/* ───────── ⑦ 数据管理 ───────── */

function DataPanel() {
  const [health, setHealth] = useState(null)
  const [status, setStatus] = useState(null)
  const [backing, setBacking] = useState(false)
  const { requirePin, pinModal } = usePinFlow()

  const load = useCallback(() => {
    adminApi.health().then(setHealth).catch(() => {})
    adminApi.backupStatus().then(setStatus).catch(() => {})
  }, [])
  useEffect(load, [load])

  const doBackup = () => {
    requirePin(async (pin) => {
      setBacking(true)
      try {
        const r = await adminApi.backupNow(pin)
        message.success(r.ok ? (r.uploaded ? `备份成功：${r.key}` : '快照已生成（COS 未配置，本地未留存）') : `备份失败：${r.msg}`)
        const s = await adminApi.backupStatus()
        setStatus(s)
      } catch (e) {
        message.error('备份请求失败：' + e.message)
      } finally {
        setBacking(false)
      }
    })
  }

  const last = status?.last_backup
  const cosOk = status?.cos_enabled
  const history = status?.history || []
  // 上次备份优先从 COS 历史取（不丢），内存 _last_backup 兜底（进程重启后丢失）
  const lastFromCos = history.length > 0 ? history[0] : null
  const lastDisplay = lastFromCos || last
  const lastOk = lastFromCos ? true : (last?.ok ?? null)

  return (
    <div>
      <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--ink)', marginBottom: 10 }}>数据库</div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <div className="card" style={{ padding: '14px 16px', flex: 1, minWidth: 150 }}>
          <div style={{ fontSize: 12, color: 'var(--mute)', marginBottom: 6 }}>DB 文件大小</div>
          <div className="font-mono" style={{ fontSize: 22, fontWeight: 600, color: 'var(--ink)' }}>
            {health ? `${health.db_size_mb} MB` : '-'}
          </div>
          <div style={{ fontSize: 11, color: 'var(--mute)', marginTop: 4 }}>
            磁盘剩余 {health?.disk_free_pct ?? '-'}% · {health ? (() => { const s = health.uptime_sec; const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); return h > 0 ? `运行 ${h}h${m}m` : `运行 ${m}m` })() : '-'}
          </div>
        </div>
        <div className="card" style={{ padding: '14px 16px', flex: 1, minWidth: 150 }}>
          <div style={{ fontSize: 12, color: 'var(--mute)', marginBottom: 6 }}>COS 异地备份</div>
          <div className="font-mono" style={{ fontSize: 22, fontWeight: 600, color: cosOk ? '#16a34a' : 'var(--mute)' }}>
            {cosOk ? '已配置' : '未配置'}
          </div>
          <div style={{ fontSize: 11, color: 'var(--mute)', marginTop: 4, lineHeight: 1.7 }}>
            <span style={{ color: '#0ea5e9' }}>腾讯云 COS</span>
            {' · '}
            <span style={{ color: '#0891b2' }}>新加坡（亚太）</span>
            {cosOk && (
              <span style={{ marginLeft: 8 }}>
                {lastDisplay ? (
                  lastDisplay.time_iso && new Date(lastDisplay.time_iso).getTime() > Date.now() - 3600000
                    ? <span style={{ color: '#16a34a' }}>刚刚手动备份</span>
                    : <span style={{ color: '#7c3aed' }}>自动（每日 04:00）</span>
                ) : <span style={{ color: '#7c3aed' }}>自动（每日 04:00）</span>}
              </span>
            )}
            <br />
            {cosOk ? `保留最近 ${status?.retention_days ?? 7} 天，过期自动清理` : 'COS 环境变量未设，自动备份不可用'}
          </div>
        </div>
        <div className="card" style={{ padding: '14px 16px', flex: 1, minWidth: 150 }}>
          <div style={{ fontSize: 12, color: 'var(--mute)', marginBottom: 6 }}>上次备份</div>
          <div className="font-mono" style={{ fontSize: 22, fontWeight: 600, color: lastDisplay ? (lastOk ? '#16a34a' : 'var(--error)') : 'var(--mute)' }}>
            {lastDisplay ? (lastOk ? '成功' : '失败') : '—'}
          </div>
          <div style={{ fontSize: 11, color: 'var(--mute)', marginTop: 4 }}>
            {lastDisplay
              ? `${lastDisplay.time_iso?.slice(0, 16) || lastDisplay.time || '未知时间'} · ${lastDisplay.key || ''}`
              : (cosOk ? '等待首次备份' : '暂无备份记录')}
          </div>
        </div>
      </div>

      {/* 手动备份 */}
      <div style={{ marginTop: 20 }}>
        <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--ink)', marginBottom: 10 }}>操作</div>
        <Button type="primary" icon={<CloudUploadOutlined />} loading={backing} onClick={doBackup}>
          立即备份
        </Button>
        <span style={{ fontSize: 11, color: 'var(--mute)', marginLeft: 12 }}>
          生成一致性快照{cosOk ? '并上传至 COS（需 PIN 验证）' : '（COS 未配置，仅生成快照不存留）'}
        </span>
      </div>

      {/* 备份历史 */}
      {history.length > 0 && (
        <>
          <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--ink)', margin: '20px 0 10px' }}>备份历史</div>
          <Table
            size="small"
            rowKey="key"
            dataSource={history}
            pagination={false}
            columns={[
              { title: '日期时间', dataIndex: 'time', width: 130, align: 'center', render: (v) => v || '—' },
              { title: '方式', dataIndex: 'mode', width: 60, align: 'center', render: (m) => (
                <span style={{ color: m === '手动' ? '#16a34a' : '#7c3aed', fontWeight: 500, fontSize: 12 }}>{m}</span>
              ) },
              { title: '文件', dataIndex: 'key', ellipsis: true },
              { title: '大小', dataIndex: 'size_bytes', width: 90, render: (v) => v ? `${(v / 1024 / 1024).toFixed(1)} MB` : '—' },
              { title: '剩余', dataIndex: 'days_until_cleanup', width: 65, align: 'center', render: (d) => (
                // d<=0：已过保留线、今天 04:00 即被清理（0点-4点窗口期原为"-1 天"，V1.0.5 修复）
                d <= 0
                  ? <span style={{ color: 'var(--error)', fontSize: 12 }}>今日清理</span>
                  : <span style={{ color: d <= 1 ? 'var(--error)' : d <= 3 ? '#d97706' : 'var(--mute)' }}>{d} 天</span>
              ) },
            ]}
          />
        </>
      )}

      {/* 日志提示 */}
      <div style={{ marginTop: 20, padding: '10px 14px', background: 'var(--surface-2)', borderRadius: 'var(--r-input)', fontSize: 11, color: 'var(--mute)', lineHeight: 1.7 }}>
        自动备份每天北京时间 04:00 执行一次（与计费重置时刻对齐）。备份采用 SQLite 在线快照（.backup 命令），运行时安全不锁库。COS 保留最近 {status?.retention_days ?? 7} 天快照，过期自动清理。
      </div>
      {pinModal}
    </div>
  )
}

/* ───────── ⑧ 安全面板 ───────── */

function SecurityPanel() {
  const [data, setData] = useState(null)
  const [showBaseline, setShowBaseline] = useState(false)
  useEffect(() => {
    adminApi.securityStatus().then(setData).catch(() => {})
  }, [])

  if (!data) return <div style={{ textAlign: 'center', padding: 40, color: 'var(--mute)', fontSize: 13 }}>加载中…</div>

  const { live, auth, network, keys, p1_gaps } = data

  const Metric = ({ label, value, color, sub }) => (
    <div className="card" style={{ padding: '14px 16px', flex: 1, minWidth: 150 }}>
      <div style={{ fontSize: 12, color: 'var(--mute)', marginBottom: 6 }}>{label}</div>
      <div className="font-mono" style={{ fontSize: 28, fontWeight: 700, color: color || 'var(--ink)' }}>
        {value}
      </div>
      {sub && <div style={{ fontSize: 11, color: 'var(--mute)', marginTop: 4 }}>{sub}</div>}
    </div>
  )

  const Row = ({ label, value, ok }) => (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--hairline)' }}>
      <span style={{ fontSize: 13, color: 'var(--ink)' }}>{label}</span>
      <span style={{ fontSize: 13, fontFamily: 'var(--font-mono)', fontWeight: 500,
        color: ok === false ? 'var(--error)' : ok === true ? '#16a34a' : 'var(--mute)' }}>{value}</span>
    </div>
  )

  return (
    <div>
      {/* 实时拦截（动态数据，主位） */}
      <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--ink)', marginBottom: 10 }}>实时拦截（本次进程运行以来）</div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        <Metric label="登录限流触发" value={live.login_blocked} color={live.login_blocked > 0 ? 'var(--error)' : '#16a34a'}
          sub="密码登录被限流拒绝的次数" />
        <Metric label="SSRF 拦截" value={live.ssrf_blocked} color={live.ssrf_blocked > 0 ? 'var(--error)' : '#16a34a'}
          sub="内网/云元数据 URL 被拒绝" />
        <Metric label="超大文件驳回" value={live.upload_rejected} color={live.upload_rejected > 0 ? '#d97706' : '#16a34a'}
          sub={`上限 ${(network.max_upload_mb / 1024).toFixed(0)} GB`} />
      </div>

      {/* 待修复缺口 */}
      {p1_gaps?.length > 0 && (
        <>
          <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--error)', marginBottom: 10 }}>待修复（{p1_gaps.length} 项 P1）</div>
          <div className="card" style={{ padding: '12px 16px', marginBottom: 16 }}>
            {p1_gaps.map((g) => (
              <div key={g.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '6px 0', borderBottom: '1px solid var(--hairline)' }}>
                <Tag color="error" style={{ fontSize: 10, marginTop: 2 }}>{g.level}</Tag>
                <span style={{ fontSize: 13, color: 'var(--ink)', lineHeight: 1.6 }}>{g.title}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {/* 安全事件时间线 */}
      {data.events?.length > 0 && (
        <>
          <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--ink)', marginBottom: 10 }}>安全事件（最近 {data.events.length} 条）</div>
          <div className="card" style={{ padding: '10px 16px', marginBottom: 16, maxHeight: 420, overflowY: 'auto', border: 0 }}>
            {data.events.map((e, i) => {
              const colors = { login_blocked: 'var(--error)', ssrf_blocked: '#d97706', upload_rejected: '#d97706' }
              const labels = { login_blocked: '登录限流', ssrf_blocked: 'SSRF', upload_rejected: '上传驳回' }
              return (
                <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '5px 0', borderBottom: '1px solid var(--hairline)', fontSize: 12 }}>
                  <span className="font-mono" style={{ color: 'var(--mute)', flexShrink: 0, width: 90 }}>{e.time}</span>
                  <Tag color={e.type === 'login_blocked' ? 'error' : 'warning'} style={{ fontSize: 10, margin: 0, flexShrink: 0 }}>
                    {labels[e.type] || e.type}
                  </Tag>
                  <span style={{ color: colors[e.type] || 'var(--ink)', lineHeight: 1.5, wordBreak: 'break-all' }}>{e.detail}</span>
                </div>
              )
            })}
          </div>
        </>
      )}

      {/* 密钥状态（动态：√/✕） */}
      <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--ink)', marginBottom: 10 }}>密钥与凭证</div>
      <div className="card" style={{ padding: '12px 16px', marginBottom: 16 }}>
        {Object.entries(keys).map(([k, v]) => {
          const labels = {
            jwt_secret_set: 'JWT 密钥', mimo_key_set: 'Mimo ASR', llm_key_set: 'LLM (DeepSeek)',
            cos_configured: 'COS 备份', turnstile_secret_set: 'Turnstile', afdian_token_set: '爱发电 Token',
            resend_key_set: 'Resend 邮件',
          }
          return <Row key={k} label={labels[k] || k} value={v ? '✅ 已设' : '❌ 未设'} ok={v} />
        })}
      </div>

      {/* 静态基线（折叠参考） */}
      <div
        onClick={() => setShowBaseline(!showBaseline)}
        style={{
          cursor: 'pointer', padding: '10px 16px', borderRadius: 'var(--r-card)',
          background: 'var(--surface-2)', display: 'flex', alignItems: 'center', gap: 8,
          userSelect: 'none', marginBottom: showBaseline ? 12 : 0,
        }}>
        <span style={{ fontSize: 14, transition: 'transform 0.2s', transform: showBaseline ? 'rotate(90deg)' : 'rotate(0deg)' }}>▸</span>
        <span style={{ fontSize: 12, color: 'var(--mute)' }}>安全基线（静态配置，仅供参考）</span>
      </div>
      {showBaseline && (
        <>
          <div style={{ marginBottom: 6, marginTop: 12 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: '#4f46e5' }}>认证安全</span>
          </div>
          <div className="card" style={{ padding: '12px 16px', marginBottom: 16 }}>
            <Row label="JWT 过期天数" value={`${auth.jwt_expire_days} 天`} ok />
            <Row label="bcrypt 加密轮数" value={`rounds=${auth.bcrypt_rounds}`} ok />
            <Row label="密码强度" value={auth.password_complexity?.join('+')} ok />
            <Row label="登录限流阈值" value={auth.login_rate_limit} ok />
            <Row label="验证码限流阈值" value={auth.code_rate_limit} ok />
            <Row label="Turnstile（发验证码）" value={auth.turnstile_on_send_code ? '已覆盖' : '未覆盖'} ok={auth.turnstile_on_send_code} />
            <Row label="Turnstile（密码登录）" value={auth.turnstile_on_login ? '已覆盖' : '未覆盖'} ok={auth.turnstile_on_login} />
          </div>
          <div style={{ marginBottom: 6 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: '#b45309' }}>网络防御</span>
          </div>
          <div className="card" style={{ padding: '12px 16px', marginBottom: 16 }}>
            <Row label="CORS 白名单" value={network.cors_origins?.join(', ') || '未设置'} ok />
            <Row label="SSRF 防护" value="已启用" ok />
            <Row label="上传大小上限" value={`${(network.max_upload_mb / 1024).toFixed(0)} GB`} ok />
            <Row label="HTTP 安全头" value={network.security_headers ? '已设置' : '未设置'} ok={network.security_headers} />
          </div>
        </>
      )}

      <div style={{ fontSize: 11, color: 'var(--mute)', lineHeight: 1.7, padding: '10px 0' }}>
        动态数据为进程内存计数（重启清零）· 密钥仅显示是否已设不返回实际值 · 审查报告见 <code>tmp/security-audit-1.0.0.md</code>
      </div>
    </div>
  )
}

/* ───────── ⑪ 文件柜（V1.1.3 Dev Vault：管理员私人文档云柜）───────── */

const VAULT_MAX_SIZE = 1024 * 1024   // 与后端 1MB 上限一致的前端预检

/** 敏感文件名检测（镜像 backend/vault_store.py：.env / .envrc / .env.* / *.pem / *.key / id_rsa*，模板放行） */
const SENSITIVE_ALLOW = new Set(['.env.example', '.env.sample', '.env.template'])
function isSensitiveName(path) {
  const name = path.split('/').pop().toLowerCase()
  if (SENSITIVE_ALLOW.has(name)) return false
  if (name === '.env' || name === '.envrc') return true
  return name.startsWith('.env.') || name.endsWith('.pem') || name.endsWith('.key') || name.startsWith('id_rsa')
}

const fmtSize = (n) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`)

/** 文件夹名校验（黑名单制，镜像后端 validate_path：禁 / 和 \ 和 .. 段，其余含中文括号逗号空格都允许） */
function folderNameError(name) {
  if (!name) return null   // 空不提示，由按钮禁用兜底
  if (name.includes('/')) return '只支持单级文件夹，名称不能包含 /'
  if (name.includes('\\')) return '名称不能包含反斜杠'
  if (name.trim() === '..') return '文件夹名不允许为 ..'
  if (name.trim().length > 64) return '最多 64 字符'
  return null
}

/** 专用密码强度提示（≥8 位 + 大小写字母 + 数字 + 符号） */
const PASS_RULES = [
  { key: 'len', label: '至少 8 位', test: (p) => p.length >= 8 },
  { key: 'case', label: '含大小写字母', test: (p) => /[a-z]/.test(p) && /[A-Z]/.test(p) },
  { key: 'digit', label: '含数字', test: (p) => /\d/.test(p) },
  { key: 'symbol', label: '含符号', test: (p) => /[^A-Za-z0-9]/.test(p) },
]

function PassRules({ value }) {
  return (
    <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 3 }}>
      {PASS_RULES.map((r) => {
        const ok = r.test(value)
        return (
          <span key={r.key} style={{ fontSize: 12, color: ok ? '#16a34a' : 'var(--mute)' }}>
            {ok ? '✓' : '○'} {r.label}
          </span>
        )
      })}
    </div>
  )
}

function VaultMinePanel() {
  const { requirePin, pinModal } = usePinFlow()
  const [stage, setStage] = useState('loading')   // loading | set | unlock | main
  const [passInput, setPassInput] = useState('')
  const [newPass, setNewPass] = useState('')
  const [checking, setChecking] = useState(false)
  const [prefix, setPrefix] = useState('')
  const [listing, setListing] = useState(null)    // {folders, files}
  const [viewing, setViewing] = useState(null)    // {path, content, size, updated_at}
  const [mdMode, setMdMode] = useState('render')
  const [renameFor, setRenameFor] = useState(null)
  const [renameTo, setRenameTo] = useState('')
  const [changePassOpen, setChangePassOpen] = useState(false)
  const [mkdirOpen, setMkdirOpen] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const [freshFolder, setFreshFolder] = useState(null)   // 刚"新建"进入的虚拟文件夹路径（空态提示用）
  const uploadBatchRef = useRef([])

  const passRef = useRef('')   // 专用密码只活在本组件内存：切 Tab 不丢（面板保持挂载），退后台/刷新即清
  const curPass = () => passRef.current

  /** 统一 vault 调用：401 = 专用密码失效/错误 → 清内存回密码闸（不碰全局登录态） */
  const vaultCall = useCallback(async (fn) => {
    try {
      return await fn()
    } catch (e) {
      if (e.status === 401) {
        passRef.current = ''
        setListing(null)
        setViewing(null)
        setStage('unlock')
        message.error('密码错误，请重新输入')
        e.vaultRelogin = true   // 调用方据此跳过重复报错
      }
      throw e
    }
  }, [])

  const load = useCallback(async (p) => {
    try {
      const r = await vaultCall(() => adminApi.vaultList(curPass(), p ?? prefix))
      setListing(r)
      setPrefix(r.prefix)
    } catch (e) {
      if (!e.vaultRelogin) message.error(e.message)
    }
  }, [prefix, vaultCall])

  /** 进 Tab：查密码状态；密码只存内存（面板首次挂载即到输入框，切 Tab 保活不重输） */
  useEffect(() => {
    let alive = true
    adminApi.vaultPassStatus()
      .then(async ({ set }) => {
        if (!alive) return
        if (!set) { setStage('set'); return }
        if (!passRef.current) { setStage('unlock'); return }
        try {
          const r = await vaultCall(() => adminApi.vaultList(passRef.current, ''))
          if (!alive) return
          setListing(r)
          setPrefix(r.prefix)
          setStage('main')
        } catch {
          /* vaultCall 已处理 401；其他错误（限流等）回密码输入框重试 */
          if (alive) setStage('unlock')
        }
      })
      .catch((e) => { if (alive) { message.error(e.message); setStage('unlock') } })
    return () => { alive = false }
  }, [vaultCall])

  const tryUnlock = async () => {
    if (!passInput) return
    setChecking(true)
    try {
      const r = await vaultCall(() => adminApi.vaultList(passInput, ''))
      passRef.current = passInput
      setPassInput('')
      setListing(r)
      setPrefix(r.prefix)
      setStage('main')
    } catch (e) {
      if (!e.vaultRelogin) message.error(e.message)
    } finally {
      setChecking(false)
    }
  }

  /** 设置/修改专用密码（管理 PIN 确认 = 忘记密码的重置入口）；成功后清内存强制用新密码重进 */
  const submitNewPass = () => {
    if (!PASS_RULES.every((r) => r.test(newPass))) { message.warning('密码未达到强度要求'); return }
    requirePin(async (pin) => {
      await adminApi.vaultSetPassword(pin, newPass)
      passRef.current = ''
      setNewPass('')
      setChangePassOpen(false)
      setListing(null)
      setViewing(null)
      setStage('unlock')
      message.success('专用密码已设置，请用新密码进入')
    })
  }

  /* ── 上传（Dragger 多选/拖拽，beforeUpload 收批后自走 vaultPut）── */

  const beforeUpload = (file, fileList) => {
    uploadBatchRef.current.push(file)
    if (uploadBatchRef.current.length >= fileList.length) {
      const batch = uploadBatchRef.current
      uploadBatchRef.current = []
      handleUploadBatch(batch)
    }
    return false   // 阻止 antd 自动上传
  }

  const handleUploadBatch = (files) => {
    const ok = []
    for (const f of files) {
      if (f.size > VAULT_MAX_SIZE) message.error(`${f.name} 超过 1MB，已跳过`)
      else ok.push(f)
    }
    if (!ok.length) return
    const run = (allowSensitive) => requirePin(async (pin) => {
      let failed = 0
      for (const f of ok) {
        const path = prefix ? `${prefix}/${f.name}` : f.name
        try {
          const content = await f.text()
          await vaultCall(() => adminApi.vaultPut(curPass(), { path, content, allow_sensitive: allowSensitive, pin }))
        } catch (e) {
          failed += 1
          if (e.vaultRelogin) break   // 密码已失效，后续文件无意义
          message.error(`${f.name} 上传失败：${e.message}`)
        }
      }
      if (!failed) message.success(`已上传 ${ok.length} 个文件`)
      else if (failed < ok.length) message.warning(`完成，${failed} 个失败`)
      load()
    })
    const sensitive = ok.filter((f) => isSensitiveName(f.name))
    if (sensitive.length) {
      Modal.confirm({
        centered: true,
        title: '检测到敏感文件，确认上传？',
        content: (
          <div style={{ fontSize: 13, lineHeight: 1.8 }}>
            以下文件名命中敏感规则（环境变量 / 私钥类）：
            <div className="font-mono" style={{
              marginTop: 6, padding: '6px 10px', fontSize: 12,
              background: 'var(--surface-2)', borderRadius: 'var(--r-input)',
            }}>
              {sensitive.map((f) => <div key={f.name}>{f.name}</div>)}
            </div>
          </div>
        ),
        okText: '确认上传',
        cancelText: '取消',
        onOk: () => run(true),
      })
    } else {
      run(false)
    }
  }

  /* ── 查看 / 下载 / 重命名 / 删除 ── */

  const openFile = async (path) => {
    try {
      const r = await vaultCall(() => adminApi.vaultGet(curPass(), path))
      setViewing(r)
      setMdMode('render')
    } catch (e) {
      if (!e.vaultRelogin) message.error(e.message)
    }
  }

  const downloadFile = async (path) => {
    try {
      const r = await vaultCall(() => adminApi.vaultGet(curPass(), path))
      const url = URL.createObjectURL(new Blob([r.content], { type: 'text/plain;charset=utf-8' }))
      const a = document.createElement('a')
      a.href = url
      a.download = path.split('/').pop()   // 文件名单段
      a.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      if (!e.vaultRelogin) message.error(e.message)
    }
  }

  const submitRename = () => {
    const to = renameTo.trim().replace(/^\/+|\/+$/g, '')
    if (!to || to === renameFor) { setRenameFor(null); return }
    requirePin(async (pin) => {
      await vaultCall(() => adminApi.vaultRename(curPass(), { from: renameFor, to, pin }))
      message.success('已重命名')
      setRenameFor(null)
      load()
    })
  }

  const removeFile = (path) => {
    Modal.confirm({
      centered: true,
      title: '删除文件？',
      content: `「${path}」删除后不可恢复。`,
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: () => requirePin(async (pin) => {
        await vaultCall(() => adminApi.vaultDelete(curPass(), { path, pin }))
        message.success('已删除')
        if (viewing?.path === path) setViewing(null)
        load()
      }),
    })
  }

  /** 递归统计文件夹下文件数（后端 list 不递归，逐层统计给删除确认文案用） */
  const countFiles = async (p) => {
    const r = await vaultCall(() => adminApi.vaultList(curPass(), p))
    let n = r.files.length
    for (const f of r.folders) n += await countFiles(r.prefix ? `${r.prefix}/${f}` : f)
    return n
  }

  const removeFolder = async (name) => {
    const folderPath = prefix ? `${prefix}/${name}` : name
    let countText = '其下全部文件'
    try {
      countText = `其下全部 ${await countFiles(folderPath)} 个文件`
    } catch (e) {
      if (e.vaultRelogin) return   // 已回密码闸
    }
    Modal.confirm({
      centered: true,
      title: `删除文件夹「${name}」？`,
      content: `将删除${countText}，不可恢复。`,
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: () => requirePin(async (pin) => {
        await vaultCall(() => adminApi.vaultDelete(curPass(), { prefix: folderPath, pin }))
        message.success('文件夹已删除')
        load()
      }),
    })
  }

  /**
   * 新建文件夹：虚拟机制（后端无文件夹实体）——纯前端导航进入新路径，
   * 上传第一个文件后才真实存在；直接离开则自动消失（符合预期）。
   */
  const createFolder = () => {
    const name = newFolderName.trim()
    if (!name || folderNameError(name)) return
    if (listing?.folders.includes(name)) { message.warning('当前目录已存在同名文件夹'); return }
    const p = prefix ? `${prefix}/${name}` : name
    setMkdirOpen(false)
    setNewFolderName('')
    setViewing(null)
    setFreshFolder(p)
    load(p)
  }

  /* ── 渲染 ── */

  const changePassModal = (
    <Modal
      open={changePassOpen}
      onCancel={() => { setChangePassOpen(false); setNewPass('') }}
      onOk={submitNewPass}
      okText="保存"
      cancelText="取消"
      width={380}
      centered
      title="设置新的专用密码"
      okButtonProps={{ disabled: !PASS_RULES.every((r) => r.test(newPass)) }}
    >
      <div style={{ paddingTop: 8 }}>
        <Input.Password
          autoComplete="off"
          placeholder="新专用密码"
          value={newPass}
          onChange={(e) => setNewPass(e.target.value)}
        />
        <PassRules value={newPass} />
        <div style={{ marginTop: 10, fontSize: 12, color: 'var(--mute)', lineHeight: 1.7 }}>
          保存需管理 PIN 确认；保存后需用新密码重新进入文件柜。
        </div>
      </div>
    </Modal>
  )

  if (stage === 'loading') {
    return <div style={{ padding: '48px 0', textAlign: 'center', color: 'var(--mute)', fontSize: 13 }}>加载中…</div>
  }

  if (stage === 'set' || stage === 'unlock') {
    return (
      <div style={{ maxWidth: 380, margin: '40px auto' }}>
        <div className="card" style={{ padding: '22px 22px 18px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <LockOutlined style={{ color: 'var(--accent)' }} />
            <span style={{ fontWeight: 600, fontSize: 15, color: 'var(--ink)' }}>文件柜</span>
          </div>
          <div style={{ fontSize: 12, color: 'var(--mute)', marginBottom: 16, lineHeight: 1.7 }}>
            {stage === 'set'
              ? '首次使用需设置文件柜专用密码（独立于登录密码，仅管理员自用）。'
              : '输入文件柜专用密码进入。'}
          </div>
          {stage === 'unlock' ? (
            <>
              <Input.Password
                autoComplete="off"
                placeholder="文件柜专用密码"
                value={passInput}
                onChange={(e) => setPassInput(e.target.value)}
                onPressEnter={tryUnlock}
              />
              <Button type="primary" block loading={checking} onClick={tryUnlock} style={{ marginTop: 12 }}>
                进入文件柜
              </Button>
              <div style={{ marginTop: 12, fontSize: 12, color: 'var(--mute)' }}>
                忘记密码？
                <a onClick={() => setChangePassOpen(true)} style={{ color: 'var(--accent)' }}>用管理 PIN 重置</a>
              </div>
            </>
          ) : (
            <>
              <Input.Password
                autoComplete="off"
                placeholder="设置文件柜专用密码"
                value={newPass}
                onChange={(e) => setNewPass(e.target.value)}
              />
              <PassRules value={newPass} />
              <Button
                type="primary" block style={{ marginTop: 12 }}
                disabled={!PASS_RULES.every((r) => r.test(newPass))}
                onClick={submitNewPass}
              >
                设置并继续
              </Button>
            </>
          )}
        </div>
        {changePassModal}
        {pinModal}
      </div>
    )
  }

  /* 主界面 */
  const crumbs = prefix ? prefix.split('/') : []
  const isMd = viewing?.path?.toLowerCase().endsWith('.md')
  const rowStyle = {
    display: 'flex', alignItems: 'center', gap: 10,
    padding: '8px 10px', borderBottom: '1px solid var(--hairline)',
  }

  return (
    <div>
      {/* 工具行：面包屑 + 刷新 + 改密码 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, flexWrap: 'wrap' }}>
          <span
            onClick={() => { setViewing(null); load('') }}
            style={{ cursor: 'pointer', fontWeight: 500, color: crumbs.length ? 'var(--accent)' : 'var(--ink)' }}
          >文件柜</span>
          {crumbs.map((seg, i) => {
            const p = crumbs.slice(0, i + 1).join('/')
            const last = i === crumbs.length - 1
            return (
              <span key={p} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <span style={{ color: 'var(--mute)' }}>/</span>
                <span
                  onClick={() => { if (!last) { setViewing(null); load(p) } }}
                  style={{ cursor: last ? 'default' : 'pointer', color: last ? 'var(--ink)' : 'var(--accent)', fontWeight: last ? 500 : 400 }}
                >{seg}</span>
              </span>
            )
          })}
        </div>
        <span style={{ flex: 1 }} />
        {listing?.total && (
          <span className="font-caption" style={{ fontSize: 12, color: 'var(--mute)', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            共 {listing.total.files} 个文件
            <QuotaBar usedBytes={listing.total.used_bytes} quotaMb={null} width={110} />
          </span>
        )}
        <Button size="small" icon={<FolderAddOutlined />} onClick={() => setMkdirOpen(true)}>新建文件夹</Button>
        <Button size="small" icon={<ReloadOutlined />} onClick={() => load()}>刷新</Button>
        <Button size="small" type="text" onClick={() => setChangePassOpen(true)}>修改专用密码</Button>
      </div>

      {viewing ? (
        /* 阅读区 */
        <div className="card" style={{ padding: '14px 16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
            <Button size="small" icon={<ArrowLeftOutlined />} onClick={() => setViewing(null)}>返回列表</Button>
            <span className="font-mono" style={{ fontSize: 12, color: 'var(--ink)', fontWeight: 500, wordBreak: 'break-all' }}>{viewing.path}</span>
            <span className="font-mono" style={{ fontSize: 11, color: 'var(--mute)', flexShrink: 0 }}>
              {fmtSize(viewing.size)} · {fmtTime(viewing.updated_at)}
            </span>
            <span style={{ flex: 1 }} />
            {isMd && (
              <Radio.Group size="small" value={mdMode} onChange={(e) => setMdMode(e.target.value)}>
                <Radio.Button value="render">渲染</Radio.Button>
                <Radio.Button value="raw">原文</Radio.Button>
              </Radio.Group>
            )}
            <Button size="small" icon={<DownloadOutlined />} onClick={() => downloadFile(viewing.path)}>下载</Button>
          </div>
          {isMd && mdMode === 'render' ? (
            <div style={{ padding: '4px 2px' }}>
              <ReactMarkdown
                components={MD_COMPONENTS}
                remarkPlugins={[remarkMath, remarkGfm]}
                rehypePlugins={[rehypeKatex]}
              >{normalizeLatex(viewing.content)}</ReactMarkdown>
            </div>
          ) : (
            <pre className="font-mono" style={{
              background: 'var(--surface-1)', padding: '10px 14px', borderRadius: 8,
              fontSize: 13, lineHeight: 1.7, overflowX: 'auto', margin: 0,
              border: '1px solid var(--hairline)', whiteSpace: 'pre-wrap', wordBreak: 'break-all',
            }}>{viewing.content}</pre>
          )}
        </div>
      ) : (
        <>
          {/* 上传（多选 + 拖拽；批处理收齐后统一走敏感检测 + PIN） */}
          <Upload.Dragger
            multiple
            fileList={[]}
            showUploadList={false}
            beforeUpload={beforeUpload}
            style={{ marginBottom: 14 }}
          >
            <p style={{ margin: '6px 0' }}><InboxOutlined style={{ fontSize: 28, color: 'var(--accent)' }} /></p>
            <p style={{ fontSize: 13, color: 'var(--ink)', margin: 0 }}>点击或拖拽文件到此处上传</p>
            <p style={{ fontSize: 11, color: 'var(--mute)', margin: '4px 0 6px' }}>
              支持多选 · 单文件 ≤ 1MB · 上传到当前目录{prefix ? `（${prefix}/）` : '（根目录）'}
            </p>
          </Upload.Dragger>

          {/* 列表：文件夹 + 文件 */}
          <div className="card" style={{ padding: '4px 8px' }}>
            {!listing ? (
              <div style={{ padding: '30px 0', textAlign: 'center', color: 'var(--mute)', fontSize: 12 }}>加载中…</div>
            ) : (listing.folders.length + listing.files.length === 0) ? (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={freshFolder === prefix ? '这是一个新文件夹，上传第一个文件后即创建' : '空目录'}
                style={{ padding: '20px 0' }}
              />
            ) : (
              <>
                {listing.folders.map((name) => (
                  <div key={`d-${name}`} style={rowStyle}>
                    <FolderOutlined style={{ color: 'var(--accent)', fontSize: 15 }} />
                    <span
                      onClick={() => { setViewing(null); load(prefix ? `${prefix}/${name}` : name) }}
                      style={{ cursor: 'pointer', fontWeight: 500, color: 'var(--ink)', fontSize: 13, flex: 1, wordBreak: 'break-all' }}
                    >{name}</span>
                    <Button size="small" type="text" danger onClick={() => removeFolder(name)}>删除</Button>
                  </div>
                ))}
                {listing.files.map((f) => (
                  <div key={`f-${f.path}`} style={rowStyle}>
                    <FileOutlined style={{ color: 'var(--mute)', fontSize: 14 }} />
                    <span
                      onClick={() => openFile(f.path)}
                      style={{ cursor: 'pointer', color: 'var(--ink)', fontSize: 13, wordBreak: 'break-all' }}
                    >{f.name}</span>
                    <span className="font-mono" style={{ fontSize: 11, color: 'var(--mute)', flexShrink: 0 }}>{fmtSize(f.size)}</span>
                    <span className="font-mono" style={{ fontSize: 11, color: 'var(--mute)', flexShrink: 0 }}>{fmtTimeShort(f.updated_at)}</span>
                    <span style={{ flex: 1 }} />
                    <Button size="small" type="text" onClick={() => openFile(f.path)}>查看</Button>
                    <Button size="small" type="text" onClick={() => downloadFile(f.path)}>下载</Button>
                    <Button size="small" type="text" onClick={() => { setRenameFor(f.path); setRenameTo(f.path) }}>重命名</Button>
                    <Button size="small" type="text" danger onClick={() => removeFile(f.path)}>删除</Button>
                  </div>
                ))}
              </>
            )}
          </div>
        </>
      )}

      {/* 重命名/移动弹窗（改文件夹段 = 移动） */}
      <Modal
        open={!!renameFor}
        onCancel={() => setRenameFor(null)}
        onOk={submitRename}
        okText="确定"
        cancelText="取消"
        width={420}
        centered
        title="重命名 / 移动"
      >
        <div style={{ paddingTop: 8 }}>
          <div style={{ fontSize: 12, color: 'var(--mute)', marginBottom: 8, lineHeight: 1.7 }}>
            修改路径中的文件夹部分即可移动文件；目标已存在同名文件会被拒绝。
          </div>
          <Input
            className="font-mono"
            value={renameTo}
            onChange={(e) => setRenameTo(e.target.value)}
            onPressEnter={submitRename}
          />
        </div>
      </Modal>

      {/* 新建文件夹弹窗（虚拟文件夹：确认即导航进入，上传首文件后才真实存在） */}
      <Modal
        open={mkdirOpen}
        onCancel={() => { setMkdirOpen(false); setNewFolderName('') }}
        onOk={createFolder}
        okText="进入文件夹"
        cancelText="取消"
        width={380}
        centered
        title="新建文件夹"
        okButtonProps={{ disabled: !newFolderName.trim() || !!folderNameError(newFolderName.trim()) }}
      >
        <div style={{ paddingTop: 8 }}>
          <Input
            placeholder="文件夹名（单级）"
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            onPressEnter={createFolder}
            status={folderNameError(newFolderName.trim()) ? 'error' : ''}
          />
          {folderNameError(newFolderName.trim()) && (
            <div style={{ marginTop: 6, fontSize: 12, color: 'var(--error)' }}>
              {folderNameError(newFolderName.trim())}
            </div>
          )}
          <div style={{ marginTop: 8, fontSize: 12, color: 'var(--mute)', lineHeight: 1.7 }}>
            创建于当前目录{prefix ? `（${prefix}/）` : '（根目录）'}；虚拟文件夹上传第一个文件后即真实存在。
          </div>
        </div>
      </Modal>

      {changePassModal}
      {pinModal}
    </div>
  )
}

/* ── 文件柜 Tab 外壳：「我的文件」（管理端私人云柜）/「内测管理」（用户开放内测）── */

function VaultPanel() {
  const [view, setView] = useState('mine')
  return (
    <div>
      <Segmented
        value={view}
        onChange={setView}
        options={[
          { value: 'mine', label: '我的文件' },
          { value: 'beta', label: '内测管理' },
        ]}
        style={{ marginBottom: 12 }}
      />
      {view === 'mine' ? <VaultMinePanel /> : <VaultBetaPanel />}
    </div>
  )
}

/* ── 内测管理：用户文件柜开通/关闭 + 配额调整（改动都走 PIN）── */

function VaultBetaPanel() {
  const { requirePin, pinModal } = usePinFlow()
  const [users, setUsers] = useState(null)
  const [applies, setApplies] = useState([])   // 待审批申请
  const [quotaEdits, setQuotaEdits] = useState({})   // uid → 编辑中的配额值

  const load = useCallback(() => {
    adminApi.vaultUsers()
      .then((r) => { setUsers(r.users || []); setApplies(r.pending_applies || []) })
      .catch((e) => message.error(e.message))
  }, [])
  useEffect(() => { load() }, [load])

  const toggleEnabled = (u, enabled) => requirePin(async (pin) => {
    await adminApi.vaultSetUser({ pin, uid: u.uid, enabled })
    message.success(enabled ? `已开通 ${u.nickname} 的文件柜` : `已关闭 ${u.nickname} 的文件柜`)
    load()
  })

  // 一键开通（申请行内）：开通后该申请自动从待审批消失（enabled 后不再列入）
  const approve = (a) => requirePin(async (pin) => {
    await adminApi.vaultSetUser({ pin, uid: a.uid, enabled: true })
    message.success(`已开通 ${a.nickname} 的文件柜；去「工单处理」回复一下申请单吧`)
    load()
  })

  const saveQuota = (u) => {
    const v = quotaEdits[u.uid]
    if (v == null || v === u.quota_mb) return
    requirePin(async (pin) => {
      await adminApi.vaultSetUser({ pin, uid: u.uid, quota_mb: v })
      message.success(`已将 ${u.nickname} 的配额调整为 ${v} MB`)
      setQuotaEdits((m) => ({ ...m, [u.uid]: undefined }))
      load()
    })
  }

  const columns = [
    {
      title: 'UID', dataIndex: 'uid', width: 90,
      render: (v) => <span className="font-mono" style={{ fontSize: 12 }}>{v}</span>,
    },
    {
      title: '昵称', dataIndex: 'nickname',
      render: (v) => <span style={{ fontSize: 13, color: 'var(--ink)' }}>{v}</span>,
    },
    {
      title: '用量', key: 'usage', width: 190,
      render: (_, u) => <QuotaBar usedBytes={u.used_bytes} quotaMb={u.quota_mb} width={100} />,
    },
    {
      title: '文件数', dataIndex: 'files', width: 80,
      render: (v) => <span className="font-mono" style={{ fontSize: 12 }}>{v}</span>,
    },
    {
      title: '状态', key: 'enabled', width: 80,
      render: (_, u) => (
        <Switch size="small" checked={u.enabled} onChange={(v) => toggleEnabled(u, v)} />
      ),
    },
    {
      title: '配额 (MB)', key: 'quota', width: 200,
      render: (_, u) => (
        <span style={{ display: 'inline-flex', gap: 6 }}>
          <InputNumber
            size="small" min={0} max={1000}
            value={quotaEdits[u.uid] ?? u.quota_mb}
            onChange={(v) => setQuotaEdits((m) => ({ ...m, [u.uid]: v }))}
            style={{ width: 90 }}
          />
          <Button
            size="small"
            disabled={quotaEdits[u.uid] == null || quotaEdits[u.uid] === u.quota_mb}
            onClick={() => saveQuota(u)}
          >确认</Button>
        </span>
      ),
    },
  ]

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
        <span style={{ fontSize: 13, color: 'var(--mute)' }}>
          用户文件柜内测名单：开关 = 开通/关闭（关闭后文件保留），配额 0-1000 MB；改动都需 PIN。
        </span>
        <span style={{ flex: 1 }} />
        <Button size="small" icon={<ReloadOutlined />} onClick={load}>刷新</Button>
      </div>

      {/* 待审批申请（一键开通；拒绝/回复去工单处理） */}
      {applies.length > 0 && (
        <div className="card" style={{ padding: '12px 16px', marginBottom: 14 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)', marginBottom: 8 }}>
            待审批申请（{applies.length}）
          </div>
          {applies.map((a) => (
            <div key={a.tid} style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '8px 0', borderTop: '1px solid var(--hairline)',
          }}>
              <span style={{ fontSize: 13, color: 'var(--ink)' }}>{a.nickname}</span>
              <span className="font-mono" style={{ fontSize: 12, color: 'var(--mute)' }}>uid {a.uid}</span>
              <span style={{ fontSize: 12, color: 'var(--mute)' }}>
                {a.created_at ? new Date(a.created_at).toLocaleString('zh-CN', { hour12: false }) : ''}
              </span>
              <span style={{ flex: 1 }} />
              <Button
                size="small" type="primary"
                style={{ borderRadius: 'var(--r-btn)' }}
                onClick={() => approve(a)}
              >开通</Button>
            </div>
          ))}
        </div>
      )}

      <Table
        rowKey="uid"
        size="small"
        columns={columns}
        dataSource={users || []}
        loading={!users}
        pagination={false}
        locale={{ emptyText: '还没有内测用户' }}
      />
      {pinModal}
    </div>
  )
}

/* ───────── 主界面 ───────── */

export default function AdminView({ onBack }) {
  const [tab, setTab] = useState('overview')
  const [orderFilter, setOrderFilter] = useState('all')

  return (
    <div className="subview-enter" style={{ marginTop: -28 }}>
      {/* 顶部：返回 + 标题（贴左上，同设置二级界面） */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
        <Button type="text" icon={<ArrowLeftOutlined />} onClick={onBack} />
        <h1 className="font-display font-display-sm" style={{ margin: 0 }}>管理后台</h1>
      </div>
      <Tabs
        activeKey={tab}
        onChange={setTab}
        items={[
          { key: 'overview', label: '数据看板', children: (
            <OverviewPanel onGoOrders={() => { setOrderFilter('abnormal'); setTab('orders') }} />
          ) },
          { key: 'users', label: '用户管理', children: <UsersPanel /> },
          { key: 'tasks', label: '任务监控', children: <TasksPanel /> },
          { key: 'tickets', label: '工单处理', children: <TicketsPanel /> },
          { key: 'orders', label: '订单核验', children: (
            <OrdersPanel key={orderFilter} initialFilter={orderFilter} />
          ) },
          { key: 'codes', label: '兑换码', children: <CodesPanel /> },
          { key: 'data', label: '数据管理', children: <DataPanel /> },
          { key: 'vault', label: '文件柜', children: <VaultPanel /> },
          { key: 'models', label: '模型', children: <ModelsPanel /> },
          { key: 'cost', label: '成本', children: <CostPanel /> },
          { key: 'security', label: '安全', children: <SecurityPanel /> },
        ]}
      />
    </div>
  )
}

/* ───────── 模型仓库（V1.1.0：LLM/ASR 双槽位，点启用即时切换）───────── */

const PROVIDER_LABEL = { deepseek: 'DeepSeek', mimo: 'Xiaomi Mimo' }

function ModelSlotPanel({ slot, title, desc, items, source, onRefresh, requirePin }) {
  const [label, setLabel] = useState('')
  const [provider, setProvider] = useState('deepseek')
  const [model, setModel] = useState('')
  const [busy, setBusy] = useState(false)
  const [pricingFor, setPricingFor] = useState(null)   // 定价编辑中的模型行
  const [priceForm, setPriceForm] = useState({})
  const active = items.find(m => m.is_active)

  const openPricing = (m) => {
    setPricingFor(m)
    setPriceForm({
      price_input: m.price_input ?? '',
      price_output: m.price_output ?? '',
      price_cache_hit: m.price_cache_hit ?? '',
      price_per_hour: m.price_per_hour ?? '',
    })
  }
  const savePricing = () => {
    requirePin(async (pin) => {
      await adminApi.updatePricing(pricingFor.id, { ...priceForm, pin })
      message.success('价签已更新（之后的消费按新价计）')
      setPricingFor(null)
      onRefresh()
    })
  }

  const submit = () => {
    if (!label.trim() || !model.trim()) { message.warning('显示名与模型名不能为空'); return }
    requirePin(async (pin) => {
      await adminApi.addModel({ slot, label: label.trim(), provider, model: model.trim(), pin })
      message.success('已添加')
      setLabel(''); setModel('')
      onRefresh()
    })
  }

  return (
    <div className="card" style={{ padding: '16px 18px', marginBottom: 14 }}>
      <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--ink)', marginBottom: 2 }}>{title}</div>
      <div style={{ fontSize: 12, color: 'var(--mute)', marginBottom: 12 }}>{desc}</div>

      {/* 当前生效 */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
        padding: '8px 12px', marginBottom: 12,
        background: 'var(--accent-light)', borderRadius: 'var(--r-input)', fontSize: 12.5,
      }}>
        <span style={{ color: 'var(--accent)', fontWeight: 600 }}>当前生效</span>
        {active ? (
          <>
            <span style={{ color: 'var(--ink)', fontWeight: 500 }}>{active.label}</span>
            <span className="font-mono" style={{ color: 'var(--mute)', fontSize: 11 }}>
              {PROVIDER_LABEL[active.provider]} · {active.model}
            </span>
          </>
        ) : (
          <span style={{ color: 'var(--mute)' }}>环境变量默认（后台未配置）</span>
        )}
      </div>

      {/* 已保存列表 */}
      {items.map(m => (
        <div key={m.id} style={{
          display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
          padding: '8px 12px', marginBottom: 6,
          border: `1px solid ${m.is_active ? 'var(--accent)' : 'var(--hairline)'}`,
          borderRadius: 'var(--r-input)', fontSize: 13,
        }}>
          <span style={{ fontWeight: 500, color: 'var(--ink)' }}>{m.label}</span>
          <span className="font-mono" style={{ fontSize: 11, color: 'var(--mute)' }}>
            {PROVIDER_LABEL[m.provider]} · {m.model}
          </span>
          <span style={{ flex: 1 }} />
          {m.is_active
            ? <Tag color="green" style={{ marginInlineEnd: 0 }}>生效中</Tag>
            : (
              <>
                <Button size="small" onClick={() => requirePin(async (pin) => {
                  await adminApi.activateModel(m.id, pin)
                  message.success(`已切换到 ${m.label}`)
                  onRefresh()
                })}>启用</Button>
                <Button size="small" danger type="text" onClick={() => requirePin(async (pin) => {
                  try {
                    await adminApi.deleteModel(m.id, pin)
                    message.success('已删除')
                    onRefresh()
                  } catch (e) { message.error(e.message) }
                })}>删除</Button>
              </>
            )}
          <Button size="small" type="text" onClick={() => openPricing(m)}>定价</Button>
        </div>
      ))}

      {/* 定价编辑弹窗（留空 = 按厂商默认价；PIN 保存） */}
      <Modal
        open={!!pricingFor}
        onCancel={() => setPricingFor(null)}
        onOk={savePricing}
        okText="保存"
        cancelText="取消"
        width={420}
        centered
        title={pricingFor ? `定价 · ${pricingFor.label}` : ''}
      >
        {pricingFor && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 8 }}>
            <div style={{ fontSize: 12, color: 'var(--mute)', lineHeight: 1.7 }}>
              留空则按厂商默认价计算；修改只影响之后的消费，历史流水不变。
            </div>
            {pricingFor.slot === 'llm' ? (
              <>
                <Input addonBefore="输入价（元/百万 tokens）" value={priceForm.price_input}
                  placeholder="默认 4"
                  onChange={e => setPriceForm(f => ({ ...f, price_input: e.target.value }))} />
                <Input addonBefore="输出价（元/百万 tokens）" value={priceForm.price_output}
                  placeholder="默认 12"
                  onChange={e => setPriceForm(f => ({ ...f, price_output: e.target.value }))} />
                <Input addonBefore="缓存命中价（元/百万 tokens）" value={priceForm.price_cache_hit}
                  placeholder="默认 0.5"
                  onChange={e => setPriceForm(f => ({ ...f, price_cache_hit: e.target.value }))} />
              </>
            ) : (
              <Input addonBefore="每小时价格（元）" value={priceForm.price_per_hour}
                placeholder="默认 0.498"
                onChange={e => setPriceForm(f => ({ ...f, price_per_hour: e.target.value }))} />
            )}
          </div>
        )}
      </Modal>

      {/* 添加表单（PC 管理后台：输入框拉宽，占位提示完整可见） */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
        <Input size="small" placeholder="显示名（如 DeepSeek V4 Flash）" value={label}
          onChange={e => setLabel(e.target.value)} style={{ width: 280 }} />
        {slot === 'llm' && (
          <Select size="small" value={provider} onChange={setProvider} style={{ width: 150 }}
            options={Object.entries(PROVIDER_LABEL).map(([value, l]) => ({ value, label: l }))} />
        )}
        <Input size="small" placeholder="模型名（如 deepseek-v4-flash）" value={model}
          onChange={e => setModel(e.target.value)} className="font-mono" style={{ width: 280 }} />
        <Button size="small" type="primary" loading={busy} onClick={submit}>添加</Button>
      </div>
    </div>
  )
}

function ModelsPanel() {
  const [data, setData] = useState(null)
  const { requirePin, pinModal } = usePinFlow()

  const load = useCallback(() => {
    adminApi.listModels().then(setData).catch(e => message.error(e.message))
  }, [])
  useEffect(() => { load() }, [load])

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
        <span style={{ fontSize: 13, color: 'var(--mute)' }}>
          添加一次永久保存，点「启用」即时切换，无需重启。密钥始终走环境变量，不会入库。
        </span>
        <span style={{ flex: 1 }} />
        <Button size="small" icon={<ReloadOutlined />} onClick={load}>刷新</Button>
      </div>
      {data && (
        <>
          <ModelSlotPanel slot="llm" title="LLM 模型" desc="驱动语义分段 / 内容概要 / MD 笔记 / AI 解读"
            items={data.models.llm || []} source={data.source?.llm} onRefresh={load} requirePin={requirePin} />
          <ModelSlotPanel slot="asr" title="ASR 模型" desc="驱动语音转写（厂商固定 Xiaomi Mimo）"
            items={data.models.asr || []} source={data.source?.asr} onRefresh={load} requirePin={requirePin} />
        </>
      )}
      {pinModal}
    </div>
  )
}

/* ───────── 成本 Tab（V1.1.0：分模型真实成本，结算时写入）───────── */

const MODEL_COLORS = ['#4f46e5', '#0ea5e9', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6', '#ec4899']

function fmtTokens(n) {
  if (n == null) return '—'
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

function CostPanel() {
  const [days, setDays] = useState(30)
  const [data, setData] = useState(null)
  const [showLegacy, setShowLegacy] = useState(false)   // 历史估算行（默认关，精确视图）

  const load = useCallback(() => {
    adminApi.costStats(days).then(setData).catch(e => message.error(e.message))
  }, [days])
  useEffect(() => { load() }, [load])

  const c = data?.cards || {}
  const models = data?.per_model || []
  const trend = data?.trend || []
  const legacy = data?.legacy
  const modelNames = [...new Set(models.map(m => m.model))]

  const cardStyle = {
    flex: 1, minWidth: 140, padding: '12px 16px',
    background: 'var(--surface-2)', borderRadius: 'var(--r-input)',
    border: '1px solid var(--hairline)',
  }
  const numStyle = { fontSize: 20, fontWeight: 600, color: 'var(--ink)' }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 14 }}>
        <Radio.Group value={days} onChange={e => setDays(e.target.value)} size="small">
          <Radio.Button value={1}>今日</Radio.Button>
          <Radio.Button value={7}>7 天</Radio.Button>
          <Radio.Button value={30}>30 天</Radio.Button>
          <Radio.Button value={0}>全部</Radio.Button>
        </Radio.Group>
        {legacy?.cost > 0 && (
          <span style={{ marginLeft: 12, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Switch size="small" checked={showLegacy} onChange={setShowLegacy} />
            <span style={{ fontSize: 12, color: 'var(--mute)' }}>包含历史估算</span>
          </span>
        )}
        <span style={{ flex: 1 }} />
        <Button size="small" icon={<ReloadOutlined />} onClick={load}>刷新</Button>
      </div>

      {/* 总览卡 */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
        <div style={cardStyle}>
          <div style={{ fontSize: 11, color: 'var(--mute)' }}>总成本</div>
          <div style={numStyle}>¥{c.total_cost ?? '—'}</div>
        </div>
        <div style={cardStyle}>
          <div style={{ fontSize: 11, color: 'var(--mute)' }}>输入 tokens</div>
          <div style={numStyle}>{fmtTokens(c.prompt_tokens)}</div>
        </div>
        <div style={cardStyle}>
          <div style={{ fontSize: 11, color: 'var(--mute)' }}>输出 tokens</div>
          <div style={numStyle}>{fmtTokens(c.completion_tokens)}</div>
        </div>
        <div style={cardStyle}>
          <div style={{ fontSize: 11, color: 'var(--mute)' }}>整体缓存命中率</div>
          <div style={{ ...numStyle, color: 'var(--accent)' }}>
            {c.overall_hit_rate != null ? `${c.overall_hit_rate}%` : '—'}
          </div>
        </div>
      </div>

      {/* 成本趋势（按模型堆叠） */}
      {trend.length > 0 && (
        <div className="card" style={{ padding: '14px 16px', marginBottom: 14 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)', marginBottom: 10 }}>
            成本趋势（按模型）
          </div>
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={trend}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--hairline)" />
              <XAxis dataKey="date" tick={{ fontSize: 11 }} stroke="var(--mute)" />
              <YAxis tick={{ fontSize: 11 }} stroke="var(--mute)" width={50}
                tickFormatter={v => `¥${v}`} />
              <ChartTooltip formatter={(v) => `¥${Number(v).toFixed(4)}`} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              {modelNames.map((name, i) => (
                <Area key={name} type="monotone" dataKey={name} stackId="1"
                  stroke={MODEL_COLORS[i % MODEL_COLORS.length]}
                  fill={MODEL_COLORS[i % MODEL_COLORS.length]}
                  fillOpacity={0.25} />
              ))}
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* 分模型明细 */}
      <div className="card" style={{ padding: '14px 16px' }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)', marginBottom: 10 }}>
          分模型明细
        </div>
        {models.length === 0 && (
          <div style={{ fontSize: 12, color: 'var(--mute)', padding: '12px 0' }}>
            该时间段暂无成本数据（V1.1.0 起的消费才会记入）
          </div>
        )}
        {models.map(m => (
          <div key={m.model} style={{
            display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
            padding: '9px 12px', marginBottom: 6,
            border: '1px solid var(--hairline)', borderRadius: 'var(--r-input)',
            fontSize: 12.5,
          }}>
            <span className="font-mono" style={{ fontWeight: 600, color: 'var(--ink)', fontSize: 12 }}>
              {m.model}
            </span>
            <span style={{ flex: 1 }} />
            <span style={{ color: 'var(--mute)' }}>
              {m.minutes > 0
                ? `输入 ${m.minutes.toFixed(1)} 分钟`
                : `输入 ${fmtTokens(m.prompt)}`}
            </span>
            {m.minutes === 0 && <span style={{ color: 'var(--mute)' }}>输出 {fmtTokens(m.completion)}</span>}
            {m.hit_rate != null && (
              <span style={{ color: 'var(--accent)' }}>命中 {m.hit_rate}%</span>
            )}
            <span style={{ fontWeight: 600, color: 'var(--ink)', minWidth: 70, textAlign: 'right' }}>
              ¥{m.cost}
            </span>
          </div>
        ))}
        {/* 历史估算行（开关开启且老行存在时；灰色虚线区分发票区） */}
        {showLegacy && legacy?.cost > 0 && (
          <>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
              padding: '9px 12px', marginTop: 4,
              border: '1px dashed var(--hairline-strong)', borderRadius: 'var(--r-input)',
              fontSize: 12.5, opacity: 0.75,
            }}>
              <span style={{ fontWeight: 600, color: 'var(--mute)', fontSize: 12 }}>
                历史消耗（估算）
              </span>
              <span style={{ flex: 1 }} />
              <span style={{ color: 'var(--mute)' }}>输入 —</span>
              <span style={{ color: 'var(--mute)' }}>输出 —</span>
              <span style={{ fontWeight: 600, color: 'var(--mute)', minWidth: 70, textAlign: 'right' }}>
                ¥{legacy.cost}
              </span>
            </div>
            <div style={{ fontSize: 11, color: 'var(--mute)', marginTop: 6, opacity: 0.8 }}>
              V1.1.0 前的消耗按混合费率估算（分钟 {legacy.minutes} · 量子波 {legacy.quantum} · 引力波 {legacy.gravity}），与数据看板同口径
            </div>
          </>
        )}
      </div>
    </div>
  )
}
