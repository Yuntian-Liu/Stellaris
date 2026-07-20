"""
计费核心 — 三层货币（分钟限额 / 量子波双钱包 / 引力波）

模型（BILLING.md 定案）：
- 分钟：自然周期限额（UTC+8 凌晨 04:00 为界），日/周/月
- 量子波：1 = 100 tokens；赠送钱包（每周一 04:00 重发并清零）+ 活动钱包（永久）
- 引力波：1 = 500 tokens；永不过期
- 取整：四成让利（零头 ≤40% 舍去，>40% 进位）
- 扣费：一律成功后结算，失败零扣费；竞态时扣到 0 为止不倒欠
"""
import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy import DateTime, Integer, String, func, select
from sqlalchemy.orm import Mapped, mapped_column

from database import Base, async_session

logger = logging.getLogger(__name__)

# ===== 配置表（按会员等级；现仅 anonymous/free，会员扩展时加行即可）=====
BILLING_TIERS = {
    "anonymous": {
        "minutes_day": 10,
        "premium": False,            # 不可用 LLM 增值功能（分段/概要/MD/解读）
    },
    "free": {
        "minutes_day": 30,
        "minutes_week": 120,
        "minutes_month": 300,
        "quantum_weekly_gift": 500,  # 量子波赠送钱包每周重发量
        "gravity_signup_gift": 30,   # 注册赠送引力波
        "premium": True,
    },
}

# 汇率
QUANTUM_PER_TOKEN_UNIT = 100      # 1 量子波 = 100 tokens
GRAVITY_PER_TOKEN_UNIT = 500      # 1 引力波 = 500 tokens
EXCHANGE_Q2G_RATE = 25            # 25 量子波 → 1 引力波
EXCHANGE_Q2G_MONTHLY_CAP = 5      # 每月限兑 5 次
EXCHANGE_G2Q_RATE = 20            # 1 引力波 → 20 量子波（入活动钱包，不限次）

# 语义分段预估系数（与 estimate 路由同模型：240 字/分钟 ÷ 1.5 字/token × 2 往返）
SEG_TOKENS_PER_MIN = 320


# ===== ORM 模型 =====

class UserBilling(Base):
    """用户计费账户（独立新表，不动 users 表）"""
    __tablename__ = "user_billing"

    user_uid: Mapped[int] = mapped_column(Integer, primary_key=True)
    membership_tier: Mapped[str] = mapped_column(String(16), default="free")
    # 分钟计数（按周期重置，period key 记录所属周期）
    minutes_day: Mapped[int] = mapped_column(Integer, default=0)
    minutes_week: Mapped[int] = mapped_column(Integer, default=0)
    minutes_month: Mapped[int] = mapped_column(Integer, default=0)
    day_key: Mapped[str] = mapped_column(String(10), default="")
    week_key: Mapped[str] = mapped_column(String(10), default="")
    month_key: Mapped[str] = mapped_column(String(7), default="")
    # 量子波双钱包
    quantum_gift: Mapped[int] = mapped_column(Integer, default=0)   # 赠送钱包（周日清零）
    quantum_perm: Mapped[int] = mapped_column(Integer, default=0)   # 活动钱包（永久）
    # 引力波
    gravity: Mapped[int] = mapped_column(Integer, default=0)
    # 兑换计数（量子波→引力波，每月限次）
    exchange_month_count: Mapped[int] = mapped_column(Integer, default=0)
    exchange_month_key: Mapped[str] = mapped_column(String(7), default="")


class BillingLedger(Base):
    """计费流水（带符号：正=获得，负=消耗）"""
    __tablename__ = "billing_ledger"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_uid: Mapped[int] = mapped_column(Integer, index=True)
    feature: Mapped[str] = mapped_column(String(32))      # extract/segment/summary/md/chat/exchange/signup_gift
    currency: Mapped[str] = mapped_column(String(16))     # minute | quantum | gravity
    amount: Mapped[int] = mapped_column(Integer)          # 带符号
    balance_after: Mapped[int] = mapped_column(Integer, default=0)
    task_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class AnonUsage(Base):
    """匿名用户分钟限额（按 IP）"""
    __tablename__ = "anon_usage"

    ip: Mapped[str] = mapped_column(String(45), primary_key=True)
    minutes_day: Mapped[int] = mapped_column(Integer, default=0)
    day_key: Mapped[str] = mapped_column(String(10), default="")


# ===== 周期 key（UTC+8 凌晨 04:00 为界：先减 4 小时再取自然周期）=====

_TZ_CN = timezone(timedelta(hours=8))


def _period_keys() -> tuple[str, str, str]:
    """返回 (day_key, week_key, month_key)，如 ('2026-07-20', '2026-W30', '2026-07')"""
    shifted = datetime.now(_TZ_CN) - timedelta(hours=4)
    day_key = shifted.strftime("%Y-%m-%d")
    iso = shifted.isocalendar()
    week_key = f"{iso.year}-W{iso.week:02d}"
    month_key = shifted.strftime("%Y-%m")
    return day_key, week_key, month_key


