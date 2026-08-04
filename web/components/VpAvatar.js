/**
 * VpAvatar — VP head circle.
 *
 * Visual stack (back → front):
 *   1. Zodiac-inspired gradient disk (background of `.vp-avatar`, inline `:style`)
 *   2. Motif glyph + display initial. VP identity is text-only; this component
 *      must not probe optional portrait assets or create network requests.
 *   3. Status dot (online/busy) OR typing badge (task-708) — pinned to
 *      bottom-right, never both at once (status wins).
 *
 * Props:
 *   vpId      — required; lookup key into vp store
 *   size      — px diameter (default 20). 14 chip / 20 bubble / 24 sidebar / 32 detail / 48 hero
 *   status    — 'online' | 'busy' | null
 *   typing    — bool. See task-708 — bottom-right typing badge.
 *   ariaLabel — optional; falls back to displayName
 */
import { useVpStore } from '../stores/vp.js';

export default {
  name: 'VpAvatar',
  props: {
    vpId: { type: String, required: true },
    size: { type: Number, default: 20 },
    status: { type: String, default: null },
    typing: { type: Boolean, default: false },
    ariaLabel: { type: String, default: '' },
  },
  template: `
    <span
      class="vp-avatar"
      :class="{ 'is-busy': status === 'busy', 'is-online': status === 'online', 'is-typing': typing && !status }"
      :style="avatarStyle"
      :aria-label="ariaLabel || displayName"
      role="img"
    >
      <span class="vp-avatar-letter" :data-motif="motifKey" aria-hidden="true">
        <span class="vp-avatar-motif-glyph">{{ motifGlyph }}</span>
        <span class="vp-avatar-initial">{{ initial }}</span>
      </span>
      <span
        v-if="status === 'online' || status === 'busy'"
        class="vp-avatar-status-dot"
        :class="'status-' + status"
      ></span>
      <span
        v-else-if="typing"
        class="vp-avatar-typing-badge"
        aria-hidden="true"
      >
        <span class="vp-avatar-typing-dot"></span>
        <span class="vp-avatar-typing-dot"></span>
        <span class="vp-avatar-typing-dot"></span>
      </span>
    </span>
  `,
  setup(props) {
    const store = useVpStore();
    const initial = Vue.computed(() => store.vpInitial(props.vpId));
    const displayName = Vue.computed(() => store.vpLabel(props.vpId));
    const motif = Vue.computed(() => {
      const fn = store.vpAvatarMotif;
      return typeof fn === 'function'
        ? fn(props.vpId)
        : {
          key: 'rat',
          glyph: 'R',
          background: 'linear-gradient(135deg, #174EA6 0%, #0B2F6B 100%)',
          foreground: '#FFFFFF',
        };
    });
    const color = Vue.computed(() => {
      const fn = store.vpColor;
      return typeof fn === 'function' ? fn(props.vpId) : motif.value.background;
    });
    const motifKey = Vue.computed(() => motif.value.key);
    const motifGlyph = Vue.computed(() => motif.value.glyph);
    const motifColor = Vue.computed(() => motif.value.foreground);
    const avatarStyle = Vue.computed(() => ({
      width: props.size + 'px',
      height: props.size + 'px',
      background: color.value,
      color: motifColor.value,
      fontSize: Math.max(13, Math.round(props.size * 0.58)) + 'px',
    }));
    return {
      initial,
      displayName,
      avatarStyle,
      motifKey,
      motifGlyph,
    };
  },
};
