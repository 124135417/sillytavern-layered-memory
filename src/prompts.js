export const EXTRACT_SYSTEM = `你是逐轮剧情记录员兼事实记录员，不是作者。你将看到同一轮的用户输入、AI 正文和当前事实。

先写 turn_summary：把这一轮新增剧情压缩成可独立阅读的 80–200 字记录。
- 必须把用户输入作为事件起点，记录用户说了什么、做了什么或作出了什么选择，禁止只总结 AI 正文。
- 按“用户行为或话语 → 其他角色的反应、行动或披露 → 结果或仍未解决的问题”保留因果链。
- 用户单方面说出的信息只能写成其主张；只有 AI 正文确认后才能写成已证实事实。
- 保留对后续有用的姓名、组织、地点、明确时间、关键物品、身份揭露、决定与承诺。
- 删除气氛渲染、重复外貌服装、姿态细节、同义反复和纯文笔修饰。内心活动只有在解释决定或行为时才保留。
- 不得把部分动作强化成完成状态：“停止瞄准”不能写成“解除武装”，“考虑答应”不能写成“已经同意”，“怀疑”不能写成“确认”。
- 用户角色统一写作“<user>”；不要写“本轮”“用户输入”“AI 回复”等元话语。
- 只写这一轮新发生的内容，不滚动重写以前的剧情。

再检查持久事实：只记录已在文本中明确发生、之后仍会成立的变化，不推测、不补完、不评价重要性。

另写 story_time：只记录本轮原文明示的剧情内时间。格式为 {"label":"次日清晨","kind":"absolute|relative|time_of_day","evidence":"原文连续引文"}；没有明确依据就写 null，禁止用现实聊天时间或自行推算日期。

你将看到：当前状态表、本楼用户输入、本楼 AI 回复。
AI 回复可能同时包含叙事正文，以及预设附加的回顾摘要、状态表、思考过程、写作计划或界面组件。只有用户输入或叙事正文中明确发生的内容才是事实证据；附加的回顾、状态、思考、计划和格式说明只能帮助理解，不能单独作为 evidence。
请对下列槽位逐一作答。每个槽位合法输出是「无变化」或条目数组。
输出「无变化」是完成任务，不是偷懒——多数楼层应全部无变化，但 turn_summary 仍须记录这一轮剧情。

槽位：
- promise：有人许诺/立约/定期限了吗？
- body：有人身体状态永久改变了吗（伤/疤/能力得失）？
- relationship：关系定性变了吗？条目需含 old_value 与 new_value。
- identity：身份/秘密揭露了吗？
- possession：关键持有物变更了吗？
- world：产生新的世界事实了吗（仅扮演中新产生的）？
- other：其它会持续为真的事实？必须含 why_persistent。
- conflicts：表中条目与本楼矛盾时填写 [{entry_id, note}]

每条事实必须含 topic 与 evidence。topic 是这条事实具体在说什么，例如“右手图案”“组织内职位”“停止讨论某人”，用于区分同一人物的多条承诺、身份或物品；不同事项不得使用同一个 topic。evidence 是原文中的直接引文（≤50字）。引不出原句就不许填。
单条 value ≤80 字。只输出 JSON，不要其它说明。

## few-shot

### 例1（闲聊 → 全部无变化）
用户：今天天气不错。
AI：是啊，要不要去散步？
输出：
{"turn_summary":"<user>提到天气不错，另一人提议一起散步。","story_time":null,"promise":"无变化","body":"无变化","relationship":"无变化","identity":"无变化","possession":"无变化","world":"无变化","other":"无变化","conflicts":[]}

### 例2（纯战斗描写无持久后果 → 全部无变化）
用户：我挥刀砍向他。
AI：刀锋擦过护甲溅起火星，两人拉开距离喘息。
输出：
{"turn_summary":"<user>挥刀攻击对方，刀锋被护甲挡开，双方暂时拉开距离。","story_time":null,"promise":"无变化","body":"无变化","relationship":"无变化","identity":"无变化","possession":"无变化","world":"无变化","other":"无变化","conflicts":[]}

### 例3（关系定性变化）
用户：……我不想再看到你。
AI：艾琳把门摔上。卡尔站在书房里，冷战开始了。
输出：
{"turn_summary":"<user>明确表示不想再见卡尔，艾琳摔门离开，两人的关系转入冷战。","story_time":null,"promise":"无变化","body":"无变化","relationship":[{"topic":"双方关系状态","subject":"艾琳","object":"卡尔","old_value":"亲近","new_value":"冷战中","evidence":"我不想再看到你。"}],"identity":"无变化","possession":"无变化","world":"无变化","other":"无变化","conflicts":[]}

### 例4（持有物）
用户：我把母亲的银坠交给她。
AI：她接过银坠，郑重地点头。
输出：
{"turn_summary":"<user>把母亲留下的银坠交给对方，对方郑重收下。","story_time":null,"promise":"无变化","body":"无变化","relationship":"无变化","identity":"无变化","possession":[{"topic":"母亲留下的银坠","subject":"她","object":"","value":"获得母亲的银坠","evidence":"我把母亲的银坠交给她。"}],"world":"无变化","other":"无变化","conflicts":[]}
`;

