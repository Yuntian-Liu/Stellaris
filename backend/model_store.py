"""
模型仓库（V1.1.0）— 管理后台可切换的 LLM/ASR 模型配置

设计定稿（碳碳拍板）：
- 两个独立槽位：llm / asr，各自保存一组模型，点「启用」即时切换
- 密钥永远只在环境变量；DB 只存显示名/厂商/模型名字符串（无敏感信息）
- 厂商决定凭证来源：deepseek → LLM_API_KEY/LLM_BASE_URL；mimo → MIMO_API_KEY/MIMO_BASE_URL
- 同步缓存：启动加载 + admin 写后即时刷新；llm.py/asr.py 同步线程零 await 读取
- 缓存空（未 seed/被清空）→ 回退环境变量默认值，行为与改造前完全一致
"""
import logging
from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, Integer, String, func, select, update
from sqlalchemy.orm import Mapped, mapped_column

from config import (
    LLM_API_KEY, LLM_BASE_URL, LLM_MODEL,
    MIMO_API_KEY, MIMO_BASE_URL, MIMO_MODEL,
)
from database import Base, async_session

logger = logging.getLogger(__name__)

# 厂商 → 环境变量凭证（密钥永远不过 DB；新增厂商 = env 配 key + 这里加一行）
PROVIDER_CREDENTIALS = {
    "deepseek": (LLM_API_KEY, LLM_BASE_URL),
    "mimo": (MIMO_API_KEY, MIMO_BASE_URL),
}

# 厂商默认价签（价签列为 NULL 时回落到这里；单位：元/百万 tokens，ASR 为元/小时）
DEFAULT_PRICES = {
    "deepseek": {"price_input": 4.0, "price_output": 12.0, "price_cache_hit": 0.5, "price_per_hour": None},
    "mimo": {"price_input": 4.0, "price_output": 12.0, "price_cache_hit": 0.5, "price_per_hour": 0.498},
}

# 无 DB 配置时的兜底（与改造前行为一致）
_ENV_FALLBACK = {
    "llm": ("deepseek", LLM_MODEL),
    "asr": ("mimo", MIMO_MODEL),
}


