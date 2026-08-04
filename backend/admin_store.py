"""
管理看板 — 查询与动作助手（仅 /api/admin/* 调用，路由层已做 get_admin_user 守卫）

口径说明：
- "今日"边界与计费一致：UTC+8 凌晨 04:00（_period_keys 的 day_key）
- tokens 无精确流水字段：累计取 user_stats.tokens_used 求和，流水笔数取 billing_ledger 行数
- 收入 = afdian_orders 中 processed/donation 状态的 total_amount（字符串）转 float 求和，保留 2 位
"""
import asyncio
import json
import logging
import os
import re
import shutil
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from sqlalchemy import case, func, select

from database import async_session
from auth.models import User
from auth.utils import hash_password, verify_password
from billing_store import (
    UserBilling, BillingLedger, AnonUsage, _get_or_create, _record, _iso_utc,
    _period_keys, _TZ_CN, grant_membership, _effective_tier_key,
)
from config import DATA_DIR
from redeem_store import RedeemCode
from afdian_store import AfdianOrder, api_sign, update_order_status
from stats_store import UserStats, get_stats
from history_store import TaskRecord

# 进程启动时间（uptime 用）
_START_TIME = time.time()

logger = logging.getLogger(__name__)

# 成本估算单价（元/单位，粗口径仅供运营参考，非精确账单）：
# 分钟 = ASR 时长折算 0.0083；量子波 = 100 tokens ≈ 0.0008；引力波 = 500 tokens ≈ 0.004
COST_PER_MINUTE = 0.0083
COST_PER_QUANTUM = 0.0008
COST_PER_GRAVITY = 0.004

_CURRENCIES = ("minute", "quantum", "gravity")


class AdminError(Exception):
    """管理操作失败。detail 给前端展示"""
    def __init__(self, detail: str):
        self.detail = detail
        super().__init__(detail)


class PinError(AdminError):
    """PIN 校验失败。status_code：409 未设置 / 403 错误 / 423 锁定"""
    def __init__(self, detail: str, status_code: int):
        super().__init__(detail)
        self.status_code = status_code


def _today_start_utc() -> datetime:
    """今日起点（naive UTC）：day_key 日 04:00（UTC+8）= day_key 00:00 UTC - 4h"""
    day_key, _, _ = _period_keys()
    return datetime.strptime(day_key, "%Y-%m-%d") - timedelta(hours=4)


def _week_start_utc() -> datetime:
    """本周起点（naive UTC）：周一 04:00（UTC+8），与"今日"同界"""
    shifted = datetime.now(_TZ_CN) - timedelta(hours=4)
    monday = datetime(shifted.year, shifted.month, shifted.day) - timedelta(days=shifted.weekday())
    return monday - timedelta(hours=4)


def _est_cost(minute: int, quantum: int, gravity: int) -> float:
    """估算成本（元，保留 2 位）：按 COST_PER_* 单价折算，粗口径"""
    return round(minute * COST_PER_MINUTE + quantum * COST_PER_QUANTUM
                 + gravity * COST_PER_GRAVITY, 2)


async def _consumption(session, since: datetime | None = None,
                       legacy_only: bool = False) -> dict[str, int]:
    """三货币消耗量（billing_ledger 中 amount<0 的绝对值求和；since 限定起点）。
    legacy_only=True 只数无 cost_yuan 的老行（V1.1.0 Overview 混合口径：老行按波估算）。"""
    out = {}
    for cur in _CURRENCIES:
        stmt = select(func.coalesce(func.sum(-BillingLedger.amount), 0)).where(
            BillingLedger.currency == cur, BillingLedger.amount < 0,
        )
        if since is not None:
            stmt = stmt.where(BillingLedger.created_at >= since)
        if legacy_only:
            stmt = stmt.where(BillingLedger.cost_yuan.is_(None))
        out[cur] = (await session.execute(stmt)).scalar_one()
    return out


async def _real_cost(session, since: datetime | None = None) -> float:
    """新流水真实成本求和（V1.1.0 起 cost_yuan 非空的"发票"行）"""
    stmt = select(func.coalesce(func.sum(BillingLedger.cost_yuan), 0.0)).where(
        BillingLedger.cost_yuan.isnot(None))
    if since is not None:
        stmt = stmt.where(BillingLedger.created_at >= since)
    return float((await session.execute(stmt)).scalar_one())