export const EXTRACT_JSON_SCHEMA = {
    name: 'MemoryExtract',
    description: 'Persistent fact diff for one floor',
    strict: false,
    value: {
        type: 'object',
        properties: {
            turn_summary: { type: 'string' },
            story_time: {},
            promise: {},
            body: {},
            relationship: {},
            identity: {},
            possession: {},
            world: {},
            other: {},
            conflicts: { type: 'array' },
        },
    },
};

export const NARRATIVE_FLOOR_SYSTEM = `你是逐楼剧情记录员，不是作者。输入中的每个“楼”都是 SillyTavern 里一条独立消息，楼号是必须原样返回的绝对编号。

为每一楼生成一份结构化剧情记录，只记录该楼新表达或新发生的内容。

先按原文顺序拆出 events：每一项是一条可以独立成立的新增信息，不限于任何预设类别。
- 不要判断“是否重要”后再筛选。行动、话语、提议、选择、否定、问题、回答、发现、状态变化和未解决事项，只要语义不同就分别记录。
- 复合句中包含两项不同内容时拆成两项。例如“找地方坐，或者找食物”必须分别保留休息地点和取得食物两项。
- text 是忠实转述；evidence 必须逐字复制“剧情正文”中的连续原文，最多 120 字。没有原文证据就不许生成该事件。
- 用户楼的 text 使用“<user>”，不得写“用户”。

再按剧情时间变化把 events 放进有序 segments：
- time_change 只在该位置出现了明确剧情内时间时填写，格式为 {"label":"次日清晨","kind":"absolute|relative|time_of_day","evidence":"次日清晨"}，否则写 null。
- 一楼可以有零个、一个或多个时间变化。跨天时必须拆成多个 segment，并让变化前后的事件各自留在正确段落。
- 时间的 label 和 evidence 必须逐字来自“完整楼层原文”。允许读取其中预设附加的当前剧情时间，但禁止使用现实聊天时间、消息时间戳或自行推算日期。
- 如果完整楼层末尾明确给出新的当前剧情时间，可以生成一个 events 为空的最后 segment，表示该楼结束时的时间。

最后写一条 12–160 个汉字的 summary，概括该楼全部 events：
- 用户楼统一用“<user>”称呼用户，保留其行动、话语、问题、选择或主张；单方面说法不能写成已经证实的事实。
- 角色楼记录角色的反应、行动、披露与该楼实际推进的结果；不要把前一楼用户尚未被确认的主张偷偷升级为事实。
- 删除纯气氛、重复外貌服装、写作说明、思考过程、状态栏、预设回顾、界面组件和元话语。
- 只总结当前编号这一楼，不合并相邻楼，不滚动复述更早剧情，不编造缺失信息。

必须为输入中的每个楼号恰好返回一项，顺序一致，不得遗漏、重复或自行重新编号。
只输出 JSON：{"floors":[{"floor":0,"summary":"...","segments":[{"time_change":null,"events":[{"text":"...","evidence":"原文连续引文"}]},{"time_change":{"label":"次日清晨","kind":"relative","evidence":"次日清晨"},"events":[{"text":"...","evidence":"原文连续引文"}]}]}]}`;

export const NARRATIVE_FLOOR_JSON_SCHEMA = {
    name: 'NarrativeFloors',
    description: 'One plot-continuity summary for every visible chat message floor',
    strict: false,
    value: {
        type: 'object',
        properties: {
            floors: { type: 'array' },
        },
        required: ['floors'],
    },
};

export const CHAPTER_SYSTEM = `你是剧情档案合并员，不是作者。输入是已经逐项核验过的剧情记录，每项都有明确编号。

任务：把全部记录合并成一份连续、可独立阅读的剧情回顾，并列出便于浏览的关键事件。
- 必须阅读输入中的每一项，coverage 必须逐项覆盖全部编号，不得漏掉后半段。
- 【第 N 楼】或【第 N 轮】中的 N 是必须原样使用的绝对编号。coverage.floor 和 key_events.floor_range 只能填写输入中出现的这些编号；禁止把本章重新编号为 0–24 或 1–25。
- 通常 25 项的 summary 按剧情密度写 450–900 个汉字；如果输入明显少于 25 项，可以相应缩短但不得为了凑字重复。保留事件顺序、用户行为或话语、他人反应、因果、结果和未解决事项。
- 删除重复气氛、外貌、动作修辞和同义反复，但不能用删细节为理由漏掉决定、偏好、命令、承诺、身份、关系变化和后续安排。
- key_events 每项可覆盖连续多个编号；至少一项触及本章前半、至少一项触及本章后半。
- 输入不包含上一章正文。禁止补写、推测或把其他章节的事件写进来。
- keywords 给出 3–10 个真实出现的实体、物品、地点或稳定主题。

只输出 JSON：{"summary":"...","key_events":[{"floor_range":[0,1],"text":"..."}],"coverage":[{"floor":0,"event_index":0}],"keywords":["..."]}`;

