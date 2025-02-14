import httpx
import asyncio


async def download_from_danbooru(tag):
    """从 Danbooru 下载指定标签的图片。"""
    url = "http://localhost:4777/v1/cmd/download-from-danbooru"
    headers = {"accept": "application/json"}
    params = {"tags": tag}

    timeout = httpx.Timeout(30000)
    async with httpx.AsyncClient(timeout=timeout) as client:
        await client.get(url, headers=headers, params=params)
        print(f"Downloaded images for tag: {tag}")


async def main():
    tags = [
        "ask_(askzy)",
        "ciloranko",
        "zhibuji_loom",
        "pu_ht",
        "tomo0843",
        "niliu_chahui",
        "housou-kun",
        "pjkka",
        "banakotakemaru",
        "hiuzawa_reira",
        "tojo_(natumi1412)",
        "mauve",
        "miko_suuuuu",
        "kabu_usagi",
        "koba",
        "oyaji_hime",
        "nemun_(tamizzz)",
        "kanase_(mcbrwn18)",
        "oriti4",
        "kasakai_hikaru",
        "kita_(kitairoha)",
        "sky_cappuccino ",
        "samo_cha",
        "toosaka_asagi",
        "zeradok",
        "freng",
        "gin00",
        "tennohi",
        "yukie_(kusaka_shi)",
        "toridamono",
        "goomrrat",
        "sooon",
        "free_style_(yohan1754)",
        "cutesexyrobutts",
        "nikuya_(nikuniku_nikuya)",
        "yoshiheihe",
        "benevole",
        "hiroikara_(smhong04)",
        "torino_aqua",
        "pulmo_(artist)",
        "sy4",
        "kandori",
        "hitachi_sou",
        "toridamono",
        "koahri",
        "yeni1871",
        "yizhibao",
        "maccha_(mochancc)",
        "kujira_hebi",
        "kubota_masaki",
        "yunweishukuang",
        "hakua_aa",
        "pearlgang_e",
        "akita_hika",
        "sushispin",
        "songchuan_li",
        "poki_(j0ch3fvj6nd)",
        "yeogpu_(seung832222)",
        "ukitaryu",
        "gainoob",
        "de_da_xianyu",
        "houraku",
        "xzu",
        "machi_(machi0910)",
        "luenar",
        "toi1et_paper",
        "modare",
        "vivivoovoo",
        "kase_daiki",
        "shigure_s",
        "ru_zhai",
        "asanagi",
        "takashia_(akimototakashia)",
        "massoukei",
        "chyoel",
        "sakon04",
        "greatodoggo",
        "deyui",
        "espresso_1004",
        "haoma",
        "classic_(zildjian33)",
        "saitou_naoki",
        "miyase_mahiro",
        "morikura_en",
        "momoko_(momopoco)",
        "toridamono",
        "guchico",
        "sencha_(senta_10)",
        "drift_liulenghanle",
        "elphe",
        "smsm516",
        "hetareeji",
        "ttosom",
        "miwano_rag",
        "iwashi_111",
        "kure~pu",
        "mika_pikazo",
        "miko_fly",
        "yasumo_(kuusouorbital)",
        "gaou_(umaiyo_puyoman)",
        "higeneko",
        "shigure_ui",
        "quan_(kurisu_tina)",
        "ekita_kuro",
        "u_tnmn",
        "scottie_(phantom2)",
        "makihitsuji",
        "stratoz",
        "shotgunman",
        "amagasa_yun",
        "magako",
        "hyuuga_azuri",
        "miwabe_sakura",
        "captain_yue",
        "kamu_(geeenius)",
        "re:rin",
        "konagi_(konotuki)",
        "xuhh",
        "byulzzi",
        "clickdraws",
        "kimatoi",
        "chela77",
        "koahri",
        "classic_(zildjian33)",
        "qiandaiyiyu",
        "igayan",
        "noir_eku",
        "rb2",
        "rity",
        "kat (bu-kunn)",
        "yd_(orange_maru)",
        "fumihiko_(fu_mihi_ko)",
        "niliu_chahui",
        "kantoku",
        "kfr",
        "booota",
        "onono_imoko",
        "aburidashi_zakuro",
        "yume-dream",
        "freeeeeeeeeee",
        "yan_kodiac",
        "lhofi",
        "yoruniyoruyoshi",
        "wlop",
        "guweiz",
        "g-tz",
        "nixeu",
        "shal.e",
    ]

    # 循环调用 download_from_danbooru 函数
    for tag in tags:
        await download_from_danbooru(tag)


if __name__ == "__main__":
    asyncio.run(main())
