/** Stable non-canon message contract, including pre-split chats. No runtime dependency. */
export function isBackstageMarker(message) {
    return Boolean(message?.extra?.layered_memory_backstage_marker?.sessionId);
}
