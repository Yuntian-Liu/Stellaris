"""
用户可选 ASR 模型目录（V1.5.0）

设计定稿（与碳碳对齐 2026-09-29）：
- 常量起步。/api/asr/models 端点从本模块取数，前端选择卡纯数据驱动渲染——
  以后清单挪 DB（管理后台 CRUD）时只需替换本模块数据源，前端零改动。
- 与 model_store（管理后台"全局唯一生效"切换）是两个维度，互不干扰：
  model_store 管 mimo 引擎内部用哪个模型名；本目录管用户按任务选哪个引擎。
- 计费路线 1：用户侧按 时长×multiplier 扣分钟额度；token usage 仅记真实成本。
- 密钥永远只在环境变量（DASHSCOPE_API_KEY 等），本目录不含任何敏感信息。

pricing 计价模式：
- per_hour：成本 = 分钟/60 × price_per_hour（mimo，与 consume_minutes 原逻辑一致）
- per_token：成本 = (input_tokens×input + output_tokens×output) / 1e6（qwen，管线按实际
  usage 算好 cost_yuan 传给 consume_minutes 记账）
"""

# ===== 可选模型目录 =====
# label/desc/languages 是用户可见文案（V1.5.0 起对外匿名化：艺名制，不暴露厂商与真实模型名；
# 真实模型名只在 model_name 字段，进后端流水和 admin 后台，用户不可见）
ASR_MODELS = {
    "mimo": {
        "key": "mimo",
        "label": "Echo · 回声",
        "engine": "mimo_chat",          # asr.py 适配器标识
        "multiplier": 1,                 # 分钟倍率（用户侧扣费 = 时长 × 倍率）
        "beta": False,
        "languages": "中文 / 英文",
        "desc": "默认模型，稳定可靠，适合中文和英文内容",
        "pricing": {"mode": "per_hour"},
    },
    "qwen3.1": {
        "key": "qwen3.1",
        "label": "Babel · 巴别",
        "engine": "qwen_audio_sync",
        "multiplier": 2,
        "beta": True,
        "languages": "中 / 英 / 日 / 韩等 31 种语言自动识别",
        "desc": "多语言内测模型，识别更多语种；beta 阶段可能转写不准或异常",
        "supports_diarization": True,   # 说话人分离（Step 2；仅 qwen-audio-3.1-asr-flash 支持）
        # 价签按生产地域（新加坡/国际站）；北京地域为 0.8/2.7，本地开发的成本记账会略低，无碍
        "pricing": {"mode": "per_token", "input": 1.094, "output": 3.427},  # 元/百万 tokens
        "model_name": "qwen-audio-3.1-asr-flash",
    },
}

DEFAULT_ASR_KEY = "mimo"


def get_asr_choice(key: str | None, is_logged_in: bool) -> dict:
    """校验并返回用户选择的模型配置。
    None/空 → 默认模型；非法 key、匿名选 beta → ValueError（路由层转 400）。"""
    if not key:
        return ASR_MODELS[DEFAULT_ASR_KEY]
    choice = ASR_MODELS.get(key)
    if choice is None:
        raise ValueError(f"未知的识别模型：{key}")
    if choice["beta"] and not is_logged_in:
        raise ValueError("多语言内测模型仅限登录用户使用")
    return choice
