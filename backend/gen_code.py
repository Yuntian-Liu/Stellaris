"""
兑换码生成 CLI（管理看板可视化生成前的临时入口）

用法（在 backend/ 目录下）：
  .venv/bin/python gen_code.py --tier voyager --days 30 --note "活动送码"
  .venv/bin/python gen_code.py --tier stella --code "HER-STAR-WORD" --note "Stella 邀请"
  .venv/bin/python gen_code.py --tier odyssey --days 30 --count 5

参数：
  --tier      档位（stargazer/voyager/odyssey/stella）必填
  --days      有效天数（stella 永久档不传）
  --code      自定义码内容（可写有意义的词；缺省自动生成无歧义码）
  --count     生成数量（默认 1）
  --max-uses  每码可用次数（默认 1）
  --expires   过期时间 YYYY-MM-DD（缺省永不过期）
  --note      备注
"""
import argparse
import asyncio
from datetime import datetime

from redeem_store import create_code


async def main():
    p = argparse.ArgumentParser(description="Stellaris 兑换码生成")
    p.add_argument("--tier", required=True,
                   choices=["stargazer", "voyager", "odyssey", "stella"])
    p.add_argument("--days", type=int, default=None)
    p.add_argument("--code", default=None)
    p.add_argument("--count", type=int, default=1)
    p.add_argument("--max-uses", type=int, default=1)
    p.add_argument("--expires", default=None)
    p.add_argument("--note", default="")
    args = p.parse_args()

    days = None if args.tier == "stella" else (args.days or 30)
    expires = datetime.strptime(args.expires, "%Y-%m-%d") if args.expires else None

    for _ in range(args.count):
        code = await create_code(
            args.tier, days, note=args.note,
            custom_code=args.code if args.count == 1 else None,
            max_uses=args.max_uses, expires_at=expires,
        )
        print(code)


asyncio.run(main())
