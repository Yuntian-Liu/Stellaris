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

from sqlalchemy import DateTime, Integer, String, case, func, select, update
from sqlalchemy.orm import Mapped, mapped_column

from database import Base, async_session


def _utcnow() -> datetime:
    """naive UTC（与 DateTime 列的 func.now() 存储形式一致；utcnow() 已弃用）"""
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _iso_utc(dt: datetime | None) -> str | None:
    """DateTime 列存的是 naive UTC，序列化必须补 'Z'——否则前端 new Date() 会当本地时间
    解析，显示永远差 8 小时（碳碳实测踩坑：刚完成的记录显示"8 小时前"）"""
    if not dt:
        return None
    s = dt.isoformat()
    return s if dt.tzinfo else s + "Z"

logger = logging.getLogger(__name__)

# ===== 配置表（按会员等级；MEMBERSHIP.md 定稿）=====
# minutes_*：None = 该周期不限；quantum = 周分钟 ×3.2 专款 ×1.3 余量；history_hours：None = 永久
BILLING_TIERS = {
    "anonymous": {
        "minutes_day": 10,
        "history_hours": 1,
        "premium": False,            # 不可用 LLM 增值功能（分段/概要/MD/解读）
    },
    "free": {
        "minutes_day": 30,
        "minutes_week": 120,
        "minutes_month": 300,
        "quantum_weekly_gift": 500,  # 量子波赠送钱包每周重发量
        "gravity_signup_gift": 30,   # 注册赠送引力波
        "exchange_cap": 5,
        "history_hours": 1,
        "premium": True,
    },
    # ── 付费档（30 天滚动周期，开通时刻起算）──
    "stargazer": {  # 观星者 ¥8/月
        "minutes_day": 40, "minutes_week": 160, "minutes_month": 480,
        "quantum_weekly_gift": 650, "gravity_monthly_gift": 50,
        "exchange_cap": 10, "history_hours": 24, "premium": True,
    },
    "voyager": {    # 远航者 ¥18/月（主推；另有 ¥5 试用 7 天=0.25 周期）
        "minutes_day": 100, "minutes_week": 400, "minutes_month": 1200,
        "quantum_weekly_gift": 1700, "gravity_monthly_gift": 150,
        "exchange_cap": 20, "history_hours": 168, "premium": True,
    },
    "odyssey": {    # 奥德赛 ¥68/月（价格锚）
        "minutes_day": 300, "minutes_week": 1200, "minutes_month": 3600,
        "quantum_weekly_gift": 5000, "gravity_monthly_gift": 500,
        "exchange_cap": 50, "history_hours": 720, "premium": True,
    },
    # ── 邀请制（Stella · 启明）：日/周不限，月线 6000 保险丝；历史永久 ──
    "stella": {
        "minutes_day": None, "minutes_week": None, "minutes_month": 6000,
        "quantum_weekly_gift": 9999, "gravity_monthly_gift": 500,
        "exchange_unlimited": True, "history_hours": None, "premium": True,
    },
    # 开发者档：分钟/兑换不限（检查跳过、前端显 ∞），货币照扣照记账（留成本样本），
    # 每周补发大数保证永不触底。靠 users.is_admin 解析，不写 membership_tier
    "admin": {
        "unlimited": True,
        "quantum_weekly_gift": 99999,
        "gravity_weekly_topup": 999,  # 引力波每周补到此值（超出不扣回）
        "exchange_unlimited": True,
        "history_hours": None,
        "premium": True,
    },
}

