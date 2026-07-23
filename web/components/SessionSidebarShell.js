export default {
  name: 'SessionSidebarShell',
  props: {
    collapsed: { type: Boolean, default: false },
  },
  template: `
    <aside class="session-sidebar-shell" :class="{ collapsed }">
      <slot name="collapsed"></slot>
      <slot></slot>
    </aside>
  `,
};
