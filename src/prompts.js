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

每条事实必须含 evidence：原文中的直接引文（≤50字）。引不出原句就不许填。
单条 value ≤80 字。只输出 JSON，不要其它说明。

## few-shot

### 例1（闲聊 → 全部无变化）
用户：今天天气不错。
AI：是啊，要不要去散步？
输出：
{"turn_summary":"<user>提到天气不错，另一人提议一起散步。","promise":"无变化","body":"无变化","relationship":"无变化","identity":"无变化","possession":"无变化","world":"无变化","other":"无变化","conflicts":[]}

### 例2（纯战斗描写无持久后果 → 全部无变化）
用户：我挥刀砍向他。
AI：刀锋擦过护甲溅起火星，两人拉开距离喘息。
输出：
{"turn_summary":"<user>挥刀攻击对方，刀锋被护甲挡开，双方暂时拉开距离。","promise":"无变化","body":"无变化","relationship":"无变化","identity":"无变化","possession":"无变化","world":"无变化","other":"无变化","conflicts":[]}

### 例3（关系定性变化）
用户：……我不想再看到你。
AI：艾琳把门摔上。卡尔站在书房里，冷战开始了。
输出：
{"turn_summary":"<user>明确表示不想再见卡尔，艾琳摔门离开，两人的关系转入冷战。","promise":"无变化","body":"无变化","relationship":[{"subject":"艾琳","object":"卡尔","old_value":"亲近","new_value":"冷战中","evidence":"我不想再看到你。"}],"identity":"无变化","possession":"无变化","world":"无变化","other":"无变化","conflicts":[]}

### 例4（持有物）
用户：我把母亲的银坠交给她。
AI：她接过银坠，郑重地点头。
输出：
{"turn_summary":"<user>把母亲留下的银坠交给对方，对方郑重收下。","promise":"无变化","body":"无变化","relationship":"无变化","identity":"无变化","possession":[{"subject":"她","object":"","value":"获得母亲的银坠","evidence":"我把母亲的银坠交给她。"}],"world":"无变化","other":"无变化","conflicts":[]}
`;

export const EXTRACT_JSON_SCHEMA = {
    name: 'MemoryExtract',
    description: 'Persistent fact diff for one floor',
    strict: false,
    value: {
        type: 'object',
        properties: {
            turn_summary: { type: 'string' },
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

export const CHAPTER_SYSTEM = `你是剧情档案合并员，不是作者。输入是已经逐轮核验过的剧情记录，每一轮都有明确编号。

任务：把全部轮次合并成一份连续、可独立阅读的剧情回顾，并列出便于浏览的关键事件。
- 必须阅读输入中的每一轮，coverage 必须逐项覆盖全部编号，不得漏掉后半段。
- 通常 25 轮的 summary 按剧情密度写 450–900 个汉字；如果输入明显少于 25 轮，可以相应缩短但不得为了凑字重复。保留事件顺序、用户行为或话语、他人反应、因果、结果和未解决事项。
- 删除重复气氛、外貌、动作修辞和同义反复，但不能用删细节为理由漏掉决定、偏好、命令、承诺、身份、关系变化和后续安排。
- key_events 每项可覆盖连续多轮；至少一项触及本章前半、至少一项触及本章后半。
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
- subject、value、evidence 必须非空；用户统一写作 <user>。
- subject 必须是原文中真正执行动作、拥有状态或被揭露身份的对象，禁止因为整轮由用户触发就一律填写 <user>。例如“阿尔德瑞思阅读《恶魔之书》获得力量”的 subject 是“阿尔德瑞思”。
- evidence 必须逐字引用该轮用户输入或 AI 叙事正文中的连续原句，最多 50 字。
- relationship 必须同时提供 object、old_value、new_value，value 与 new_value 相同。
- world 也必须有自然主体，例如“因果契约”“防卫局”，不能留空。
- 没有持久事实时 facts 输出空数组。不得为了填表把普通动作、情绪或推测写成事实。

只输出 JSON：{"floors":[{"floor":0,"summary":"...","facts":[{"slot":"promise|body|relationship|identity|possession|world|other","subject":"...","object":"","value":"...","old_value":"","new_value":"","evidence":"...","why_persistent":"..."}]}]}`;

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