class ModelConfig(Base):
    """一条已保存的模型配置"""
    __tablename__ = "model_configs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    slot: Mapped[str] = mapped_column(String(8))          # llm / asr
    label: Mapped[str] = mapped_column(String(64))        # 显示名，如 "DeepSeek V4 Pro"
    provider: Mapped[str] = mapped_column(String(16))     # deepseek / mimo
    model: Mapped[str] = mapped_column(String(64))        # 模型名字符串
    is_active: Mapped[bool] = mapped_column(Boolean, default=False)
    # 价签（V1.1.0；NULL → DEFAULT_PRICES[provider] 兜底）
    price_input: Mapped[float | None] = mapped_column(nullable=True)
    price_output: Mapped[float | None] = mapped_column(nullable=True)
    price_cache_hit: Mapped[float | None] = mapped_column(nullable=True)
    price_per_hour: Mapped[float | None] = mapped_column(nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


def resolve_prices(provider: str, row=None) -> dict:
    """解析有效价签：行内非空字段优先，NULL 回落厂商默认。
    缓存命中价特别规则：行与默认都没有时 = 输入价（无缓存机制的厂商不受影响，命中恒 0）。"""
    defaults = DEFAULT_PRICES.get(provider, DEFAULT_PRICES["deepseek"])
    def pick(field):
        v = getattr(row, field, None) if row is not None else None
        return v if v is not None else defaults.get(field)
    prices = {
        "price_input": pick("price_input"),
        "price_output": pick("price_output"),
        "price_cache_hit": pick("price_cache_hit"),
        "price_per_hour": pick("price_per_hour"),
    }
    if prices["price_cache_hit"] is None:
        prices["price_cache_hit"] = prices["price_input"]
    return prices


# ── 同步缓存（启动加载 + admin 写后刷新；读取零 await）──
_cache: dict[str, dict] = {}   # {"llm": {"provider":..., "model":...}, "asr": {...}}


def get_llm_active() -> tuple[str, str]:
    """当前生效 LLM：(provider, model)。缓存空 → env 兜底"""
    c = _cache.get("llm")
    if c:
        return c["provider"], c["model"]
    return _ENV_FALLBACK["llm"]


def get_asr_model() -> str:
    """当前生效 ASR 模型名。缓存空 → env 兜底"""
    c = _cache.get("asr")
    if c:
        return c["model"]
    return _ENV_FALLBACK["asr"][1]


async def refresh_cache() -> None:
    """从 DB 重载两个槽位的活跃配置到内存缓存"""
    async with async_session() as session:
        rows = (await session.execute(
            select(ModelConfig).where(ModelConfig.is_active.is_(True))
        )).scalars().all()
    _cache.clear()
    for r in rows:
        _cache[r.slot] = {"provider": r.provider, "model": r.model}


async def seed_model_configs() -> None:
    """表为空时插入预置（lifespan 启动调用）；随后刷新缓存"""
    async with async_session() as session:
        count = len((await session.execute(select(ModelConfig.id).limit(1))).scalars().all())
        if count == 0:
            ds = DEFAULT_PRICES["deepseek"]
            session.add_all([
                ModelConfig(slot="llm", label="DeepSeek V4 Pro", provider="deepseek",
                            model=LLM_MODEL, is_active=True,
                            price_input=ds["price_input"], price_output=ds["price_output"],
                            price_cache_hit=ds["price_cache_hit"]),
                ModelConfig(slot="llm", label="Xiaomi MIMO V2.5", provider="mimo",
                            model="mimo-v2.5", is_active=False),
                ModelConfig(slot="asr", label="Xiaomi MIMO V2.5 ASR", provider="mimo",
                            model=MIMO_MODEL, is_active=True,
                            price_per_hour=DEFAULT_PRICES["mimo"]["price_per_hour"]),
            ])
            await session.commit()
            logger.info("[Models] 预置模型配置已写入（LLM×2 / ASR×1）")
    await refresh_cache()


async def get_model_prices(slot: str) -> dict:
    """当前活跃模型的有效价签 + 模型名（结算成本用）"""
    provider, model = (get_llm_active() if slot == "llm"
                       else ("mimo", get_asr_model()))
    async with async_session() as session:
        row = (await session.execute(
            select(ModelConfig).where(
                ModelConfig.slot == slot, ModelConfig.model == model,
                ModelConfig.is_active.is_(True))
        )).scalar_one_or_none()
    return {"provider": provider, "model": model, **resolve_prices(provider, row)}


async def update_pricing(model_id: int, pricing: dict) -> dict:
    """更新价签（PIN 路由调用；空值=None=回默认）。仅接受四个价格键。"""
    allowed = ("price_input", "price_output", "price_cache_hit", "price_per_hour")
    async with async_session() as session:
        row = await session.get(ModelConfig, model_id)
        if not row:
            raise ValueError("配置不存在")
        for k in allowed:
            if k in pricing:
                row.__setattr__(k, pricing[k])
        await session.commit()
        logger.info("[Models] 更新价签: %s → %s", row.model,
                    {k: getattr(row, k) for k in allowed})
        return _to_dict(row)


# ── 管理后台 CRUD ──

def _to_dict(r: ModelConfig) -> dict:
    return {
        "id": r.id, "slot": r.slot, "label": r.label,
        "provider": r.provider, "model": r.model, "is_active": r.is_active,
        "price_input": r.price_input, "price_output": r.price_output,
        "price_cache_hit": r.price_cache_hit, "price_per_hour": r.price_per_hour,
    }


async def list_models() -> dict:
    """全部配置按槽位分组（管理后台展示）"""
    async with async_session() as session:
        rows = (await session.execute(
            select(ModelConfig).order_by(ModelConfig.slot, ModelConfig.id)
        )).scalars().all()
    out = {"llm": [], "asr": []}
    for r in rows:
        out.setdefault(r.slot, []).append(_to_dict(r))
    # 各槽位生效来源标注（缓存为空 = env 兜底）
    source = {
        slot: ("backend" if slot in _cache else "env")
        for slot in ("llm", "asr")
    }
    return {"models": out, "source": source}


async def add_model(slot: str, label: str, provider: str, model: str) -> dict:
    """添加一条模型配置（label/model 去空白；asr 槽强制 mimo）"""
    if slot not in ("llm", "asr"):
        raise ValueError("slot 仅支持 llm / asr")
    if provider not in PROVIDER_CREDENTIALS:
        raise ValueError("provider 仅支持 deepseek / mimo")
    if slot == "asr":
        provider = "mimo"
    label, model = label.strip(), model.strip()
    if not label or not model:
        raise ValueError("显示名与模型名不能为空")
    async with async_session() as session:
        row = ModelConfig(slot=slot, label=label[:64], provider=provider,
                          model=model[:64], is_active=False)
        session.add(row)
        await session.commit()
        await session.refresh(row)
        logger.info("[Models] 新增配置: %s / %s / %s", slot, provider, model)
        return _to_dict(row)


async def activate_model(model_id: int) -> None:
    """启用一条（同 slot 其他全部置非活跃，同事务）；随后刷新缓存"""
    async with async_session() as session:
        row = await session.get(ModelConfig, model_id)
        if not row:
            raise ValueError("配置不存在")
        await session.execute(
            update(ModelConfig)
            .where(ModelConfig.slot == row.slot)
            .values(is_active=False)
        )
        row.is_active = True
        await session.commit()
        slot, provider, model = row.slot, row.provider, row.model
    await refresh_cache()
    logger.info("[Models] 切换 %s → %s / %s", slot, provider, model)


async def delete_model(model_id: int) -> None:
    """删除一条；活跃项拒绝（先切换到别的再删）"""
    async with async_session() as session:
        row = await session.get(ModelConfig, model_id)
        if not row:
            raise ValueError("配置不存在")
        if row.is_active:
            raise ValueError("该模型正在生效中，请先切换到其他模型再删除")
        await session.delete(row)
        await session.commit()
        logger.info("[Models] 删除配置: %s / %s", row.slot, row.model)
