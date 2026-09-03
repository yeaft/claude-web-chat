import TerminalTab from './TerminalTab.js';
import GitStatusTab from './GitStatusTab.js';
import FilesTab from './FilesTab.js';

const TOOL_COMPONENTS = Object.freeze({
  terminal: 'TerminalTab',
  git: 'GitStatusTab',
  files: 'FilesTab',
});

export default {
  name: 'WorkbenchCapabilityHost',
  components: { TerminalTab, GitStatusTab, FilesTab },
  props: {
    activeCapability: { type: String, default: null },
    retainedCapabilities: { type: Array, default: () => [] },
    routeProps: { type: Object, required: true },
  },
  template: `
    <KeepAlive :max="3" :include="retainedComponentNames">
      <component
        :is="activeComponent"
        v-if="activeComponent"
        :key="activeCapability"
        v-bind="routeProps"
      />
    </KeepAlive>
  `,
  setup(props) {
    const activeComponent = Vue.computed(() => TOOL_COMPONENTS[props.activeCapability] || null);
    const retainedComponentNames = Vue.computed(() => (
      props.retainedCapabilities.map(capability => TOOL_COMPONENTS[capability]?.name).filter(Boolean)
    ));
    return { activeComponent, retainedComponentNames };
  },
};
