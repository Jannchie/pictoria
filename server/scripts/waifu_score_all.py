from pathlib import Path

import shared
from db import Session
from services.waifu import waifu_score_all_posts

shared.target_dir = Path(R"E:\pictoria\server\demo")
waifu_score_all_posts(Session())