# 档位展示名（英文主名 / 中文副标），summary 路由下发前端
TIER_DISPLAY = {
    "free": ("免费版", ""),
    "stargazer": ("Stargazer", "观星者"),
    "voyager": ("Voyager", "远航者"),
    "odyssey": ("Odyssey", "奥德赛"),
    "stella": ("Stella", "启明"),
    "admin": ("开发者", ""),
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
    # 会员周期（30 天滚动，开通时刻起算；9999-12-31 = 永久档位如 Stella）
    membership_expire_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    gravity_grant_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class BillingLedger(Base):
    """计费流水（带符号：正=获得，负=消耗）"""
    __tablename__ = "billing_ledger"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_uid: Mapped[int] = mapped_column(Integer, index=True)
    feature: Mapped[str] = mapped_column(String(32))      # extract/segment/summary/md/chat/exchange/signup_gift/membership_gift
    currency: Mapped[str] = mapped_column(String(16))     # minute | quantum | gravity
    amount: Mapped[int] = mapped_column(Integer)          # 带符号
    balance_after: Mapped[int] = mapped_column(Integer, default=0)
    # 量子波双钱包拆分（仅 quantum 流水使用；扣费为负、入账为正）
    from_gift: Mapped[int | None] = mapped_column(Integer, nullable=True)
    from_perm: Mapped[int | None] = mapped_column(Integer, nullable=True)
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


async def _effective_tier_key(session, row: UserBilling) -> str:
    """有效档位：users.is_admin=True 一律 admin；付费档到期懒降级为 free"""
    if row.membership_tier == "admin":
        return "admin"
    from auth.models import User
    result = await session.execute(select(User).where(User.uid == row.user_uid))
    user = result.scalar_one_or_none()
    if user and user.is_admin:
        return "admin"
    tier = row.membership_tier
    if tier not in ("free", "admin"):
        # 到期判定：无到期时间（从未开通）或已过期的付费档 → 按 free 计
        if not row.membership_expire_at or row.membership_expire_at <= _utcnow():
            return "free"
    return tier


async def _apply_member_gravity(session, row: UserBilling, tier_key: str) -> None:
    """会员引力波月赠（懒发放）：跟随 30 天会员周期，开通即赠首期（grant_membership 里），
    之后每满 30 天且会员仍有效自动赠下一期；永久钱包累加。"""
    gift = BILLING_TIERS.get(tier_key, {}).get("gravity_monthly_gift")
    if not gift or not row.gravity_grant_at or not row.membership_expire_at:
        return
    now = _utcnow()
    if row.membership_expire_at <= now:
        return  # 已到期不赠
    grant_at = row.gravity_grant_at
    while grant_at + timedelta(days=30) <= now:
        grant_at += timedelta(days=30)
        if grant_at > row.membership_expire_at:
            break  # 下一期落在会员有效期外，不赠
        row.gravity += gift
        await _record(session, row.user_uid, "membership_gift", "gravity", gift, row.gravity)
    row.gravity_grant_at = grant_at


def _apply_resets(row: UserBilling, tier_key: str) -> list[str]:
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
        tier = BILLING_TIERS.get(tier_key, BILLING_TIERS["free"])
        row.quantum_gift = tier.get("quantum_weekly_gift", 0)  # 赠送钱包每周重发（覆盖，不叠加）
        topup = tier.get("gravity_weekly_topup")
        if topup:
            row.gravity = max(row.gravity, topup)  # 开发者档：引力波每周补到 topup
        notes.append("week")
    if row.month_key != month_key:
        row.minutes_month = 0
        row.month_key = month_key
        row.exchange_month_count = 0
        row.exchange_month_key = month_key
        notes.append("month")
    return notes


async def get_billing(uid: int) -> tuple[UserBilling, str]:
    """取账户（含懒重置 + 懒月赠 + 建账户）。返回 (账户, 有效档位 key)"""
    async with async_session() as session:
        row = await _get_or_create(session, uid)
        tier_key = await _effective_tier_key(session, row)
        _apply_resets(row, tier_key)
        await _apply_member_gravity(session, row, tier_key)
        await session.commit()
        await session.refresh(row)
        # detach 后返回（调用方只读字段）
        session.expunge(row)
        return row, tier_key


async def grant_membership(uid: int, tier_key: str, days: int | None) -> dict:
    """开通/续期会员（webhook / 兑换码共用）：同档顺延累加，不同档覆盖；
    立即发放首期引力波。days=None 表示永久档（Stella，到期置 9999-12-31）。"""
    if tier_key not in BILLING_TIERS or tier_key in ("anonymous", "free", "admin"):
        raise InsufficientError(f"非法的会员档位：{tier_key}")
    async with async_session() as session:
        row = await _get_or_create(session, uid)
        now = _utcnow()
        if (row.membership_tier == tier_key and row.membership_expire_at
                and row.membership_expire_at > now):
            base = row.membership_expire_at   # 同档续期：剩余时间顺延
        else:
            base = now
        row.membership_tier = tier_key
        row.membership_expire_at = (datetime(9999, 12, 31) if days is None
                                    else base + timedelta(days=days))
        row.gravity_grant_at = now
        gift = BILLING_TIERS[tier_key].get("gravity_monthly_gift", 0)
        if gift:
            row.gravity += gift
            await _record(session, uid, "membership_gift", "gravity", gift, row.gravity)
        await session.commit()
        return {"tier": tier_key, "expire_at": _iso_utc(row.membership_expire_at)}


async def _record(session, uid: int, feature: str, currency: str,
                  amount: int, balance_after: int, task_id: str | None = None,
                  from_gift: int | None = None, from_perm: int | None = None):
    session.add(BillingLedger(
        user_uid=uid, feature=feature, currency=currency,
        amount=amount, balance_after=balance_after, task_id=task_id,
        from_gift=from_gift, from_perm=from_perm,
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
        _apply_resets(row, await _effective_tier_key(session, row))
        row.minutes_day += minutes
        row.minutes_week += minutes
        row.minutes_month += minutes
        await _record(session, uid, "extract", "minute", -minutes, row.minutes_day, task_id)
        await session.commit()


async def consume_quantum(uid: int, tokens: int, feature: str, task_id: str | None = None) -> int:
    """成功后按 tokens 扣量子波（四成取整；先扣赠送钱包再扣活动钱包；不倒欠）。
    返回实际扣的量子波数。
    R2：原子条件 UPDATE（CASE 同时扣双钱包，先 gift 后 perm，引用旧值），总额不足则扣光，
    杜绝并发超扣。双钱包 from_gift/from_perm 记账在极端并发下可能近似（Kimi 接受），总额精确。"""
    cost = round_tokens(tokens, QUANTUM_PER_TOKEN_UNIT)
    if cost <= 0:
        return 0
    async with async_session() as session:
        row = await _get_or_create(session, uid)
        _apply_resets(row, await _effective_tier_key(session, row))
        await session.commit()
    async with async_session() as session:
        old_row = await session.get(UserBilling, uid)
        old_gift = old_row.quantum_gift if old_row else 0
        old_perm = old_row.quantum_perm if old_row else 0
        # 第一段：总额 >= cost → CASE 同时扣双钱包（先 gift 后 perm）
        r = await session.execute(
            update(UserBilling).where(
                UserBilling.user_uid == uid,
                UserBilling.quantum_gift + UserBilling.quantum_perm >= cost,
            ).values(
                quantum_gift=case(
                    (UserBilling.quantum_gift >= cost, UserBilling.quantum_gift - cost),
                    else_=0,
                ),
                quantum_perm=case(
                    (UserBilling.quantum_gift >= cost, UserBilling.quantum_perm),
                    else_=UserBilling.quantum_perm - (cost - UserBilling.quantum_gift),
                ),
            )
        )
        if r.rowcount == 1:
            await session.refresh(old_row)
            fg = old_gift - old_row.quantum_gift
            fp = old_perm - old_row.quantum_perm
            await _record(session, uid, feature, "quantum", -cost,
                          old_row.quantum_gift + old_row.quantum_perm, task_id,
                          from_gift=-fg, from_perm=-fp)
            await session.commit()
            return cost
        # 第二段：0 < 总额 < cost → 扣光（不倒债）
        # 用 Core select 取当前裸值（CASE UPDATE 会 expire ORM 对象，同步属性访问会触发
        # lazy load 报 MissingGreenlet；且拿到第一段后的最新值，避免虚报扣费量）
        cur_row = (await session.execute(
            select(UserBilling.quantum_gift, UserBilling.quantum_perm)
            .where(UserBilling.user_uid == uid)
        )).first()
        cur_gift = cur_row[0] if cur_row else 0
        cur_perm = cur_row[1] if cur_row else 0
        r2 = await session.execute(
            update(UserBilling).where(
                UserBilling.user_uid == uid,
                UserBilling.quantum_gift + UserBilling.quantum_perm > 0,
                UserBilling.quantum_gift + UserBilling.quantum_perm < cost,
            ).values(quantum_gift=0, quantum_perm=0)
        )
        if r2.rowcount == 1:
            total_old = cur_gift + cur_perm
            logger.warning("[Billing] 量子波竞态不足: uid=%s 需 %d 有 %d,扣到 0", uid, cost, total_old)
            await _record(session, uid, feature, "quantum", -total_old, 0, task_id,
                          from_gift=-cur_gift, from_perm=-cur_perm)
            await session.commit()
            return total_old
        await session.commit()
        return 0


async def consume_gravity(uid: int, tokens: int, feature: str, task_id: str | None = None) -> int:
    """成功后按 tokens 扣引力波（四成取整；不倒欠）。返回实际扣的引力波数。
    R2：两段式原子条件 UPDATE——余额够扣全款，不足扣光，gravity 永不跨 0，杜绝并发超扣。"""
    cost = round_tokens(tokens, GRAVITY_PER_TOKEN_UNIT)
    if cost <= 0:
        return 0
    async with async_session() as session:
        row = await _get_or_create(session, uid)
        _apply_resets(row, await _effective_tier_key(session, row))
        await session.commit()
    async with async_session() as session:
        # 第一段：余额 >= cost → 扣全款
        r = await session.execute(
            update(UserBilling)
            .where(UserBilling.user_uid == uid, UserBilling.gravity >= cost)
            .values(gravity=UserBilling.gravity - cost)
        )
        if r.rowcount == 1:
            new_bal = (await session.get(UserBilling, uid)).gravity
            await _record(session, uid, feature, "gravity", -cost, new_bal, task_id)
            await session.commit()
            return cost
        # 第二段：0 < 余额 < cost → 扣光（不倒债）
        old_row = await session.get(UserBilling, uid)
        old = old_row.gravity if old_row else 0
        r2 = await session.execute(
            update(UserBilling)
            .where(UserBilling.user_uid == uid,
                   UserBilling.gravity > 0, UserBilling.gravity < cost)
            .values(gravity=0)
        )
        if r2.rowcount == 1:
            logger.warning("[Billing] 引力波竞态不足: uid=%s 需 %d 有 %d,扣到 0", uid, cost, old)
            await _record(session, uid, feature, "gravity", -old, 0, task_id)
            await session.commit()
            return old
        await session.commit()
        return 0


# ===== 发起前检查（不扣费，只校验）=====

async def check_minutes(uid: int, est_minutes: int) -> None:
    """分钟余量检查（×1.2 安全系数由调用方传入），不足抛 InsufficientError。
    tier 的 minutes_* 为 None 表示该周期不限（如 Stella 日/周）。"""
    row, tier_key = await get_billing(uid)
    tier = BILLING_TIERS.get(tier_key, BILLING_TIERS["free"])
    if tier.get("unlimited"):
        return
    periods = [("日", row.minutes_day, tier.get("minutes_day")),
               ("周", row.minutes_week, tier.get("minutes_week")),
               ("月", row.minutes_month, tier.get("minutes_month"))]
    for label, used, limit in periods:
        if limit is not None and used + est_minutes > limit:
            left = {l: (None if lim is None else lim - u) for l, u, lim in periods}
            raise InsufficientError(
                f"分钟额度不足：本次约需 {est_minutes} 分钟，"
                f"今日剩余 {left['日'] if left['日'] is not None else '∞'} / "
                f"本周剩余 {left['周'] if left['周'] is not None else '∞'} / "
                f"本月剩余 {left['月'] if left['月'] is not None else '∞'} 分钟"
            )


async def check_quantum(uid: int, est_tokens: int) -> None:
    """量子波余量检查（分段/概要发起前），不足抛 InsufficientError"""
    row, tier_key = await get_billing(uid)
    if BILLING_TIERS.get(tier_key, {}).get("unlimited"):
        return
    total = row.quantum_gift + row.quantum_perm
    need = round_tokens(est_tokens, QUANTUM_PER_TOKEN_UNIT)
    if need > total:
        raise InsufficientError(
            f"量子波不足：本次约需 {need}，当前剩余 {total}（每周一 04:00 重发赠送额度）"
        )


async def check_gravity(uid: int, est_tokens: int) -> None:
    """引力波余量检查（MD/解读发起前），不足抛 InsufficientError"""
    row, tier_key = await get_billing(uid)
    if BILLING_TIERS.get(tier_key, {}).get("unlimited"):
        return
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


async def refund_anon_minutes(ip: str, minutes: int) -> None:
    """R3：匿名管线失败时退还预占的当日分钟（与 check_and_consume_anon 预占对冲，不低于 0）。
    仅 _run_pipeline_sync 失败分支调用；upload 管线无预占故不退（见 fix_prompt 出入 1）。"""
    if minutes <= 0 or not ip:
        return
    async with async_session() as session:
        await session.execute(
            update(AnonUsage)
            .where(AnonUsage.ip == ip)
            .values(minutes_day=case(
                (AnonUsage.minutes_day > minutes, AnonUsage.minutes_day - minutes),
                else_=0,
            ))
        )
        await session.commit()


# ===== 双向兑换 =====

async def exchange(direction: str, count: int, uid: int) -> dict:
    """
    direction: 'q2g' 量子波→引力波（25:1，月限 5）| 'g2q' 引力波→量子波（1:20，不限次）
    返回 {gravity, quantum_gift, quantum_perm, exchange_month_count}
    R2：原子条件 UPDATE——校验与扣加合并到单条 UPDATE，rowcount 判成败，杜绝并发双兑。
    """
    if count <= 0:
        raise InsufficientError("兑换数量必须大于 0")
    # 懒重置（独立事务，避免与下面的原子 UPDATE 同事务读旧值）
    async with async_session() as session:
        row = await _get_or_create(session, uid)
        tier_key = await _effective_tier_key(session, row)
        _apply_resets(row, tier_key)
        await session.commit()

    async with async_session() as session:
        row = await session.get(UserBilling, uid)
        if row is None:
            raise InsufficientError("账户不存在")
        tier_key = await _effective_tier_key(session, row)
        tier = BILLING_TIERS.get(tier_key, BILLING_TIERS["free"])
        unlimited = bool(tier.get("exchange_unlimited"))
        cap = tier.get("exchange_cap", EXCHANGE_Q2G_MONTHLY_CAP)

        if direction == "q2g":
            cost = count * EXCHANGE_Q2G_RATE
            old_gift = row.quantum_gift   # 记账拆分用（UPDATE 前）
            cap_cond = [] if unlimited else [UserBilling.exchange_month_count + count <= cap]
            # 原子：总额够 + 月限够 → CASE 扣双钱包 + 加引力 + 加月限计数
            r = await session.execute(
                update(UserBilling).where(
                    UserBilling.user_uid == uid,
                    UserBilling.quantum_gift + UserBilling.quantum_perm >= cost,
                    *cap_cond,
                ).values(
                    quantum_gift=case(
                        (UserBilling.quantum_gift >= cost, UserBilling.quantum_gift - cost),
                        else_=0,
                    ),
                    quantum_perm=case(
                        (UserBilling.quantum_gift >= cost, UserBilling.quantum_perm),
                        else_=UserBilling.quantum_perm - (cost - UserBilling.quantum_gift),
                    ),
                    gravity=UserBilling.gravity + count,
                    exchange_month_count=UserBilling.exchange_month_count + count,
                )
            )
            if r.rowcount == 0:
                # 区分余额不足 / 月限不足，给准确提示
                cur = await session.get(UserBilling, uid)
                if not unlimited and cur.exchange_month_count + count > cap:
                    raise InsufficientError(
                        f"本月兑换次数不足：每月限兑 {cap} 次，剩余 {cap - cur.exchange_month_count} 次")
                raise InsufficientError(
                    f"量子波不足：需 {cost}，当前剩余 {cur.quantum_gift + cur.quantum_perm}")
            await session.refresh(row)
            fg = min(cost, old_gift)
            fp = cost - fg
            await _record(session, uid, "exchange", "quantum", -cost,
                          row.quantum_gift + row.quantum_perm,
                          from_gift=-fg, from_perm=-fp)
            await _record(session, uid, "exchange", "gravity", count, row.gravity)
            await session.commit()
        elif direction == "g2q":
            gain = count * EXCHANGE_G2Q_RATE
            r = await session.execute(
                update(UserBilling).where(
                    UserBilling.user_uid == uid,
                    UserBilling.gravity >= count,
                ).values(
                    gravity=UserBilling.gravity - count,
                    quantum_perm=UserBilling.quantum_perm + gain,
                )
            )
            if r.rowcount == 0:
                cur = await session.get(UserBilling, uid)
                raise InsufficientError(f"引力波不足：需 {count}，当前剩余 {cur.gravity}")
            await session.refresh(row)
            await _record(session, uid, "exchange", "gravity", -count, row.gravity)
            await _record(session, uid, "exchange", "quantum", gain,
                          row.quantum_gift + row.quantum_perm,
                          from_gift=0, from_perm=gain)
            await session.commit()
        else:
            raise InsufficientError("未知的兑换方向")
        return {
            "gravity": row.gravity,
            "quantum_gift": row.quantum_gift,
            "quantum_perm": row.quantum_perm,
            "exchange_month_count": row.exchange_month_count,
        }


# ===== 历史保留 / 消耗记录查询 =====

async def retention_hours_map(uids: list[int]) -> dict[int, float | None]:
    """批量取用户有效档位的历史保留时长（小时；None=永久保留）。定时清理用。"""
    if not uids:
        return {}
    async with async_session() as session:
        result = await session.execute(
            select(UserBilling).where(UserBilling.user_uid.in_(uids))
        )
        rows = {r.user_uid: r for r in result.scalars()}
        out = {}
        for uid in uids:
            row = rows.get(uid)
            if row is None:
                out[uid] = BILLING_TIERS["free"]["history_hours"]
                continue
            tier_key = await _effective_tier_key(session, row)
            out[uid] = BILLING_TIERS.get(tier_key, BILLING_TIERS["free"]).get("history_hours", 1)
        return out


async def get_ledger(uid: int, page: int, size: int, currency: str | None = None) -> dict:
    """消耗记录分页（时间倒序；currency 可筛选 minute/quantum/gravity）。
    返回 {items, total, page, size}"""
    async with async_session() as session:
        base = select(BillingLedger).where(BillingLedger.user_uid == uid)
        if currency:
            base = base.where(BillingLedger.currency == currency)
        total = (await session.execute(
            select(func.count()).select_from(base.subquery())
        )).scalar_one()
        result = await session.execute(
            base.order_by(BillingLedger.created_at.desc(), BillingLedger.id.desc())
            .offset((page - 1) * size).limit(size)
        )
        items = [
            {
                "id": r.id,
                "feature": r.feature,
                "currency": r.currency,
                "amount": r.amount,
                "balance_after": r.balance_after,
                "from_gift": r.from_gift,
                "from_perm": r.from_perm,
                "task_id": r.task_id,
                "created_at": _iso_utc(r.created_at),
            }
            for r in result.scalars()
        ]
        return {"items": items, "total": total, "page": page, "size": size}
