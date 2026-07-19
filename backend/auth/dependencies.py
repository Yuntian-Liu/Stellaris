"""
Auth 依赖注入 — get_current_user(从 JWT 解当前用户)
"""
from fastapi import Depends, Header, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from auth.models import User
from auth.utils import decode_access_token


async def get_current_user(
    authorization: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
) -> User:
    """从 Authorization: Bearer <token> 解当前用户。失败抛 401。"""
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="未登录")
    payload = decode_access_token(authorization[7:])
    if not payload:
        raise HTTPException(status_code=401, detail="登录已过期,请重新登录")
    uid = payload.get("uid")
    if uid is None:
        raise HTTPException(status_code=401, detail="登录凭证无效")
    # JWT 存的是业务 uid(不是主键 id),按 uid 查
    result = await db.execute(select(User).where(User.uid == uid))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=401, detail="用户不存在")
    return user
