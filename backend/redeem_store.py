"""
兑换码 — redeem_codes 表 + 生成/核销

身兼三职：Stella 邀请码（自定义内容、一次性、永久）/ 爱发电兜底发码 / 活动送码
生成走 CLI 脚本 gen_code.py（管理看板可视化生成后续做）；核销走 /api/redeem。
生成码字符集避开 0/O、1/I/l（手写明信片场景防抄错）。
"""
import logging
import secrets
from datetime import datetime, timezone

from sqlalchemy import DateTime, Integer, String, func, update
from sqlalchemy.orm import Mapped, mapped_column

from database import Base, async_session

logger = logging.getLogger(__name__)

# 无歧义字符集（剔除 0/O、1/I/l）
_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"


class RedeemCode(Base):
    """兑换码（会员开通/邀请）"""
    __tablename__ = "redeem_codes"

    code: Mapped[str] = mapped_column(String(32), primary_key=True)
    tier: Mapped[str] = mapped_column(String(16))            # stargazer/voyager/odyssey/stella
    days: Mapped[int | None] = mapped_column(Integer, nullable=True)  # None=永久（Stella）
    max_uses: Mapped[int] = mapped_column(Integer, default=1)
    use_count: Mapped[int] = mapped_column(Integer, default=0)
    used_by: Mapped[int | None] = mapped_column(Integer, nullable=True)
    used_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    note: Mapped[str] = mapped_column(String(64), default="")  # 备注（如 "Stella 邀请"）
    # 兑换码发放模式（V0.9.3）：regular=按档位周期重置(存量兼容) / lump=一次性入永久钱包
    grant_mode: Mapped[str] = mapped_column(String(8), default="regular")
    quantum_grant: Mapped[int | None] = mapped_column(Integer, nullable=True)  # lump 模式发放的量子波
    gravity_grant: Mapped[int | None] = mapped_column(Integer, nullable=True)  # lump 模式发放的引力波
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


def _gen_code() -> str:
    """生成 XXXX-XXXX-XXXX 无歧义码"""
    raw = "".join(secrets.choice(_ALPHABET) for _ in range(12))
    return f"{raw[:4]}-{raw[4:8]}-{raw[8:]}"


async def create_code(tier: str, days: int | None, note: str = "",
                      custom_code: str | None = None, max_uses: int = 1,
                      expires_at: datetime | None = None,
                      grant_mode: str = "regular",
                      quantum_grant: int | None = None,
                      gravity_grant: int | None = None) -> str:
    """生成兑换码（CLI/管理看板用）。custom_code 传自定义内容（如 Stella 的有意义的词）。
    grant_mode: regular=按档位周期重置(默认,存量兼容) / lump=一次性入永久钱包(quantum_grant/gravity_grant 生效)"""
    code = (custom_code or _gen_code()).upper().strip()
    async with async_session() as session:
        if await session.get(RedeemCode, code):
            raise ValueError(f"兑换码已存在：{code}")
        session.add(RedeemCode(
            code=code, tier=tier, days=days, note=note,
            max_uses=max_uses, expires_at=expires_at,
            grant_mode=grant_mode, quantum_grant=quantum_grant, gravity_grant=gravity_grant,
        ))
        await session.commit()
    return code


async def get_redemptions_for_user(uid: int) -> list[dict]:
    """用户的兑换记录（开通记录展示用，时间倒序）"""
    from sqlalchemy import select
    async with async_session() as session:
        result = await session.execute(
            select(RedeemCode)
            .where(RedeemCode.used_by == uid)
            .order_by(RedeemCode.used_at.desc())
            .limit(50)
        )
        return [
            {
                "tier": r.tier,
                "days": r.days,
                "note": r.note,
                "used_at": r.used_at.isoformat() + "Z" if r.used_at else None,
            }
            for r in result.scalars()
        ]


