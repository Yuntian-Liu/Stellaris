"""
ORM 模型 — users / verification_codes / invite_codes
对标 Datelife 表结构，bcrypt 改单字段 password_hash（自带 salt，不需要独立 salt 列）。
"""
from datetime import datetime

from sqlalchemy import String, Integer, Boolean, DateTime, func
from sqlalchemy.orm import Mapped, mapped_column

from database import Base


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    uid: Mapped[int] = mapped_column(Integer, unique=True, index=True, nullable=False)
    email: Mapped[str] = mapped_column(String, unique=True, index=True, nullable=False)
    nickname: Mapped[str] = mapped_column(String, nullable=False)
    avatar_seed: Mapped[str] = mapped_column(String, nullable=False)
    bio: Mapped[str | None] = mapped_column(String, default="")
    # bcrypt 自带 salt，单字段足够；纯验证码注册用户可为 NULL
    password_hash: Mapped[str | None] = mapped_column(String, nullable=True)
    is_admin: Mapped[bool] = mapped_column(Boolean, default=False)
    # 管理 PIN（敏感操作二次验证；bcrypt 哈希，未设置可 NULL；V0.9.0 新增列）
    admin_pin_hash: Mapped[str | None] = mapped_column(String, nullable=True)
    vault_pass_hash: Mapped[str | None] = mapped_column(String, nullable=True)   # V1.1.3 文件柜专用密码
    vault_enabled: Mapped[bool | None] = mapped_column(nullable=True)    # V1.2.0 文件柜内测开关（NULL/0=未开通）
    vault_quota_mb: Mapped[int | None] = mapped_column(nullable=True)    # V1.2.0 配额 MB（NULL→默认 5）
    badge: Mapped[str | None] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )


class VerificationCode(Base):
    __tablename__ = "verification_codes"

    # email 作主键：同一邮箱同时只存一条（UPSERT 覆盖）
    email: Mapped[str] = mapped_column(String, primary_key=True)
    code: Mapped[str] = mapped_column(String, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class InviteCode(Base):
    """邀请码表：本期只建表占位，逻辑后续接福利时实现。"""
    __tablename__ = "invite_codes"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    code: Mapped[str] = mapped_column(String, unique=True, index=True, nullable=False)
    used_by: Mapped[int | None] = mapped_column(Integer, nullable=True)
    used_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    max_uses: Mapped[int] = mapped_column(Integer, default=1)
    use_count: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