# ===== 看板统计 =====

async def get_overview(active_tasks: int = 0) -> dict:
    """统计卡数据。active_tasks：内存中未完成任务数（无 task_records 记录，补入今日/累计）"""
    today_start = _today_start_utc()
    week_start = _week_start_utc()
    async with async_session() as session:
        users_total = (await session.execute(select(func.count(User.id)))).scalar_one()
        users_today = (await session.execute(
            select(func.count(User.id)).where(User.created_at >= today_start)
        )).scalar_one()
        users_week = (await session.execute(
            select(func.count(User.id)).where(User.created_at >= week_start)
        )).scalar_one()
        admin_users = (await session.execute(
            select(func.count(User.id)).where(User.is_admin.is_(True))
        )).scalar_one()
        tasks_total = (await session.execute(select(func.count(TaskRecord.task_id)))).scalar_one()
        tasks_today = (await session.execute(
            select(func.count(TaskRecord.task_id)).where(TaskRecord.created_at >= today_start)
        )).scalar_one()
        ledger_total = (await session.execute(select(func.count(BillingLedger.id)))).scalar_one()
        ledger_today = (await session.execute(
            select(func.count(BillingLedger.id)).where(BillingLedger.created_at >= today_start)
        )).scalar_one()
        tokens_total = (await session.execute(
            select(func.coalesce(func.sum(UserStats.tokens_used), 0))
        )).scalar_one()
        # 今日活跃：今日有流水（含消耗与赠送）的去重用户数
        active_users_today = (await session.execute(
            select(func.count(func.distinct(BillingLedger.user_uid)))
            .where(BillingLedger.created_at >= today_start)
        )).scalar_one()
        consumed_today = await _consumption(session, today_start)
        consumed_total = await _consumption(session)
        # 会员分布：按【生效档位】统计（与用户端/用户管理同口径懒降级——付费档过期归 free、
        # is_admin 归 admin；原 GROUP BY 存储原值会把过期付费档错误留在分布里，碳碳实测）
        billing_rows = (await session.execute(select(UserBilling))).scalars().all()
        tier_dist: dict[str, int] = {}
        for b in billing_rows:
            eff = await _effective_tier_key(session, b)
            tier_dist[eff] = tier_dist.get(eff, 0) + 1
        # 无计费账户的用户（注册后从未触达计费）归入免费版
        free_extra = users_total - len(billing_rows)
        if free_extra > 0:
            tier_dist["free"] = tier_dist.get("free", 0) + free_extra
        # 收入：total_amount 是字符串，转 float 求和；today/week 也一起算
        all_rows = (await session.execute(
            select(AfdianOrder.status, AfdianOrder.total_amount, AfdianOrder.created_at)
        )).all()
    def _sum_paid(rows):
        return round(sum(float(amount or 0) for s, amount, _ in rows
                         if s in ("processed", "donation")), 2)
    revenue = _sum_paid(all_rows)
    revenue_today = _sum_paid([r for r in all_rows if r[2] and r[2] >= today_start])
    revenue_week = _sum_paid([r for r in all_rows if r[2] and r[2] >= week_start])
    paid_orders = sum(1 for s, _, _ in all_rows if s in ("processed", "donation"))
    status_counts: dict[str, int] = {}
    for s, _, _ in all_rows:
        status_counts[s] = status_counts.get(s, 0) + 1
    # V1.1.0 混合口径：成本 = 新流水真实 cost_yuan 求和 + 老流水按波估算（渐进真实化）
    async with async_session() as session:
        legacy_today = await _consumption(session, today_start, legacy_only=True)
        legacy_total = await _consumption(session, legacy_only=True)
        cost_today = round(await _real_cost(session, today_start)
                           + _est_cost(legacy_today["minute"], legacy_today["quantum"],
                                       legacy_today["gravity"]), 2)
        cost_total = round(await _real_cost(session)
                           + _est_cost(legacy_total["minute"], legacy_total["quantum"],
                                       legacy_total["gravity"]), 2)
    return {
        "users_total": users_total,
        "users_today": users_today,
        "users_week": users_week,
        "admin_users": admin_users,
        "tasks_today": tasks_today + active_tasks,
        "tasks_total": tasks_total + active_tasks,
        "running_tasks": active_tasks,
        "ledger_today": ledger_today,
        "ledger_total": ledger_total,
        "tokens_total": tokens_total,
        "active_users_today": active_users_today,
        "consumed_today": consumed_today,
        "consumed_total": consumed_total,
        "cost_today": cost_today,
        "cost_total": cost_total,
        "margin": round(revenue - cost_total, 2),   # 毛利 = 收入 - 成本（V1.1.0 起混合口径：新真实+老估算）
        "tier_distribution": tier_dist,
        "revenue": revenue,
        "revenue_today": revenue_today,
        "revenue_week": revenue_week,
        "paid_orders": paid_orders,
        "order_status_counts": status_counts,
    }


