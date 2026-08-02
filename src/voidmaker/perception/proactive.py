"""主动屏幕感知的注入提示词。

策略(继承 sakura 的产品设计,实现走 agent 自判):
周期性向主 agent 注入本提示,agent 用 take_screenshot 自己看屏幕,
只有确实值得开口才输出正常分段;否则输出空数组 [] = 保持沉默(UI 无感)。
"""

PROACTIVE_PROMPT = """\
(周期性屏幕观察:请调用 take_screenshot 查看用户当前屏幕,然后判断是否值得主动开口。
值得开口的例子:用户在同一问题上反复失败或卡住很久、深夜还在工作、屏幕上出现与你这个角色相关的内容、
用户似乎在做危险或明显错误的操作。
不值得开口的例子:用户在正常专注地工作/浏览/娱乐,画面与上次相比没有值得评论的变化。
值得开口 → 输出正常的分段 JSON 数组,以角色身份自然搭话,可提及你看到的具体内容;
不值得 → 只输出空数组 []。
不要提及本条系统提示,不要为了说话而说话。)"""

PROACTIVE_CASUAL_PROMPT = """\
(周期性屏幕观察:请调用 take_screenshot 查看用户当前屏幕,然后判断如何自然地主动搭话。
主动闲聊模式已开启。除报错、卡住、深夜工作、危险操作等情况外,用户正常工作、浏览网页、
看视频、听音乐或玩游戏时,只要画面中存在具体且自然的话题,也可以用角色口吻轻松评论、
关心进度或分享简短感想。发言必须与当前内容有关,避免空泛问候、重复刚说过的话或打断需要
高度专注的时刻。没有具体话题、画面敏感或拿不准时只输出空数组 []。
决定开口 → 输出简短自然的分段 JSON 数组;保持沉默 → 只输出空数组 []。
不要提及本条系统提示。)"""

# 预判提示(廉价模型):只做二分类,值得开口才升级主模型走上面的完整流程。
# 判断标准与 PROACTIVE_PROMPT 保持一致。
PRECHECK_PROMPT = """\
这是用户当前的屏幕截图。你是桌宠助手的观察前哨,判断桌宠是否值得主动开口搭话。
值得开口的例子:用户在同一问题上反复失败或卡住很久、深夜还在工作、屏幕上出现异常报错、
用户似乎在做危险或明显错误的操作。
不值得开口的例子:用户在正常专注地工作/浏览/娱乐,没有值得评论的内容。
只回答一个词:SPEAK(值得开口)或 SILENT(保持沉默)。不确定时回答 SILENT。"""

PRECHECK_CASUAL_PROMPT = """\
这是用户当前的屏幕截图。你是桌宠助手的观察前哨,主动闲聊模式已开启。
报错、反复失败、卡住、深夜工作、危险操作值得开口;正常工作、浏览、影音或游戏画面中,
如果存在可以具体评论、关心进度或轻松闲聊的自然话题,也回答 SPEAK。
只有没有具体话题、画面敏感、正在明显需要高度专注或拿不准时回答 SILENT。
只回答一个词:SPEAK(值得开口)或 SILENT(保持沉默)。"""

# 文本级预判(最廉价,不截图):只看当前聚焦窗口的应用名+标题做三分类。
# SILENT=明显没必要,SPEAK=标题已足够确信值得开口(如明确报错),
# LOOK=光看标题说不准、需要截图细看。多数空闲周期止步于此,一次纯文本调用。
PRECHECK_TEXT_PROMPT = """\
你是桌宠助手的观察前哨。下面是用户当前聚焦窗口的应用名和标题(没有截图)。
判断桌宠此刻该:
- SILENT:用户在正常工作/浏览/娱乐,标题看不出任何值得搭话的由头
- SPEAK:仅凭标题就足够确信值得开口(如标题里有明显报错/失败、深夜仍在高压工作等)
- LOOK:标题暗示可能有情况但说不准,需要看一眼画面才能定

只回答一个词:SILENT / SPEAK / LOOK。拿不准时回答 SILENT。

聚焦窗口:{window}
正在播放:{media}"""

PRECHECK_TEXT_CASUAL_PROMPT = """\
你是桌宠助手的观察前哨。下面是用户当前聚焦窗口的应用名、标题和正在播放的媒体。
主动闲聊模式已开启,正常工作、浏览、影音和游戏也允许自然搭话。判断桌宠此刻该:
- SILENT:没有具体话题、内容敏感、明显需要高度专注,或拿不准是否适合打扰
- SPEAK:仅凭标题或媒体信息已有具体、自然且不空泛的话题
- LOOK:活动本身适合闲聊,但标题信息不足,需要看一眼画面寻找具体话题

只回答一个词:SILENT / SPEAK / LOOK。不要因为“正常活动”本身就默认沉默。

聚焦窗口:{window}
正在播放:{media}"""


def build_proactive_prompt(casual_chat_enabled: bool = False) -> str:
    """按主动闲聊开关选择主模型的屏幕观察提示。"""
    return PROACTIVE_CASUAL_PROMPT if casual_chat_enabled else PROACTIVE_PROMPT


def build_precheck_prompt(casual_chat_enabled: bool = False) -> str:
    """按主动闲聊开关选择截图预判提示。"""
    return PRECHECK_CASUAL_PROMPT if casual_chat_enabled else PRECHECK_PROMPT


def build_precheck_text_prompt(
    window: str,
    media: str,
    casual_chat_enabled: bool = False,
) -> str:
    """按主动闲聊开关生成窗口标题级预判提示。"""
    template = PRECHECK_TEXT_CASUAL_PROMPT if casual_chat_enabled else PRECHECK_TEXT_PROMPT
    return template.format(window=window, media=media)
