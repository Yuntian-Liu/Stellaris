/**
 * 管理看板（V0.9.0）— 覆盖式二级界面，仅 is_admin 可见入口
 * 四板块（Tabs）：数据看板 / 用户管理 / 兑换码 / 订单核验
 * 数据全部走 adminApi（后端 get_admin_user 守卫，非 admin 403）
 */
import { useState, useEffect, useCallback } from 'react'
import {
  Button, Tabs, Table, Tag, Input, InputNumber, Select, Modal, DatePicker,
  Empty, Tooltip, message,
} from 'antd'
import {
  ArrowLeftOutlined, SearchOutlined, CopyOutlined, ReloadOutlined,
  DownOutlined, UpOutlined, ClockCircleOutlined, DotChartOutlined,
  GlobalOutlined, SwapOutlined, GiftOutlined, ToolOutlined,
} from '@ant-design/icons'
import {
  ResponsiveContainer, ComposedChart, BarChart, Bar, Line,
  XAxis, YAxis, Tooltip as ChartTooltip, CartesianGrid,
} from 'recharts'
import { adminApi } from '../hooks/api'
import TierBadge from '../components/TierBadge'
import PinModal from '../components/PinModal'
import { tierMeta } from '../utils/tier'

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
  membership_gift: '会员赠送', admin_adjust: '管理员调整',
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
  useEffect(() => {
    adminApi.trends(30)
      .then((r) => setItems(r.items.map((it) => ({ ...it, label: chartLabel(it.date) }))))
      .catch((e) => message.error(e.message))
  }, [])

  const ChartCard = ({ title, children }) => (
    <div className="card" style={{ padding: '14px 16px 8px', flex: 1, minWidth: 280 }}>
      <div style={{ fontSize: 12, color: 'var(--mute)', marginBottom: 8 }}>{title}</div>
      {items === null
        ? <div style={{ height: 220, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--mute)', fontSize: 12 }}>加载中…</div>
        : children}
    </div>
  )

  return (
    <div>
      <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--ink)', margin: '18px 0 10px' }}>
        趋势（近 30 天）
      </div>
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
    </div>
  )
}

/* ───────── ① 数据看板 ───────── */