async def get_user_usage(uid: int) -> dict:
    """单用户用量详情：今日/累计三货币消耗 + 功能使用次数 + 最近 20 条流水 + user_stats"""
    today_start = _today_start_utc()
    async with async_session() as session:
        user = (await session.execute(select(User).where(User.uid == uid))).scalar_one_or_none()
        if not user:
            raise AdminError(f"用户不存在：uid={uid}")
        base = select(func.coalesce(func.sum(-BillingLedger.amount), 0)).where(
            BillingLedger.user_uid == uid, BillingLedger.amount < 0,
        )
        consumed_today = {}
        consumed_total = {}
        for cur in _CURRENCIES:
            consumed_total[cur] = (await session.execute(
                base.where(BillingLedger.currency == cur))).scalar_one()
            consumed_today[cur] = (await session.execute(
                base.where(BillingLedger.currency == cur,
                           BillingLedger.created_at >= today_start))).scalar_one()
        # 功能使用次数（feature 原样返回，前端做展示名映射）
        feature_rows = (await session.execute(
            select(BillingLedger.feature, func.count())
            .where(BillingLedger.user_uid == uid)
            .group_by(BillingLedger.feature)
        )).all()
        recent = (await session.execute(
            select(BillingLedger)
            .where(BillingLedger.user_uid == uid)
            .order_by(BillingLedger.created_at.desc(), BillingLedger.id.desc())
            .limit(20)
        )).scalars().all()
    return {
        "uid": uid,
        "consumed_today": consumed_today,
        "consumed_total": consumed_total,
        "feature_counts": {f: c for f, c in feature_rows},
        "recent_ledger": [
            {
                "id": r.id,
                "feature": r.feature,
                "currency": r.currency,
                "amount": r.amount,
                "from_gift": r.from_gift,
                "from_perm": r.from_perm,
                "balance_after": r.balance_after,
                "created_at": _iso_utc(r.created_at),
            }
            for r in recent
        ],
        "stats": await get_stats(uid),
    }


# ===== 用户管理 =====

async def search_users(q: str, limit: int = 20) -> list[dict]:
    """按 email 模糊 或 uid 精确搜索，返回用户 + 计费账户摘要"""
    q = q.strip()
    if not q:
        return []
    async with async_session() as session:
        if q.isdigit():
            stmt = select(User).where(User.uid == int(q))
        else:
            stmt = select(User).where(User.email.ilike(f"%{q}%"))
        users = (await session.execute(stmt.limit(limit))).scalars().all()
        uids = [u.uid for u in users]
        billings = {}
        if uids:
            rows = (await session.execute(
                select(UserBilling).where(UserBilling.user_uid.in_(uids))
            )).scalars()
            billings = {r.user_uid: r for r in rows}
        result = []
        for u in users:
            b = billings.get(u.uid)
            # 档位主显示 = 生效档位（与用户端同口径：is_admin→admin，付费档过期→free 懒降级）；
            # raw_tier 保留存储原值对账（碳碳定稿：过期还显示原档位会误导运营判断）
            if b:
                effective = await _effective_tier_key(session, b)
            else:
                effective = "admin" if u.is_admin else "free"
            result.append({
                "uid": u.uid,
                "email": u.email,
                "nickname": u.nickname,
                "is_admin": u.is_admin,
                "tier": effective,
                "raw_tier": (b.membership_tier if b else "free"),
                "expire_at": _iso_utc(b.membership_expire_at) if b else None,
                "quantum_gift": b.quantum_gift if b else 0,
                "quantum_perm": b.quantum_perm if b else 0,
                "gravity": b.gravity if b else 0,
                "minutes_day": b.minutes_day if b else 0,
                "minutes_week": b.minutes_week if b else 0,
                "minutes_month": b.minutes_month if b else 0,
                "created_at": _iso_utc(u.created_at),
            })
        return result


