"""
爱发电 — afdian_orders 表 + webhook RSA 验签 + API 签名

- webhook：订单推送带 RSA-SHA256 签名（sign_str = out_trade_no+user_id+plan_id+total_amount），
  官方公钥验签（config.AFDIAN_PUBLIC_KEY，文档固定值）
- API（query-order 反查/人工核验备用）：sign = md5(token + "params{v}ts{v}user_id{v}")
- 幂等：out_trade_no 主键，重复推送直接确认
"""
import base64
import hashlib
import logging
from datetime import datetime

from sqlalchemy import DateTime, Integer, String, Text, func, insert, update
from sqlalchemy.orm import Mapped, mapped_column

from config import AFDIAN_API_TOKEN, AFDIAN_PUBLIC_KEY, AFDIAN_USER_ID
from database import Base, async_session

logger = logging.getLogger(__name__)


class AfdianOrder(Base):
    """爱发电订单（webhook 落库，审计 + 幂等锚）"""
    __tablename__ = "afdian_orders"

    out_trade_no: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_uid: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    plan_id: Mapped[str] = mapped_column(String(64), default="")
    total_amount: Mapped[str] = mapped_column(String(16), default="")
    # granting（占位中）| processed（已开通）| grant_failed（占位后开通失败,待人工）|
    # unmapped_user | unknown_plan | bad_sign | donation | ignored
    status: Mapped[str] = mapped_column(String(20), default="processed")
    payload: Mapped[str] = mapped_column(Text, default="")   # 原始推送 JSON（排查用）
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


def verify_webhook_sign(order: dict, sign: str) -> bool:
    """webhook RSA-SHA256 验签（官方公钥，离线可验）"""
    if not sign:
        return False
    try:
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import padding
        pub = serialization.load_pem_public_key(AFDIAN_PUBLIC_KEY.encode())
        sign_str = (order.get("out_trade_no", "") + order.get("user_id", "")
                    + order.get("plan_id", "") + order.get("total_amount", ""))
        pub.verify(base64.b64decode(sign), sign_str.encode(),
                   padding.PKCS1v15(), hashes.SHA256())
        return True
    except Exception as e:
        logger.warning("[Afdian] 验签失败: %s", e)
        return False


async def order_exists(out_trade_no: str) -> bool:
    async with async_session() as session:
        return (await session.get(AfdianOrder, out_trade_no)) is not None


async def record_order(out_trade_no: str, user_uid: int | None, plan_id: str,
                       total_amount: str, status: str, payload: str) -> int:
    """落库订单（INSERT OR IGNORE 原子占位）。返回 rowcount（1=新插入, 0=已存在忽略）。
    Y1：processed 流程用返回值做并发抢锁——rowcount=0 即并发败者或重复推送。"""
    async with async_session() as session:
        r = await session.execute(
            insert(AfdianOrder).prefix_with("OR IGNORE").values(
                out_trade_no=out_trade_no, user_uid=user_uid, plan_id=plan_id,
                total_amount=total_amount, status=status, payload=payload,
            )
        )
        await session.commit()
        return r.rowcount or 0


async def update_order_status(out_trade_no: str, status: str) -> None:
    """更新订单状态（Y1：占位后 grant 成功→processed / 失败→grant_failed）"""
    async with async_session() as session:
        await session.execute(
            update(AfdianOrder)
            .where(AfdianOrder.out_trade_no == out_trade_no)
            .values(status=status)
        )
        await session.commit()


async def get_orders_for_user(uid: int) -> list[dict]:
    """用户的爱发电订单（开通记录展示用，时间倒序）"""
    from sqlalchemy import select
    async with async_session() as session:
        result = await session.execute(
            select(AfdianOrder)
            .where(AfdianOrder.user_uid == uid, AfdianOrder.status == "processed")
            .order_by(AfdianOrder.created_at.desc())
            .limit(50)
        )
        return [
            {
                "plan_id": r.plan_id,
                "total_amount": r.total_amount,
                "created_at": r.created_at.isoformat() + "Z" if r.created_at else None,
            }
            for r in result.scalars()
        ]


def api_sign(params_json: str, ts: int) -> str:
    """爱发电 API 签名：md5(token + 'params{params}ts{ts}user_id{user_id}')"""
    kv = f"params{params_json}ts{ts}user_id{AFDIAN_USER_ID}"
    return hashlib.md5((AFDIAN_API_TOKEN + kv).encode()).hexdigest()