def round_tokens(tokens: int, unit: int) -> int:
    """四成让利取整：零头 ≤40% 舍去，>40% 进位（unit=100/500）"""
    if tokens <= 0:
        return 0
    base, rem = divmod(tokens, unit)
    return base + (1 if rem > unit * 0.4 else 0)


# ===== 账户读写 =====

async def _get_or_create(session, uid: int) -> UserBilling:
    row = await session.get(UserBilling, uid)
    if row is None:
        row = UserBilling(user_uid=uid)
        session.add(row)
        await session.flush()
        # 懒发放注册礼：新老用户首次拥有计费账户时统一赠送引力波
        # （老用户注册早于计费功能，靠这里补发；新用户注册后首次触达自动发放）
        gift = BILLING_TIERS["free"]["gravity_signup_gift"]
        row.gravity = gift
        await _record(session, uid, "signup_gift", "gravity", gift, row.gravity)
    return row


def _apply_resets(row: UserBilling) -> list[str]:
    """懒重置：period key 过期则清零对应计数、重发赠送钱包。返回重置说明（日志用）"""
    day_key, week_key, month_key = _period_keys()
    notes = []
    if row.day_key != day_key:
        row.minutes_day = 0
        row.day_key = day_key
        notes.append("day")
    if row.week_key != week_key:
        row.minutes_week = 0
        row.week_key = week_key
        gift = BILLING_TIERS.get(row.membership_tier, BILLING_TIERS["free"])["quantum_weekly_gift"]
        row.quantum_gift = gift        # 赠送钱包每周重发（覆盖，不叠加）
        notes.append("week")
    if row.month_key != month_key:
        row.minutes_month = 0
        row.month_key = month_key
        row.exchange_month_count = 0
        row.exchange_month_key = month_key
        notes.append("month")
    return notes


async def get_billing(uid: int) -> UserBilling:
    """取账户（含懒重置 + 建账户）"""
    async with async_session() as session:
        row = await _get_or_create(session, uid)
        _apply_resets(row)
        await session.commit()
        await session.refresh(row)
        # detach 后返回（调用方只读字段）
        session.expunge(row)
        return row


async def _record(session, uid: int, feature: str, currency: str,
                  amount: int, balance_after: int, task_id: str | None = None):
    session.add(BillingLedger(
        user_uid=uid, feature=feature, currency=currency,
        amount=amount, balance_after=balance_after, task_id=task_id,
    ))


class InsufficientError(Exception):
    """余额不足。detail 给前端展示"""
    def __init__(self, detail: str):
        self.detail = detail
        super().__init__(detail)


async def grant_signup_gravity(uid: int) -> None:
    """注册赠送引力波"""
    gift = BILLING_TIERS["free"]["gravity_signup_gift"]
    async with async_session() as session:
        row = await _get_or_create(session, uid)
        row.gravity += gift
        await _record(session, uid, "signup_gift", "gravity", gift, row.gravity)
        await session.commit()


async def consume_minutes(uid: int, minutes: int, task_id: str) -> None:
    """成功后扣分钟（三周期同时记）。失败任务不调用本函数。"""
    if minutes <= 0:
        return
    async with async_session() as session:
        row = await _get_or_create(session, uid)
        _apply_resets(row)
        row.minutes_day += minutes
        row.minutes_week += minutes
        row.minutes_month += minutes
        await _record(session, uid, "extract", "minute", -minutes, row.minutes_day, task_id)
        await session.commit()


async def consume_quantum(uid: int, tokens: int, feature: str, task_id: str | None = None) -> int:
    """成功后按 tokens 扣量子波（四成取整；先扣赠送钱包再扣活动钱包；不倒欠）。
    返回实际扣的量子波数。"""
    cost = round_tokens(tokens, QUANTUM_PER_TOKEN_UNIT)
    if cost <= 0:
        return 0
    async with async_session() as session:
        row = await _get_or_create(session, uid)
        _apply_resets(row)
        total = row.quantum_gift + row.quantum_perm
        if cost > total:
            logger.warning("[Billing] 量子波竞态不足: uid=%s 需 %d 有 %d,扣到 0", uid, cost, total)
            cost = total
        from_gift = min(cost, row.quantum_gift)
        row.quantum_gift -= from_gift
        row.quantum_perm -= (cost - from_gift)
        await _record(session, uid, feature, "quantum", -cost,
                      row.quantum_gift + row.quantum_perm, task_id)
        await session.commit()
        return cost


async def consume_gravity(uid: int, tokens: int, feature: str, task_id: str | None = None) -> int:
    """成功后按 tokens 扣引力波（四成取整；不倒欠）。返回实际扣的引力波数。"""
    cost = round_tokens(tokens, GRAVITY_PER_TOKEN_UNIT)
    if cost <= 0:
        return 0
    async with async_session() as session:
        row = await _get_or_create(session, uid)
        _apply_resets(row)
        if cost > row.gravity:
            logger.warning("[Billing] 引力波竞态不足: uid=%s 需 %d 有 %d,扣到 0", uid, cost, row.gravity)
            cost = row.gravity
        row.gravity -= cost
        await _record(session, uid, feature, "gravity", -cost, row.gravity, task_id)
        await session.commit()
        return cost