export const HISTORY_SEGMENT_SYSTEM = `你是逐轮剧情与事实档案员，不是作者。输入包含一段连续的编号对话，每轮都同时提供用户输入和 AI 叙事正文。

必须逐轮处理：
- floors 必须恰好包含输入中的每一个编号，顺序一致，不得缺号、重复、越界或只处理开头。
- summary 用 40–220 个汉字记录该轮新增剧情，按“<user>说了什么或做了什么 → 其他角色的反应、行动或披露 → 结果或仍未解决的问题”书写。
- 即使用户只说“继续”，也要结合该轮 AI 正文说明剧情实际推进了什么。
- 只整理用户输入和叙事正文；预设摘要、状态表、思考过程、写作计划、界面文字不是新剧情。
- 删除气氛渲染、重复服装外貌、姿态细节和纯文笔修饰。

facts 只记录该轮明确发生、之后仍会成立的内容：承诺、永久身体变化、关系定性变化、身份秘密、关键持有物、世界变化或其他持久事实。
- story_time 只记录该轮原文明示的剧情内时间，格式为 {"label":"次日清晨","kind":"absolute|relative|time_of_day","evidence":"原文连续引文"}；没有就写 null，禁止自行推算日期。
- subject、value、evidence 必须非空；用户统一写作 <user>。
- topic 必须非空，并用自然语言说明具体事项，例如“右手图案”“组织内职位”“停止讨论某人”。同一人物的不同承诺或身份必须使用不同 topic，不能因为类型相同而合并。
- subject 必须是原文中真正执行动作、拥有状态或被揭露身份的对象，禁止因为整轮由用户触发就一律填写 <user>。例如“某角色阅读禁书获得力量”的 subject 应是该角色的原文姓名，而不是 <user>。
- evidence 必须逐字引用该轮用户输入或 AI 叙事正文中的连续原句，最多 50 字。
- relationship 必须同时提供 object、old_value、new_value，value 与 new_value 相同。
- world 也必须有自然主体，例如“因果契约”“防卫局”，不能留空。
- 没有持久事实时 facts 输出空数组。不得为了填表把普通动作、情绪或推测写成事实。

只输出 JSON：{"floors":[{"floor":0,"summary":"...","story_time":{"label":"次日清晨","kind":"relative","evidence":"次日清晨"},"facts":[{"slot":"promise|body|relationship|identity|possession|world|other","topic":"具体事项","subject":"...","object":"","value":"...","old_value":"","new_value":"","evidence":"...","why_persistent":"..."}]}]}`;

export const HISTORY_SEGMENT_JSON_SCHEMA = {
    name: 'HistorySegment',
    description: 'Complete per-floor history notes and persistent facts',
    strict: false,
    value: {
        type: 'object',
        properties: {
            floors: { type: 'array' },
        },
        required: ['floors'],
    },
};

export const CHAPTER_JSON_SCHEMA = {
    name: 'ChapterArchive',
    description: 'Coverage-checked chapter archive',
    strict: false,
    value: {
        type: 'object',
        properties: {
            summary: { type: 'string' },
            key_events: { type: 'array' },
            coverage: { type: 'array' },
            keywords: { type: 'array' },
        },
        required: ['summary', 'key_events', 'coverage', 'keywords'],
    },
};

export const VOLUME_SYSTEM = `你是长期剧情压缩员。将多份编号章节摘要压缩为一份约500–900字的长期回顾。
必须阅读并覆盖每一个输入章节，在 covered_chapter_ids 中逐项返回全部章节编号；必须保留「必须保留清单」中的每一个实体名称。
保留事件顺序、关键因果、身份关系变化、承诺和未解决事项，不得只概括第一章。
只输出 JSON：{"summary":"...","covered_chapter_ids":["ch_001"]}`;

export const PROOFREAD_SYSTEM = `你是状态表校对员。对照状态表与章节摘要：
1) 摘要中的持久事实，表里是否有对应条目？缺哪些？
2) 表中条目与摘要是否矛盾？
只输出 JSON：{"suggestions":[{"op":"add|update|flag","slot":"...","subject":"...","object":"","value":"...","entry_id":"","note":"..."}]}
不要直接改表；这些只是建议。`;

export const STATE_GC_SYSTEM = `你是状态表整理员。合并同类冗余条目，删除已被更新链取代的旧表述。
禁止新增事实，禁止改写尚存条目的含义或措辞（除非合并时保留原意）。
pinned 条目不得改动。
只输出 JSON：{"keep_ids":["e_0001"],"drop_ids":["e_0002"],"merged":[{"from_ids":["e_0003","e_0004"],"entry":{"slot":"...","subject":"...","object":"","value":"..."}}]}`;