function OverviewPanel({ onGoOrders }) {
  const [data, setData] = useState(null)
  const load = useCallback(() => {
    adminApi.overview().then(setData).catch((e) => message.error(e.message))
  }, [])
  useEffect(load, [load])

  const abnormal = ABNORMAL_STATUS
    .reduce((s, k) => s + (data?.order_status_counts?.[k] || 0), 0)

  const Metric = ({ label, value, sub, danger, onClick }) => (
    <div className="card" onClick={onClick} style={{
      padding: '14px 16px', minWidth: 150, flex: 1,
      cursor: onClick ? 'pointer' : 'default',
    }}>
      <div style={{ fontSize: 12, color: 'var(--mute)', marginBottom: 6 }}>{label}</div>
      <div className="font-mono" style={{
        fontSize: 22, fontWeight: 600, color: danger ? 'var(--error)' : 'var(--ink)',
      }}>
        {value}
      </div>
      {sub && <div style={{ fontSize: 11, color: 'var(--mute)', marginTop: 4 }}>{sub}</div>}
    </div>
  )

  return (
    <div>
      {/* 渐变横幅卡（复用数据统计卡风格） */}
      <div style={{
        position: 'relative', borderRadius: 'var(--r-card)',
        padding: '20px 22px 16px', marginBottom: 16,
        background: 'linear-gradient(135deg, #4f46e5 0%, #6d28d9 100%)',
        color: '#fff', overflow: 'hidden',
      }}>
        <span style={{
          position: 'absolute', top: 16, right: 20, fontSize: 18,
          fontFamily: "'Cormorant Garamond', serif", opacity: 0.9,
        }}>✦</span>
        <div style={{ position: 'relative' }}>
          <div style={{ fontSize: 13, opacity: 0.85, marginBottom: 6 }}>全站概览</div>
          <div style={{ fontSize: 15, lineHeight: 1.7 }}>
            累计收入 <b style={{ fontSize: 22 }}>¥{data ? data.revenue.toFixed(2) : '-'}</b>
            · 付费订单 <b style={{ fontSize: 22 }}>{data ? data.paid_orders : '-'}</b> 笔
            · 累计 tokens <b style={{ fontSize: 22 }}>{data ? fmt(data.tokens_total) : '-'}</b>
          </div>
          <div style={{ fontSize: 11, opacity: 0.7, marginTop: 12 }}>
            「今日」以 UTC+8 凌晨 04:00 为界 · tokens 取 user_stats 累计，分钟流水无 token 字段
          </div>
        </div>
      </div>
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

      {/* 消耗与成本（估算口径，单价见后端注释） */}
      <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--ink)', margin: '18px 0 10px' }}>
        消耗与成本
      </div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <Metric label="今日消耗" value={data ? `¥${data.cost_today.toFixed(2)}` : '-'}
          sub={consumedText(data?.consumed_today)} />
        <Metric label="累计消耗" value={data ? `¥${data.cost_total.toFixed(2)}` : '-'}
          sub={consumedText(data?.consumed_total)} />
        <Metric label="毛利（累计）" value={data ? `¥${data.margin.toFixed(2)}` : '-'}
          sub="收入 − 估算成本" />
        <Metric label="今日活跃" value={data?.active_users_today ?? '-'}
          sub="今日有流水的用户" />
        <Metric label="新增注册（本周）" value={data?.users_week ?? '-'}
          sub={`其中今日 ${data?.users_today ?? '-'}`} />
      </div>

      {/* 会员分布（user_billing 原始档位计数 + 开发者单列） */}
      <div className="card" style={{ padding: '14px 16px', marginTop: 12 }}>
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
                {note && (
                  <div className="font-mono" style={{ fontSize: 11, color: 'var(--mute)', marginTop: 1 }}>{note}</div>
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
    requirePin(async (pin) => {
      setBusy(true)
      try {
        const payload = { uid: u.uid, pin }
        if (field === 'quantum') payload.quantum_delta = delta
        else payload.gravity_delta = delta
        const r = await adminApi.adjustBalance(payload)
        message.success(`已调整：量子波 ${r.applied.quantum >= 0 ? '+' : ''}${r.applied.quantum}，引力波 ${r.applied.gravity >= 0 ? '+' : ''}${r.applied.gravity}`)
        afterChange()
      } finally { setBusy(false) }
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
        {created.length > 0 && (
          <div style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {created.map((c) => (
              <Tag key={c} color="geekblue" style={{ cursor: 'pointer', fontSize: 13, padding: '3px 10px' }}
                icon={<CopyOutlined />} onClick={() => copyCode(c)}>
                {c}
              </Tag>
            ))}
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
          { title: '已用', render: (_, r) => `${r.use_count}/${r.max_uses}` },
          { title: '使用者', dataIndex: 'used_by', render: (v) => v ?? '—' },
          { title: '备注', dataIndex: 'note', render: (v) => v || '—' },
          { title: '过期时间', dataIndex: 'expires_at', render: fmtTime },
          { title: '创建时间', dataIndex: 'created_at', render: fmtTime },
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

/* ───────── 主界面 ───────── */

export default function AdminView({ onBack }) {
  const [tab, setTab] = useState('overview')
  const [orderFilter, setOrderFilter] = useState('all')

  return (
    <div className="subview-enter">
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
          { key: 'codes', label: '兑换码', children: <CodesPanel /> },
          { key: 'orders', label: '订单核验', children: (
            <OrdersPanel key={orderFilter} initialFilter={orderFilter} />
          ) },
        ]}
      />
    </div>
  )
}