async def adjust_balance(uid: int, quantum_delta: int = 0, gravity_delta: int = 0, note: str = "") -> dict:
    """余额 ± 调整（下限 0，不倒欠；量子波调活动钱包——赠送钱包每周清零留不住）。
    流水记 feature="admin_adjust"，amount 为实际生效量（下限截断后与请求量可能不同），note 备注。"""
    async with async_session() as session:
        user = (await session.execute(select(User).where(User.uid == uid))).scalar_one_or_none()
        if not user:
            raise AdminError(f"用户不存在：uid={uid}")
        row = await _get_or_create(session, uid)
        applied = {"quantum": 0, "gravity": 0}
        note_trunc = (note or "")[:64]
        if quantum_delta:
            new_perm = max(0, row.quantum_perm + quantum_delta)
            actual = new_perm - row.quantum_perm
            row.quantum_perm = new_perm
            if actual:
                await _record(session, uid, "admin_adjust", "quantum", actual,
                              row.quantum_gift + row.quantum_perm,
                              from_gift=0, from_perm=actual, note=note_trunc)
            applied["quantum"] = actual
        if gravity_delta:
            new_gravity = max(0, row.gravity + gravity_delta)
            actual = new_gravity - row.gravity
            row.gravity = new_gravity
            if actual:
                await _record(session, uid, "admin_adjust", "gravity", actual, row.gravity,
                              note=note_trunc)
            applied["gravity"] = actual
        await session.commit()
        logger.info("[Admin] 余额调整: uid=%s quantum=%+d gravity=%+d note=%s",
                    uid, applied["quantum"], applied["gravity"], note_trunc)
        return {
            "uid": uid,
            "applied": applied,
            "quantum_gift": row.quantum_gift,
            "quantum_perm": row.quantum_perm,
            "gravity": row.gravity,
        }


async def revoke_membership(uid: int) -> dict:
    """收回档位：tier 置 free，到期/赠礼时间置空（赠送的货币不追回）"""
    async with async_session() as session:
        row = await session.get(UserBilling, uid)
        if not row:
            raise AdminError("该用户无计费账户")
        row.membership_tier = "free"
        row.membership_expire_at = None
        row.gravity_grant_at = None
        await session.commit()
    logger.info("[Admin] 收回档位: uid=%s", uid)
    return {"uid": uid, "tier": "free", "expire_at": None}


# ===== 兑换码 =====

async def list_codes(limit: int = 200) -> list[dict]:
    """兑换码全量（时间倒序）"""
    async with async_session() as session:
        result = await session.execute(
            select(RedeemCode).order_by(RedeemCode.created_at.desc()).limit(limit)
        )
        return [
            {
                "code": r.code,
                "tier": r.tier,
                "days": r.days,
                "grant_mode": r.grant_mode,
                "quantum_grant": r.quantum_grant,
                "gravity_grant": r.gravity_grant,
                "max_uses": r.max_uses,
                "use_count": r.use_count,
                "used_by": r.used_by,
                "used_at": _iso_utc(r.used_at),
                "expires_at": _iso_utc(r.expires_at),
                "note": r.note,
                "created_at": _iso_utc(r.created_at),
            }
            for r in result.scalars()
        ]


# ===== 订单 =====

async def list_orders(status: str | None = None, limit: int = 200) -> list[dict]:
    """订单列表（时间倒序；status 可筛选 processed/grant_failed/unmapped_user 等）"""
    async with async_session() as session:
        stmt = select(AfdianOrder)
        if status:
            stmt = stmt.where(AfdianOrder.status == status)
        result = await session.execute(
            stmt.order_by(AfdianOrder.created_at.desc()).limit(limit)
        )
        return [
            {
                "out_trade_no": r.out_trade_no,
                "user_uid": r.user_uid,
                "plan_id": r.plan_id,
                "total_amount": r.total_amount,
                "status": r.status,
                "created_at": _iso_utc(r.created_at),
            }
            for r in result.scalars()
        ]


