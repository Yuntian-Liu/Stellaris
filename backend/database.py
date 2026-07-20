"""
数据库初始化 — SQLAlchemy 2.0 async + aiosqlite
提供 async engine、session 工厂、get_db 依赖、init_db 建表。
"""
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from config import DATABASE_URL


class Base(DeclarativeBase):
    """所有 ORM 模型的基类"""
    pass


# async engine（echo=False 关闭 SQL 日志；个人项目无需连接池调优）
engine = create_async_engine(DATABASE_URL, echo=False)
async_session = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)


async def get_db():
    """FastAPI 依赖：每个请求一个 session，请求结束自动关闭。"""
    async with async_session() as session:
        yield session


async def init_db():
    """启动时建表（Base.metadata.create_all，不上 Alembic——个人项目改 schema 直接删 db 重建）。"""
    # 延迟 import，确保所有模型类已定义并被 Base.metadata 收集
    from auth import models  # noqa: F401
    import chat_store  # noqa: F401
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
