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
# V1.3.0 峰谷定价：deepseek 预填官方错峰规则（峰 09:00-12:00/14:00-18:00，周末全谷，
# 谷价三值按官方错峰价；行内未配峰谷时回落到这里，零操作即生效）。mimo 按小时计价无峰谷。
DEFAULT_PRICES = {
    "deepseek": {
        "price_input": 4.0, "price_output": 12.0, "price_cache_hit": 0.5, "price_per_hour": None,
        "peak_windows": [["09:00", "12:00"], ["14:00", "18:00"]],
        "weekend_rule": "all_offpeak",
        "off_price_input": 1.0, "off_price_output": 4.0, "off_price_cache_hit": 0.25,
    },
    "mimo": {
        "price_input": 4.0, "price_output": 12.0, "price_cache_hit": 0.5, "price_per_hour": 0.498,
        "peak_windows": [], "weekend_rule": "all_offpeak",
        "off_price_input": None, "off_price_output": None, "off_price_cache_hit": None,
    },
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
    # 峰谷定价（V1.3.0；仅 LLM 使用。NULL/空 → 全部按峰价，与旧版行为一致）
    peak_windows: Mapped[str | None] = mapped_column(nullable=True)   # JSON [["09:00","12:00"],...] 支持跨午夜
    weekend_rule: Mapped[str | None] = mapped_column(nullable=True)   # all_offpeak=周末全谷 / same=周末同工作日
    off_price_input: Mapped[float | None] = mapped_column(nullable=True)    # 谷价三列
    off_price_output: Mapped[float | None] = mapped_column(nullable=True)
    off_price_cache_hit: Mapped[float | None] = mapped_column(nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


import json as _json
import math as _math
import re as _re
from datetime import timedelta as _timedelta

_TZ_CN = timezone(_timedelta(hours=8))   # 峰谷判定一律 UTC+8


def _parse_windows(raw) -> list[list[str]]:
    """peak_windows JSON → [["09:00","12:00"],...]；坏数据按空处理（无峰谷）"""
    if not raw:
        return []
    try:
        w = _json.loads(raw) if isinstance(raw, str) else raw
        return [[str(a), str(b)] for a, b in w if a and b]
    except Exception:
        return []


def price_tier_at(dt, peak_windows, weekend_rule: str | None) -> str:
    """判定某时刻（UTC+8）属峰还是谷。
    空窗口 → 恒峰（无峰谷体系，优先于周末规则）；周末规则次之：all_offpeak 且周末 → 谷；
    再逐窗口匹配（支持跨午夜：start>end 时跨零点）。
    边界：含开始、不含结束（09:00 属峰，12:00 属谷）。"""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    local = dt.astimezone(_TZ_CN)
    windows = _parse_windows(peak_windows)
    if not windows:
        return "peak"
    if (weekend_rule or "all_offpeak") == "all_offpeak" and local.weekday() >= 5:
        return "offpeak"
    hm = local.hour * 60 + local.minute
    for start, end in windows:
        try:
            sh, sm = map(int, start.split(":"))
            eh, em = map(int, end.split(":"))
        except ValueError:
            continue
        s, e = sh * 60 + sm, eh * 60 + em
        if s <= e:
            if s <= hm < e:
                return "peak"
        else:   # 跨午夜（如 22:00-06:00）
            if hm >= s or hm < e:
                return "peak"
    return "offpeak"


def apply_tier(prices: dict, tier: str) -> dict:
    """按峰/谷取有效价签：谷段把三个 LLM 价换成谷价（谷价空 → 该项沿用峰价）。
    price_per_hour（ASR）不参与峰谷，原样保留。"""
    if tier != "offpeak":
        return prices
    out = dict(prices)
    for peak_key, off_key in (("price_input", "off_price_input"),
                              ("price_output", "off_price_output"),
                              ("price_cache_hit", "off_price_cache_hit")):
        v = prices.get(off_key)
        if v is not None:
            out[peak_key] = v
    return out


def resolve_prices(provider: str, row=None) -> dict:
    """解析有效价签：行内非空字段优先，NULL 回落厂商默认。
    缓存命中价特别规则：行与默认都没有时 = 输入价（无缓存机制的厂商不受影响，命中恒 0）。
    V1.3.0 峰谷语义（Codex 02 棒定稿）：
    - row is None（纯 env 兜底）→ 厂商默认全套（含 deepseek 官方峰谷）
    - row 存在但峰谷列为空 → 空峰窗恒峰；谷价 NULL → 沿用**本行峰价**（"留空=与峰同价"名实相符）
    - deepseek 老行的官方峰谷由 seed 自愈显式写入（见 seed_model_configs），不靠 NULL 回落"""
    defaults = DEFAULT_PRICES.get(provider, DEFAULT_PRICES["deepseek"])

    def pick(field):
        v = getattr(row, field, None) if row is not None else None
        return v if v is not None else defaults.get(field)

    prices = {
        "price_input": pick("price_input"),
        "price_output": pick("price_output"),
        "price_cache_hit": pick("price_cache_hit"),
        "price_per_hour": pick("price_per_hour"),
        # 峰谷配置：仅 row is None（纯 env 兜底）才回落厂商默认；行存在时 NULL 保持 NULL/空
        "peak_windows": (defaults.get("peak_windows") if row is None
                         else (getattr(row, "peak_windows", None) or [])),
        "weekend_rule": (defaults.get("weekend_rule") if row is None
                         else (getattr(row, "weekend_rule", None) or "all_offpeak")),
        "off_price_input": defaults.get("off_price_input") if row is None
        else getattr(row, "off_price_input", None),
        "off_price_output": defaults.get("off_price_output") if row is None
        else getattr(row, "off_price_output", None),
        "off_price_cache_hit": defaults.get("off_price_cache_hit") if row is None
        else getattr(row, "off_price_cache_hit", None),
    }
    if prices["price_cache_hit"] is None:
        prices["price_cache_hit"] = prices["price_input"]
    if row is not None:
        # 行内谷价留空 = 沿用本行峰价（前端承诺的语义）
        if prices["off_price_input"] is None:
            prices["off_price_input"] = prices["price_input"]
        if prices["off_price_output"] is None:
            prices["off_price_output"] = prices["price_output"]
        if prices["off_price_cache_hit"] is None:
            prices["off_price_cache_hit"] = prices["price_cache_hit"]
    elif prices["off_price_cache_hit"] is None and prices["off_price_input"] is not None:
        prices["off_price_cache_hit"] = prices["off_price_input"]
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
                # V1.3.0：仅全新库的预置行显式带官方峰谷（管理员可改可清空；
                # 老行一律恒峰，绝不做批量"自愈"——否则用户主动清空的重启后会被恢复，Codex 02 棒二轮）
                ModelConfig(slot="llm", label="DeepSeek V4 Pro", provider="deepseek",
                            model=LLM_MODEL, is_active=True,
                            price_input=ds["price_input"], price_output=ds["price_output"],
                            price_cache_hit=ds["price_cache_hit"],
                            peak_windows=_json.dumps(ds["peak_windows"]),
                            weekend_rule=ds["weekend_rule"],
                            off_price_input=ds["off_price_input"],
                            off_price_output=ds["off_price_output"],
                            off_price_cache_hit=ds["off_price_cache_hit"]),
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
    """更新价签（PIN 路由调用；空值=None=回默认）。
    V1.3.0：支持峰谷配置（peak_windows JSON 字符串 / weekend_rule / 谷价三列），
    带格式与重叠校验。"""
    allowed = ("price_input", "price_output", "price_cache_hit", "price_per_hour",
               "peak_windows", "weekend_rule",
               "off_price_input", "off_price_output", "off_price_cache_hit")
    if "weekend_rule" in pricing and pricing["weekend_rule"] not in (None, "all_offpeak", "same"):
        raise ValueError("weekend_rule 仅支持 all_offpeak / same")
    if "peak_windows" in pricing and pricing["peak_windows"]:
        _validate_windows(pricing["peak_windows"])
    # 价格校验：非负有限数字（Codex 02 棒：拒绝负数/NaN/Inf/字符串混进 FLOAT 列）
    for k in ("price_input", "price_output", "price_cache_hit", "price_per_hour",
              "off_price_input", "off_price_output", "off_price_cache_hit"):
        if k in pricing and pricing[k] is not None:
            v = pricing[k]
            if isinstance(v, bool) or not isinstance(v, (int, float)) \
                    or not _math.isfinite(v) or v < 0:
                raise ValueError(f"{k} 必须是非负有限数字")
    async with async_session() as session:
        row = await session.get(ModelConfig, model_id)
        if not row:
            raise ValueError("配置不存在")
        if row.slot != "llm":
            for k in ("peak_windows", "weekend_rule",
                      "off_price_input", "off_price_output", "off_price_cache_hit"):
                if pricing.get(k) is not None:
                    raise ValueError("峰谷配置仅支持 LLM 模型")
        for k in allowed:
            if k in pricing:
                row.__setattr__(k, pricing[k])
        await session.commit()
        logger.info("[Models] 更新价签: %s → %s", row.model,
                    {k: getattr(row, k) for k in allowed})
        return _to_dict(row)


def _validate_windows(raw) -> None:
    """校验峰时段：顶层数组、每项恰好两个 HH:MM 字符串、小时 0-23（24:00 仅可作结束）、
    分钟 0-59、时段不重叠（跨午夜展开判定）。Codex 02 棒：严格化，拒绝 {}、空端点、10:99"""
    try:
        data = _json.loads(raw) if isinstance(raw, str) else raw
    except Exception:
        raise ValueError("峰时段必须是 JSON 数组")
    if not isinstance(data, list):
        raise ValueError("峰时段必须是 JSON 数组")
    spans = []
    for item in data:
        if (not isinstance(item, (list, tuple))) or len(item) != 2 \
                or not all(isinstance(x, str) for x in item):
            raise ValueError('每个峰时段必须是 ["HH:MM", "HH:MM"] 形式')
        sv = _parse_hm(item[0], allow_24=False)
        ev = _parse_hm(item[1], allow_24=True)
        if sv is None or ev is None:
            raise ValueError(f"时段格式错误：{item[0]}-{item[1]}（HH:MM，分钟 0-59）")
        if sv == ev:
            raise ValueError(f"时段无效：{item[0]}-{item[1]}")
        spans.extend([(sv, ev)] if sv < ev else [(sv, 1440), (0, ev)])
    spans.sort()
    for (s1, e1), (s2, e2) in zip(spans, spans[1:]):
        if s2 < e1:
            raise ValueError("峰时段存在重叠，请调整")


def _parse_hm(s: str, allow_24: bool) -> int | None:
    """HH:MM → 分钟数；分钟 0-59、小时 0-23（24:00 仅 allow_24 时接受）。非法返回 None"""
    m = _re.fullmatch(r"(\d{1,2}):(\d{2})", s or "")
    if not m:
        return None
    h, mi = int(m.group(1)), int(m.group(2))
    if mi >= 60 or h > 24 or (h == 24 and (mi > 0 or not allow_24)):
        return None
    return h * 60 + mi


# ── 管理后台 CRUD ──

def _to_dict(r: ModelConfig) -> dict:
    return {
        "id": r.id, "slot": r.slot, "label": r.label,
        "provider": r.provider, "model": r.model, "is_active": r.is_active,
        "price_input": r.price_input, "price_output": r.price_output,
        "price_cache_hit": r.price_cache_hit, "price_per_hour": r.price_per_hour,
        "peak_windows": r.peak_windows, "weekend_rule": r.weekend_rule,
        "off_price_input": r.off_price_input, "off_price_output": r.off_price_output,
        "off_price_cache_hit": r.off_price_cache_hit,
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