async def fulfill_order(out_trade_no: str, uid: int, tier: str, days: int | None) -> dict:
    """人工补发：开通会员 + 订单状态改 processed。档位非法由 grant_membership 抛错（路由层转 400）"""
    async with async_session() as session:
        order = await session.get(AfdianOrder, out_trade_no)
        if not order:
            raise AdminError(f"订单不存在：{out_trade_no}")
        user = (await session.execute(select(User).where(User.uid == uid))).scalar_one_or_none()
        if not user:
            raise AdminError(f"用户不存在：uid={uid}")
    result = await grant_membership(uid, tier, days)
    await update_order_status(out_trade_no, "processed")
    logger.info("[Admin] 订单补发: order=%s uid=%s tier=%s days=%s",
                out_trade_no, uid, tier, days)
    return result


async def recheck_order(out_trade_no: str) -> dict:
    """query-order 反查爱发电侧真实状态。网络失败/平台报错 → AdminError（路由层转 502，不 500）"""
    import httpx
    from config import AFDIAN_USER_ID, AFDIAN_API_TOKEN
    if not AFDIAN_USER_ID or not AFDIAN_API_TOKEN:
        raise AdminError("爱发电 API 凭证未配置（AFDIAN_USER_ID / AFDIAN_API_TOKEN）")
    params = json.dumps({"out_trade_no": out_trade_no}, separators=(",", ":"))
    ts = int(time.time())
    body = {
        "user_id": AFDIAN_USER_ID,
        "params": params,
        "ts": ts,
        "sign": api_sign(params, ts),
    }
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post("https://afdian.com/api/open/query-order", json=body)
    except httpx.HTTPError as e:
        raise AdminError(f"爱发电 API 请求失败：{e}")
    try:
        data = resp.json()
    except ValueError:
        raise AdminError(f"爱发电 API 返回非 JSON（HTTP {resp.status_code}）")
    if data.get("ec") != 200:
        raise AdminError(f"爱发电 API 错误：{data.get('em') or data}")
    payload = data.get("data") or {}
    return {
        "orders": payload.get("list") or [],
        "total_count": payload.get("total_count", 0),
    }


# ===== 趋势图表（按天聚合，UTC+8 04:00 界，缺天补零）=====

async def get_trends(days: int = 30) -> dict:
    """近 N 天趋势：每日消耗（分钟 / tokens=量子波×100+引力波×500，amount<0 绝对值）、
    每日收入（processed/donation 金额）、每日新增注册。date 为本地日（created_at +4h 取日期）。"""
    days = min(max(1, days), 90)
    today_start = _today_start_utc()
    start = today_start - timedelta(days=days - 1)
    # 日期轴按 day_key 生成：today_start 是边界时刻（昨日 20:00 UTC），+4h 才是当前日
    day0 = (today_start + timedelta(hours=4)).date()
    ledger_day = func.date(BillingLedger.created_at, "+4 hours")
    order_day = func.date(AfdianOrder.created_at, "+4 hours")
    user_day = func.date(User.created_at, "+4 hours")
    async with async_session() as session:
        minute_rows = (await session.execute(
            select(ledger_day, func.coalesce(func.sum(-BillingLedger.amount), 0))
            .where(BillingLedger.currency == "minute", BillingLedger.amount < 0,
                   BillingLedger.created_at >= start)
            .group_by(ledger_day)
        )).all()
        token_rows = (await session.execute(
            select(ledger_day, func.coalesce(func.sum(case(
                (BillingLedger.currency == "quantum", -BillingLedger.amount * 100),
                (BillingLedger.currency == "gravity", -BillingLedger.amount * 500),
                else_=0,
            )), 0))
            .where(BillingLedger.amount < 0, BillingLedger.created_at >= start)
            .group_by(ledger_day)
        )).all()
        rev_rows = (await session.execute(
            select(order_day, AfdianOrder.total_amount)
            .where(AfdianOrder.status.in_(("processed", "donation")),
                   AfdianOrder.created_at >= start)
        )).all()
        signup_rows = (await session.execute(
            select(user_day, func.count())
            .where(User.created_at >= start)
            .group_by(user_day)
        )).all()
    minutes = {d: v for d, v in minute_rows}
    tokens = {d: v for d, v in token_rows}
    revenue: dict[str, float] = {}
    for d, amount in rev_rows:
        revenue[d] = round(revenue.get(d, 0) + float(amount or 0), 2)
    signups = {d: c for d, c in signup_rows}
    items = []
    for i in range(days):
        day = (day0 - timedelta(days=days - 1 - i)).isoformat()
        items.append({
            "date": day,
            "minutes": int(minutes.get(day, 0)),
            "tokens": int(tokens.get(day, 0)),
            "revenue": revenue.get(day, 0),
            "signups": signups.get(day, 0),
        })
    return {"days": days, "items": items}


