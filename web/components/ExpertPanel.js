import {
  EXPERT_ROLES, EXPERT_TEAMS, getRolesByTeam,
  buildAutocompleteItems, getSelectionLabel, MAX_SELECTIONS, DEFAULT_TEAM
} from '../utils/expert-roles.js';

export default {
  name: 'ExpertPanel',
  emits: ['close'],
  template: `
    <div class="expert-panel" :class="{ open: visible }">
      <div class="expert-panel-header">
        <span class="expert-panel-title">{{ $t('expertPanel.title') }}</span>
        <button class="expert-panel-close" @click="$emit('close')">
          <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
        </button>
      </div>

      <!-- Search -->
      <div class="expert-panel-search">
        <input
          ref="searchInput"
          v-model="searchQuery"
          type="text"
          :placeholder="$t('expertPanel.search')"
          class="expert-search-input"
          @input="onSearchInput"
        />
        <svg v-if="!searchQuery" class="expert-search-icon" viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>
        <button v-else class="expert-search-clear" @click="searchQuery = ''">
          <svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
        </button>
      </div>

      <!-- Team Tabs -->
      <div class="expert-team-tabs">
        <button
          v-for="team in availableTeams"
          :key="team.id"
          class="expert-team-tab"
          :class="{ active: enabledTeams.has(team.id), disabled: !enabledTeams.has(team.id) }"
          @click="toggleTeam(team.id)"
          :title="team.name"
        >
          <span class="team-tab-icon">{{ team.icon }}</span>
          <span class="team-tab-name">{{ team.name }}</span>
        </button>
      </div>

      <!-- Role List -->
      <div class="expert-role-list" ref="roleListRef">
        <template v-if="searchQuery">
          <!-- Search results mode -->
          <div v-if="searchResults.length === 0" class="expert-empty-state">
            {{ $t('expertPanel.noResults') }}
          </div>
          <div
            v-for="item in searchResults"
            :key="item.roleId + (item.actionId || '')"
            class="expert-search-result"
            :class="{ selected: isSelected(item.roleId, item.actionId), disabled: isDisabled(item.roleId, item.actionId) }"
            @click="selectFromSearch(item)"
          >
            <span class="search-result-label">{{ item.displayText }}</span>
            <span class="search-result-title">{{ getRoleTitle(item.roleId) }}</span>
            <span v-if="isSelected(item.roleId, item.actionId)" class="search-result-check">
              <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
            </span>
          </div>
        </template>
        <template v-else>
          <!-- Team grouped mode -->
          <div v-for="group in filteredGroups" :key="group.teamId" class="expert-team-group">
            <div class="expert-team-header">
              <span class="team-header-icon">{{ group.team.icon }}</span>
              <span class="team-header-name">{{ group.team.name }}</span>
            </div>
            <div
              v-for="role in group.roles"
              :key="role.id"
              class="expert-role-card"
              :class="{ 'has-selection': hasRoleSelection(role.id) }"
            >
              <div class="role-card-header">
                <span
                  class="role-card-name"
                  :class="{ selected: isRoleOnlySelected(role.id), disabled: isRoleDisabled(role.id) }"
                  @click="toggleRoleOnly(role)"
                >{{ role.title }}\u00B7{{ role.name }}</span>
              </div>
              <div class="role-card-actions">
                <button
                  v-for="action in role.actions"
                  :key="action.id"
                  class="role-action-btn"
                  :class="{ selected: isSelected(role.id, action.id), disabled: isDisabled(role.id, action.id) }"
                  @click="toggleAction(role, action)"
                >{{ action.name }}</button>
              </div>
            </div>
          </div>
        </template>
      </div>

      <!-- Selected Summary (bottom) -->
      <div class="expert-panel-footer" v-if="selections.length > 0">
        <div class="expert-selected-chips">
          <span
            v-for="(sel, index) in selections"
            :key="sel.role + (sel.action || '')"
            class="expert-chip"
          >
            {{ getSelectionLabel(sel) }}
            <button class="chip-remove" @click="removeSelection(index)">&times;</button>
          </span>
        </div>
        <button class="expert-clear-all" @click="clearAll">
          {{ $t('expertPanel.clearAll') }}
        </button>
      </div>
    </div>
  `,
  props: {
    visible: { type: Boolean, default: false },
    modelValue: { type: Array, default: () => [] }
  },
  emits: ['close', 'update:modelValue'],
  setup(props, { emit }) {
    const store = Pinia.useChatStore();
    const searchQuery = Vue.ref('');
    const searchInput = Vue.ref(null);
    const roleListRef = Vue.ref(null);

    // Teams the user has enabled (loaded)
    const enabledTeams = Vue.ref(new Set([DEFAULT_TEAM]));

    // Expert selections: reactive copy from v-model
    const selections = Vue.computed(() => props.modelValue);

    // Available teams for the tab bar
    const availableTeams = Vue.computed(() => {
      return Object.values(EXPERT_TEAMS).sort((a, b) => a.order - b.order);
    });

    // Filtered groups based on enabled teams
    const filteredGroups = Vue.computed(() => {
      return getRolesByTeam().filter(g => enabledTeams.value.has(g.teamId));
    });

    // Search
    const allAutocompleteItems = buildAutocompleteItems();

    const searchResults = Vue.computed(() => {
      if (!searchQuery.value) return [];
      const q = searchQuery.value.toLowerCase();
      return allAutocompleteItems.filter(item => item.searchText.includes(q));
    });

    const onSearchInput = () => {
      // search is reactive via v-model
    };

    // Team management
    const toggleTeam = (teamId) => {
      const s = new Set(enabledTeams.value);
      if (s.has(teamId)) {
        if (s.size > 1) {
          s.delete(teamId);
          // Remove any selections from this team
          const newSelections = selections.value.filter(sel => {
            const role = EXPERT_ROLES[sel.role];
            return role && role.group !== teamId;
          });
          if (newSelections.length !== selections.value.length) {
            emit('update:modelValue', newSelections);
          }
        }
      } else {
        s.add(teamId);
      }
      enabledTeams.value = s;
    };

    // Selection logic
    const isSelected = (roleId, actionId) => {
      return selections.value.some(s => s.role === roleId && s.action === (actionId || null));
    };

    const isRoleOnlySelected = (roleId) => {
      return selections.value.some(s => s.role === roleId && !s.action);
    };

    const hasRoleSelection = (roleId) => {
      return selections.value.some(s => s.role === roleId);
    };

    const isRoleDisabled = (roleId) => {
      // Can't select if already at max and this role isn't selected
      if (selections.value.length >= MAX_SELECTIONS && !hasRoleSelection(roleId)) {
        return true;
      }
      return false;
    };

    const isDisabled = (roleId, actionId) => {
      // Already selected this exact combo
      if (isSelected(roleId, actionId)) return false;
      // Same role, different action already selected (mutual exclusion)
      if (hasRoleSelection(roleId)) return true;
      // At max selections
      if (selections.value.length >= MAX_SELECTIONS) return true;
      return false;
    };

    const getRoleTitle = (roleId) => {
      return EXPERT_ROLES[roleId]?.title || '';
    };

    const toggleRoleOnly = (role) => {
      if (isRoleOnlySelected(role.id)) {
        // Deselect
        emit('update:modelValue', selections.value.filter(s => !(s.role === role.id && !s.action)));
        return;
      }
      if (hasRoleSelection(role.id)) {
        // Replace existing selection for this role with pure role
        emit('update:modelValue', [
          ...selections.value.filter(s => s.role !== role.id),
          { role: role.id, action: null }
        ]);
        return;
      }
      if (selections.value.length >= MAX_SELECTIONS) return;
      emit('update:modelValue', [...selections.value, { role: role.id, action: null }]);
    };

    const toggleAction = (role, action) => {
      if (isSelected(role.id, action.id)) {
        // Deselect
        emit('update:modelValue', selections.value.filter(s => !(s.role === role.id && s.action === action.id)));
        return;
      }
      if (hasRoleSelection(role.id)) {
        // Same role, different action → replace
        emit('update:modelValue', [
          ...selections.value.filter(s => s.role !== role.id),
          { role: role.id, action: action.id }
        ]);
        return;
      }
      if (selections.value.length >= MAX_SELECTIONS) return;
      emit('update:modelValue', [...selections.value, { role: role.id, action: action.id }]);
    };

    const selectFromSearch = (item) => {
      if (item.actionId) {
        const role = EXPERT_ROLES[item.roleId];
        const action = role?.actions.find(a => a.id === item.actionId);
        if (role && action) {
          toggleAction(role, action);
        }
      } else {
        const role = EXPERT_ROLES[item.roleId];
        if (role) {
          toggleRoleOnly(role);
        }
      }
    };

    const removeSelection = (index) => {
      const arr = [...selections.value];
      arr.splice(index, 1);
      emit('update:modelValue', arr);
    };

    const clearAll = () => {
      emit('update:modelValue', []);
    };

    // Focus search when panel opens
    Vue.watch(() => props.visible, (val) => {
      if (val) {
        Vue.nextTick(() => {
          searchInput.value?.focus();
        });
      }
    });

    return {
      searchQuery,
      searchInput,
      roleListRef,
      enabledTeams,
      selections,
      availableTeams,
      filteredGroups,
      searchResults,
      onSearchInput,
      toggleTeam,
      isSelected,
      isRoleOnlySelected,
      hasRoleSelection,
      isRoleDisabled,
      isDisabled,
      getRoleTitle,
      toggleRoleOnly,
      toggleAction,
      selectFromSearch,
      removeSelection,
      clearAll,
      getSelectionLabel
    };
  }
};
