/** Compatibility for persisted previews: age alone no longer disables facts.
 * Legacy archive arrays remain intact for branch replay and manual restoration.
 */
export function applyDormancyPolicy(data, decisions = []) {
    return decisions.map(decision => decision?.verdict === 'dormant' ? {
        ...decision,
        verdict: 'keep',
        reason: '已取消休眠分类；没有明确失效证据，继续启用。',
    } : decision);
}