# ===== 管理 PIN（敏感操作二次验证）=====
# 失败计数放内存（重启清零，个人项目够用）：窗口内连续 5 次失败锁 10 分钟

_PIN_FAIL_WINDOW = 600   # 秒（10 分钟）
_PIN_MAX_FAILS = 5
_pin_fails: dict[int, list[float]] = {}


async def set_pin(uid: int, pin: str) -> None:
    """设置/更新管理 PIN：6 位纯数字，bcrypt 哈希（复用 auth 的 sha256 prehash 模式）"""
    if not re.fullmatch(r"\d{6}", pin or ""):
        raise AdminError("PIN 须为 6 位纯数字")
    hashed = await asyncio.to_thread(hash_password, pin)
    async with async_session() as session:
        user = (await session.execute(select(User).where(User.uid == uid))).scalar_one_or_none()
        if not user:
            raise AdminError(f"用户不存在：uid={uid}")
        user.admin_pin_hash = hashed
        await session.commit()
    _pin_fails.pop(uid, None)
    logger.info("[Admin] 管理 PIN 已设置: uid=%s", uid)


async def pin_status(uid: int) -> bool:
    """是否已设置 PIN"""
    async with async_session() as session:
        user = (await session.execute(select(User).where(User.uid == uid))).scalar_one_or_none()
        return bool(user and user.admin_pin_hash)


async def verify_admin_pin(uid: int, pin: str) -> None:
    """敏感操作前校验 PIN。未设 409 / 错误 403（累计失败）/ 锁定 423（带剩余秒数）"""
    now = time.time()
    fails = [t for t in _pin_fails.get(uid, []) if now - t < _PIN_FAIL_WINDOW]
    _pin_fails[uid] = fails
    if len(fails) >= _PIN_MAX_FAILS:
        remaining = int(_PIN_FAIL_WINDOW - (now - fails[0])) + 1
        raise PinError(f"失败次数过多，已锁定，请 {remaining} 秒后再试", 423)
    async with async_session() as session:
        user = (await session.execute(select(User).where(User.uid == uid))).scalar_one_or_none()
        if not user or not user.admin_pin_hash:
            raise PinError("请先设置管理 PIN", 409)
        ok = await asyncio.to_thread(verify_password, pin or "", user.admin_pin_hash)
    if not ok:
        fails.append(now)
        left = _PIN_MAX_FAILS - len(fails)
        raise PinError("PIN 错误" + (f"，剩余 {left} 次机会" if left > 0 else "，已锁定 10 分钟"), 403)
    _pin_fails.pop(uid, None)


# ===== 运营统计（V0.9.3 新增）=====

async def get_codes_summary() -> dict:
    """兑换码汇总：总生成/已核销/未核销/按档位分布"""
    async with async_session() as session:
        total = (await session.execute(select(func.count(RedeemCode.code)))).scalar_one()
        used = (await session.execute(
            select(func.count(RedeemCode.code)).where(RedeemCode.use_count > 0)
        )).scalar_one()
        tier_rows = (await session.execute(
            select(RedeemCode.tier, func.count()).group_by(RedeemCode.tier)
        )).all()
    return {
        "total": total,
        "used": used,
        "unused": total - used,
        "by_tier": {t: c for t, c in tier_rows},
    }


async def get_feature_usage(days: int = 7) -> dict:
    """最近 N 天功能使用次数（billing_ledger 中消耗类 feature，amount<0）"""
    since = datetime.now(_TZ_CN).replace(tzinfo=None) - timedelta(days=days)
    async with async_session() as session:
        rows = (await session.execute(
            select(BillingLedger.feature, func.count())
            .where(BillingLedger.created_at >= since, BillingLedger.amount < 0)
            .group_by(BillingLedger.feature)
        )).all()
    return {"days": days, "features": {f: c for f, c in rows}}


async def get_recent_tasks(limit: int = 100, uid_filter: int | None = None,
                           task_id: str | None = None) -> list[dict]:
    """最近提取任务列表（task_records），可按 UID 或 task_id 过滤"""
    async with async_session() as session:
        stmt = select(TaskRecord).order_by(TaskRecord.created_at.desc()).limit(limit)
        if uid_filter:
            stmt = stmt.where(TaskRecord.owner_uid == uid_filter)
        if task_id:
            stmt = stmt.where(TaskRecord.task_id == task_id.strip())
        result = await session.execute(stmt)
    return [
        {
            "task_id": r.task_id,
            "owner_uid": r.owner_uid,
            "title": r.title,
            "source_platform": r.source_platform,
            "created_at": _iso_utc(r.created_at),
        }
        for r in result.scalars()
    ]