class RedeemError(Exception):
    """兑换失败。detail 给前端展示"""
    def __init__(self, detail: str):
        self.detail = detail
        super().__init__(detail)


async def revoke_code(code: str) -> None:
    """作废兑换码（管理员操作）：仅未使用的码可作废；原子设 expires_at 为 now。已使用/已过期拒绝。"""
    code = code.upper().strip()
    async with async_session() as session:
        row = await session.get(RedeemCode, code)
        if not row:
            raise RedeemError("兑换码不存在")
        if row.use_count > 0:
            raise RedeemError("已核销的兑换码不可作废")
        if row.expires_at and row.expires_at <= datetime.now(timezone.utc).replace(tzinfo=None):
            raise RedeemError("兑换码已过期")
        row.expires_at = datetime.now(timezone.utc).replace(tzinfo=None)
        await session.commit()


async def preview_code(code: str) -> dict:
    """兑换前预览（不核销）：返回 {tier, days, note, grant_mode, quantum_grant, gravity_grant}"""
    async with async_session() as session:
        row = await session.get(RedeemCode, code.upper().strip())
        _check(row)
        return {
            "tier": row.tier, "days": row.days, "note": row.note,
            "grant_mode": row.grant_mode,
            "quantum_grant": row.quantum_grant,
            "gravity_grant": row.gravity_grant,
        }


def _check(row: RedeemCode | None) -> None:
    if not row:
        raise RedeemError("兑换码不存在，请检查是否输入正确")
    if row.expires_at and row.expires_at <= datetime.now(timezone.utc).replace(tzinfo=None):
        raise RedeemError("兑换码已过期")
    if row.use_count >= row.max_uses:
        raise RedeemError("兑换码已被使用")


async def redeem_code(code: str, uid: int) -> dict:
    """核销兑换码（R2/Y2：条件 UPDATE 原子抢占 → grant → 落 used_at；grant 异常回滚抢占）。
    grant_membership 内部自带独立 session，无法与本抢占同事务，故采用"抢占→grant→回滚"方案。"""
    from billing_store import grant_membership
    code = code.upper().strip()
    # ① 原子抢占：条件 UPDATE，rowcount=0 = _check 通过但被并发抢光
    async with async_session() as session:
        row = await session.get(RedeemCode, code)
        _check(row)   # 不存在/过期/已用尽 → RedeemError
        r = await session.execute(
            update(RedeemCode)
            .where(RedeemCode.code == code, RedeemCode.use_count < RedeemCode.max_uses)
            .values(use_count=RedeemCode.use_count + 1, used_by=uid)
        )
        if r.rowcount == 0:
            raise RedeemError("兑换码已被使用")
        tier, days = row.tier, row.days
        grant_mode = row.grant_mode
        quantum_grant = row.quantum_grant
        gravity_grant = row.gravity_grant
        await session.commit()
    # ② 开通（独立 session）；失败回滚抢占，码恢复可用
    try:
        if grant_mode == "lump":
            result = await grant_membership(
                uid, tier, days,
                lump_quantum=quantum_grant or 0, lump_gravity=gravity_grant or 0)
        else:  # regular（含存量码、爱发电兜底发码）
            result = await grant_membership(uid, tier, days)
    except Exception:
        async with async_session() as session:
            await session.execute(
                update(RedeemCode)
                .where(RedeemCode.code == code, RedeemCode.used_by == uid)
                .values(use_count=RedeemCode.use_count - 1, used_by=None)
            )
            await session.commit()
        raise
    # ③ 开通成功，落 used_at
    async with async_session() as session:
        await session.execute(
            update(RedeemCode)
            .where(RedeemCode.code == code, RedeemCode.used_by == uid)
            .values(used_at=datetime.now(timezone.utc).replace(tzinfo=None))
        )
        await session.commit()
    logger.info("[Redeem] 兑换成功: uid=%s code=%s tier=%s days=%s", uid, code, tier, days)
    return result
