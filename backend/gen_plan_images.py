"""爱发电方案封面图渲染 — 按网站会员卡设计稿生成 1200×750 PNG（3 张付费档）"""
from PIL import Image, ImageDraw, ImageFont

W, H = 1200, 750
FONT_SERIF_BOLD = "/System/Library/Fonts/Supplemental/Georgia Bold.ttf"
FONT_SERIF = "/System/Library/Fonts/Supplemental/Georgia.ttf"
FONT_CN = "/System/Library/Fonts/STHeiti Medium.ttc"
FONT_CN_LIGHT = "/System/Library/Fonts/STHeiti Light.ttc"

TIERS = [
    {
        "key": "stargazer", "name": "Stargazer", "cn": "观星者", "price": "8",
        "c1": (67, 56, 202), "c2": (99, 102, 241),
        "benefits": ["每日 40 分钟转写", "量子波 650/周 · 概要约 7 次", "引力波 50/月 · 历史保留 24 小时"],
    },
    {
        "key": "voyager", "name": "Voyager", "cn": "远航者", "price": "18",
        "c1": (109, 40, 217), "c2": (139, 92, 246),
        "benefits": ["每日 100 分钟转写", "量子波 1700/周 · 概要约 22 次", "引力波 150/月 · 历史保留 7 天"],
    },
    {
        "key": "odyssey", "name": "Odyssey", "cn": "奥德赛", "price": "68",
        "c1": (146, 64, 14), "c2": (245, 158, 11),
        "benefits": ["每日 300 分钟转写", "量子波 5000/周 · 概要约 61 次", "引力波 500/月 · 历史保留 30 天"],
    },
]


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def make_gradient(c1, c2):
    """135° 对角渐变（先小图插值再放大，平滑）"""
    small = Image.new("RGB", (32, 20))
    px = small.load()
    for y in range(20):
        for x in range(32):
            px[x, y] = lerp(c1, c2, (x / 31 + y / 19) / 2)
    return small.resize((W, H), Image.BICUBIC)


def font(path, size, index=0):
    try:
        return ImageFont.truetype(path, size, index=index)
    except Exception:
        return ImageFont.truetype(path, size)


def draw_sparkle(d, cx, cy, r, fill):
    """画一颗四角星（✦ 字符在系统字体中缺字形，改矢量绘制）"""
    inner = r * 0.32
    pts = []
    import math
    for i in range(8):
        radius = r if i % 2 == 0 else inner
        angle = -math.pi / 2 + i * math.pi / 4
        pts.append((cx + radius * math.cos(angle), cy + radius * math.sin(angle)))
    d.polygon(pts, fill=fill)


for t in TIERS:
    img = make_gradient(t["c1"], t["c2"])
    d = ImageDraw.Draw(img, "RGBA")

    # 装饰：右上大圆 + 散布星点（与网站卡片同款语言）
    d.ellipse([W - 260, -140, W + 60, 180], fill=(255, 255, 255, 22))
    d.ellipse([-100, H - 200, 140, H + 40], fill=(255, 255, 255, 14))
    for x, y, s in [(1080, 300, 15), (128, 138, 11), (957, 626, 10), (247, 617, 8), (628, 98, 9)]:
        draw_sparkle(d, x, y, s, (255, 255, 255, 110))

    # 档英文名（大衬线）+ 中文副标
    d.text((90, 150), t["name"], font=font(FONT_SERIF_BOLD, 96), fill=(255, 255, 255, 255))
    d.text((96, 270), t["cn"], font=font(FONT_CN, 34), fill=(255, 255, 255, 200))

    # 价格
    d.text((90, 360), "¥", font=font(FONT_SERIF, 44), fill=(255, 255, 255, 220))
    d.text((128, 336), t["price"], font=font(FONT_SERIF_BOLD, 110), fill=(255, 255, 255, 255))
    d.text((128 + d.textlength(t["price"], font=font(FONT_SERIF_BOLD, 110)) + 14, 398),
           "/月", font=font(FONT_CN, 30), fill=(255, 255, 255, 200))

    # 权益行
    y = 520
    for b in t["benefits"]:
        draw_sparkle(d, 104, y + 14, 8, (255, 255, 255, 160))
        d.text((132, y - 3), b, font=font(FONT_CN, 28), fill=(255, 255, 255, 225))
        y += 52

    # 底部品牌（中文用中文字体，避免缺字形）
    d.text((96, H - 66), "Stellaris", font=font(FONT_SERIF, 24), fill=(255, 255, 255, 150))
    d.text((96 + d.textlength("Stellaris", font=font(FONT_SERIF, 24)) + 8, H - 64),
           "会员", font=font(FONT_CN, 20), fill=(255, 255, 255, 150))

    out = f"../tmp/afdian-plan-{t['key']}.png"
    img.save(out)
    print("saved", out)