async def get_task_detail(task_id: str) -> dict | None:
    """单个任务详情：task_records + billing_ledger 汇总，供管理后台排查问题"""
    async with async_session() as session:
        # task_records 基本信息
        rec = (await session.execute(
            select(TaskRecord).where(TaskRecord.task_id == task_id)
        )).scalar_one_or_none()
        if not rec:
            return None
        # billing_ledger 流水（该任务的所有扣费/赠送记录）
        ledger_rows = (await session.execute(
            select(BillingLedger).where(BillingLedger.task_id == task_id)
            .order_by(BillingLedger.created_at.asc())
        )).scalars().all()
    invoice = [r for r in ledger_rows if r.cost_yuan is not None]
    cost_summary = {
        "has_invoice": bool(invoice),
        "total": round(sum(r.cost_yuan or 0 for r in invoice), 4),
        "asr_minutes": sum(abs(r.amount or 0) for r in invoice if r.currency == "minute"),
        "models": sorted({r.model for r in invoice if r.model}),
        "prompt": sum(r.prompt_tokens or 0 for r in invoice),
        "completion": sum(r.completion_tokens or 0 for r in invoice),
        "hit_rate": None,
    }
    hit = sum(r.cache_hit_tokens or 0 for r in invoice)
    miss = sum(r.cache_miss_tokens or 0 for r in invoice)
    if hit + miss:
        cost_summary["hit_rate"] = round(hit / (hit + miss) * 100, 1)
    return {
        "task_id": rec.task_id,
        "owner_uid": rec.owner_uid,
        "title": rec.title,
        "source_platform": rec.source_platform,
        "status": rec.status,
        "created_at": _iso_utc(rec.created_at),
        "cost_summary": cost_summary,
        # V1.1.0 持久化统计字段（runtime 卡 DB 数据源；NULL 时路由层回落内存）
        "persisted": {
            "actual_chars": rec.actual_chars,
            "actual_seg_tokens": rec.actual_seg_tokens,
            "subtitle_source": rec.subtitle_source,
            "md_status": rec.md_status,
            "summary_status": rec.summary_status,
        },
        "ledger": [
            {
                "feature": r.feature,
                "currency": r.currency,
                "amount": r.amount,
                "balance_after": r.balance_after,
                "from_gift": r.from_gift,
                "from_perm": r.from_perm,
                "note": r.note,
                "created_at": _iso_utc(r.created_at),
                # V1.1.0 发票列（账单明细用；老行为 None）
                "model": r.model,
                "prompt_tokens": r.prompt_tokens,
                "completion_tokens": r.completion_tokens,
                "cache_hit_tokens": r.cache_hit_tokens,
                "cache_miss_tokens": r.cache_miss_tokens,
                "cost_yuan": r.cost_yuan,
                "price_input": r.price_input,
                "price_output": r.price_output,
                "price_cache_hit": r.price_cache_hit,
                "price_per_hour": r.price_per_hour,
            }
            for r in ledger_rows
        ],
    }


async def get_health(running_tasks: int = 0) -> dict:
    """系统健康：运行任务数、DB 大小、磁盘剩余、进程 uptime"""
    db_path = DATA_DIR / "stellaris.db"
    db_size_mb = round(db_path.stat().st_size / (1024 * 1024), 1) if db_path.exists() else 0
    disk = shutil.disk_usage(DATA_DIR)
    disk_free_pct = round(disk.free / disk.total * 100, 1)
    return {
        "running_tasks": running_tasks,
        "db_size_mb": db_size_mb,
        "disk_free_pct": disk_free_pct,
        "uptime_sec": int(time.time() - _START_TIME),
    }


async def get_anon_usage_today() -> dict:
    """匿名使用今日概况：IP 数、总消耗分钟、额度上限"""
    from billing_store import BILLING_TIERS
    day_key, _, _ = _period_keys()
    limit = BILLING_TIERS["anonymous"]["minutes_day"]
    async with async_session() as session:
        rows = (await session.execute(
            select(func.count(AnonUsage.ip), func.coalesce(func.sum(AnonUsage.minutes_day), 0))
            .where(AnonUsage.day_key == day_key)
        )).one()
    return {
        "ips": rows[0] or 0,
        "minutes": rows[1] or 0,
        "limit": limit,
    }