# ===== 发起前检查（不扣费，只校验）=====

async def check_minutes(uid: int, est_minutes: int) -> None:
    """分钟余量检查（×1.2 安全系数由调用方传入），不足抛 InsufficientError"""
    row = await get_billing(uid)
    tier = BILLING_TIERS.get(row.membership_tier, BILLING_TIERS["free"])
    if (row.minutes_day + est_minutes > tier["minutes_day"]
            or row.minutes_week + est_minutes > tier["minutes_week"]
            or row.minutes_month + est_minutes > tier["minutes_month"]):
        raise InsufficientError(
            f"分钟额度不足：本次约需 {est_minutes} 分钟，"
            f"今日剩余 {tier['minutes_day'] - row.minutes_day} / "
            f"本周剩余 {tier['minutes_week'] - row.minutes_week} / "
            f"本月剩余 {tier['minutes_month'] - row.minutes_month} 分钟"
        )


async def check_quantum(uid: int, est_tokens: int) -> None:
    """量子波余量检查（分段/概要发起前），不足抛 InsufficientError"""
    row = await get_billing(uid)
    total = row.quantum_gift + row.quantum_perm
    need = round_tokens(est_tokens, QUANTUM_PER_TOKEN_UNIT)
    if need > total:
        raise InsufficientError(
            f"量子波不足：本次约需 {need}，当前剩余 {total}（每周一 04:00 重发赠送额度）"
        )


async def check_gravity(uid: int, est_tokens: int) -> None:
    """引力波余量检查（MD/解读发起前），不足抛 InsufficientError"""
    row = await get_billing(uid)
    need = round_tokens(est_tokens, GRAVITY_PER_TOKEN_UNIT)
    if need > row.gravity:
        raise InsufficientError(
            f"引力波不足：本次约需 {need}，当前剩余 {row.gravity}（可用量子波兑换，25:1）"
        )


async def check_and_consume_anon(ip: str, est_minutes: int) -> None:
    """匿名用户：检查并预占当日分钟（完成后不再结算；失败任务由调用方传入 0 修正）"""
    tier = BILLING_TIERS["anonymous"]
    day_key, _, _ = _period_keys()
    async with async_session() as session:
        row = await session.get(AnonUsage, ip)
        if row is None:
            row = AnonUsage(ip=ip)
            session.add(row)
            await session.flush()
        if row.day_key != day_key:
            row.minutes_day = 0
            row.day_key = day_key
        if row.minutes_day + est_minutes > tier["minutes_day"]:
            raise InsufficientError(
                f"今日免费体验额度（{tier['minutes_day']} 分钟）已用完，注册解锁每日 30 分钟完整额度"
            )
        row.minutes_day += est_minutes
        await session.commit()


# ===== 双向兑换 =====

async def exchange(direction: str, count: int, uid: int) -> dict:
    """
    direction: 'q2g' 量子波→引力波（25:1，月限 5）| 'g2q' 引力波→量子波（1:20，不限次）
    返回 {gravity, quantum_gift, quantum_perm, exchange_month_count}
    """
    if count <= 0:
        raise InsufficientError("兑换数量必须大于 0")
    async with async_session() as session:
        row = await _get_or_create(session, uid)
        _apply_resets(row)
        if direction == "q2g":
            if row.exchange_month_count + count > EXCHANGE_Q2G_MONTHLY_CAP:
                raise InsufficientError(
                    f"本月兑换次数不足：每月限兑 {EXCHANGE_Q2G_MONTHLY_CAP} 次，"
                    f"剩余 {EXCHANGE_Q2G_MONTHLY_CAP - row.exchange_month_count} 次"
                )
            cost = count * EXCHANGE_Q2G_RATE
            total = row.quantum_gift + row.quantum_perm
            if cost > total:
                raise InsufficientError(f"量子波不足：需 {cost}，当前剩余 {total}")
            from_gift = min(cost, row.quantum_gift)
            row.quantum_gift -= from_gift
            row.quantum_perm -= (cost - from_gift)
            row.gravity += count
            row.exchange_month_count += count
            await _record(session, uid, "exchange", "quantum", -cost,
                          row.quantum_gift + row.quantum_perm)
            await _record(session, uid, "exchange", "gravity", count, row.gravity)
        elif direction == "g2q":
            if count > row.gravity:
                raise InsufficientError(f"引力波不足：需 {count}，当前剩余 {row.gravity}")
            gain = count * EXCHANGE_G2Q_RATE
            row.gravity -= count
            row.quantum_perm += gain       # 换得的量子波入活动钱包（永久）
            await _record(session, uid, "exchange", "gravity", -count, row.gravity)
            await _record(session, uid, "exchange", "quantum", gain,
                          row.quantum_gift + row.quantum_perm)
        else:
            raise InsufficientError("未知的兑换方向")
        await session.commit()
        return {
            "gravity": row.gravity,
            "quantum_gift": row.quantum_gift,
            "quantum_perm": row.quantum_perm,
            "exchange_month_count": row.exchange_month_count,
        }
