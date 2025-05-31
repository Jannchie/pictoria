from functools import cache

from waifu_scorer.predict import WaifuScorer

from ai.clip import get_clip_model, get_processor


@cache
def get_waifu_scorer() -> WaifuScorer:
    return WaifuScorer(clip_model=get_clip_model(), clip_processor=get_processor())
