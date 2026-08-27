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
    """启动时建表 + 自动补列。
    create_all 只建【新表】不给旧表加列；加列靠 _ensure_columns 启动自愈
    （V0.8.0 漏跑生产 ALTER 全站 500 / V0.9.0 启动崩溃循环——人肉 ALTER 防不住）。"""
    # 延迟 import，确保所有模型类已定义并被 Base.metadata 收集
    from auth import models  # noqa: F401
    import chat_store  # noqa: F401
    import stats_store  # noqa: F401
    import billing_store  # noqa: F401
    import history_store  # noqa: F401
    import afdian_store  # noqa: F401
    import redeem_store  # noqa: F401
    import ticket_store  # noqa: F401
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    await _ensure_columns()


# ===== 启动自动补列（schema 自愈）=====
# 新增列时在这里登记一行：(表, 列, 列定义)。create_all 不管旧表加列，这里兜底。
_EXPECTED_COLUMNS = [
    ("user_billing", "membership_expire_at", "DATETIME"),
    ("user_billing", "gravity_grant_at", "DATETIME"),
    ("billing_ledger", "from_gift", "INTEGER"),
    ("billing_ledger", "from_perm", "INTEGER"),
    ("users", "admin_pin_hash", "VARCHAR"),
    ("users", "vault_pass_hash", "VARCHAR"),
    ("users", "vault_enabled", "BOOLEAN"),
    ("users", "vault_quota_mb", "INTEGER"),
    ("users", "vault_rejected_at", "DATETIME"),
    ("redeem_codes", "grant_mode", "VARCHAR"),
    ("redeem_codes", "quantum_grant", "INTEGER"),
    ("redeem_codes", "gravity_grant", "INTEGER"),
    ("billing_ledger", "note", "VARCHAR"),
    ("task_records", "raw_text", "TEXT"),
    ("task_records", "subtitle_srt", "TEXT"),
    ("task_records", "md_content", "TEXT"),
    ("task_records", "summary_content", "TEXT"),
    # V1.1.0 分模型成本体系：流水记"当时模型+用量+真实成本"（发票原则）
    ("billing_ledger", "model", "VARCHAR"),
    ("billing_ledger", "prompt_tokens", "INTEGER"),
    ("billing_ledger", "completion_tokens", "INTEGER"),
    ("billing_ledger", "cache_hit_tokens", "INTEGER"),
    ("billing_ledger", "cache_miss_tokens", "INTEGER"),
    ("billing_ledger", "cost_yuan", "FLOAT"),
    # V1.1.0 模型价签（NULL=按 provider 默认价）
    ("model_configs", "price_input", "FLOAT"),
    ("model_configs", "price_output", "FLOAT"),
    ("model_configs", "price_cache_hit", "FLOAT"),
    ("model_configs", "price_per_hour", "FLOAT"),
    # V1.1.0 流水价签快照（账单公式需要"当时单价"，改价不改历史）
    ("billing_ledger", "price_input", "FLOAT"),
    ("billing_ledger", "price_output", "FLOAT"),
    ("billing_ledger", "price_cache_hit", "FLOAT"),
    ("billing_ledger", "price_per_hour", "FLOAT"),
    # V1.1.0 任务统计字段持久化（原仅存内存，重启即失）
    ("task_records", "actual_chars", "INTEGER"),
    ("task_records", "actual_seg_tokens", "INTEGER"),
    ("task_records", "subtitle_source", "VARCHAR(32)"),
    ("task_records", "md_status", "VARCHAR(16)"),
    ("task_records", "summary_status", "VARCHAR(16)"),
    # V1.3.0 峰谷定价：model_configs 峰谷配置 + 发票峰谷标记
    ("model_configs", "peak_windows", "VARCHAR"),
    ("model_configs", "weekend_rule", "VARCHAR"),
    ("model_configs", "off_price_input", "FLOAT"),
    ("model_configs", "off_price_output", "FLOAT"),
    ("model_configs", "off_price_cache_hit", "FLOAT"),
    ("billing_ledger", "price_tier", "VARCHAR"),
    # V1.3.0 历史记录源视频链接（本地上传为 NULL；TEXT 完整保存不截断）
    ("task_records", "source_url", "TEXT"),
]


async def _ensure_columns() -> None:
    """检查 _EXPECTED_COLUMNS，缺哪列补哪列（幂等，启动时调用）"""
    from sqlalchemy import text
    async with engine.begin() as conn:
        for table, column, ddl in _EXPECTED_COLUMNS:
            rows = (await conn.execute(text(f"PRAGMA table_info({table})"))).fetchall()
            if rows and column not in {r[1] for r in rows}:
                await conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}"))
                print(f"[DB] 自动补列: {table}.{column}")