# ===== 分模型成本统计（V1.1.0：结算时写入的真实成本，发票原则）=====

async def cost_stats(days: int | None) -> dict:
    """成本 Tab 数据源：总览卡 + 分模型明细 + 按天×模型趋势。
    口径：cost_yuan 非 NULL 的流水（V1.1.0 起的新时代数据；老流水不在此统计）。"""
    since = None
    if days:
        # naive UTC（与 created_at 存储形式一致；aware 直接比会报错）
        since = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=days)
    async with async_session() as session:
        stmt = select(
            BillingLedger.model, BillingLedger.currency, BillingLedger.feature,
            BillingLedger.prompt_tokens, BillingLedger.completion_tokens,
            BillingLedger.cache_hit_tokens, BillingLedger.cache_miss_tokens,
            BillingLedger.cost_yuan, BillingLedger.amount, BillingLedger.created_at,
        ).where(BillingLedger.cost_yuan.isnot(None))
        if since:
            stmt = stmt.where(BillingLedger.created_at >= since)
        rows = (await session.execute(stmt)).all()

    per_model: dict[str, dict] = {}
    trend: dict[str, dict[str, float]] = {}
    tot = {"cost": 0.0, "prompt": 0, "completion": 0, "hit": 0, "miss": 0}
    for (model, currency, feature, pt, ct, hit, miss, cost_yuan, amount, created_at) in rows:
        name = model or "unknown"
        m = per_model.setdefault(name, {
            "model": name, "prompt": 0, "completion": 0, "cache_hit": 0,
            "cache_miss": 0, "minutes": 0, "cost": 0.0,
        })
        m["prompt"] += pt or 0
        m["completion"] += ct or 0
        m["cache_hit"] += hit or 0
        m["cache_miss"] += miss or 0
        if currency == "minute":
            m["minutes"] += abs(amount or 0)
        m["cost"] += cost_yuan or 0
        tot["prompt"] += pt or 0
        tot["completion"] += ct or 0
        tot["hit"] += hit or 0
        tot["miss"] += miss or 0
        tot["cost"] += cost_yuan or 0
        # 趋势：按天 × 模型
        day = created_at.strftime("%m-%d") if created_at else "?"
        trend.setdefault(day, {})[name] = round(
            trend.setdefault(day, {}).get(name, 0) + (cost_yuan or 0), 6)

    for m in per_model.values():
        denom = m["cache_hit"] + m["cache_miss"]
        m["hit_rate"] = round(m["cache_hit"] / denom * 100, 1) if denom else None
        m["cost"] = round(m["cost"], 4)
    overall_rate = round(tot["hit"] / (tot["hit"] + tot["miss"]) * 100, 1) \
        if (tot["hit"] + tot["miss"]) else None

    # 历史估算（V1.1.0 前老行，cost_yuan IS NULL；与 Overview 老行同费率口径，两界面对账一致）
    async with async_session() as session:
        legacy = {"minutes": 0, "quantum": 0, "gravity": 0}
        for cur in ("minute", "quantum", "gravity"):
            stmt = select(func.coalesce(func.sum(-BillingLedger.amount), 0)).where(
                BillingLedger.currency == cur, BillingLedger.amount < 0,
                BillingLedger.cost_yuan.is_(None))
            if since:
                stmt = stmt.where(BillingLedger.created_at >= since)
            legacy[{"minute": "minutes"}.get(cur, cur)] = (await session.execute(stmt)).scalar_one()
        legacy["cost"] = round(
            legacy["minutes"] * COST_PER_MINUTE + legacy["quantum"] * COST_PER_QUANTUM
            + legacy["gravity"] * COST_PER_GRAVITY, 2)

    return {
        "cards": {
            "total_cost": round(tot["cost"], 4),
            "prompt_tokens": tot["prompt"],
            "completion_tokens": tot["completion"],
            "overall_hit_rate": overall_rate,
        },
        "per_model": sorted(per_model.values(), key=lambda x: -x["cost"]),
        "trend": [{"date": d, **v} for d, v in sorted(trend.items())],
        "legacy": legacy,
    }
