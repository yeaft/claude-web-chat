export default {
  name: 'MessageItem',
  props: {
    message: {
      type: Object,
      required: true
    }
  },
  template: `
    <div :class="messageClass">
      <!-- User message -->
      <template v-if="message.type === 'user'">
        <div class="message-content" v-if="message.content">{{ message.content }}</div>
        <!-- Attachments indicator -->
        <div class="user-attachments-indicator" v-if="message.attachments && message.attachments.length > 0">
          <span class="attachments-badge" @click="toggleAttachments">
            <span class="badge-icon">📎</span>
            <span class="badge-text">{{ getAttachmentsText(message.attachments) }}</span>
            <span class="badge-toggle" :class="{ expanded: showAttachments }">
              <svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z"/></svg>
            </span>
          </span>
        </div>
        <!-- Expanded attachments preview -->
        <div class="user-attachments" v-if="message.attachments && message.attachments.length > 0 && showAttachments">
          <div
            v-for="(attachment, index) in message.attachments"
            :key="index"
            class="user-attachment-item"
            :class="{ 'is-image': attachment.isImage }"
          >
            <img
              v-if="attachment.isImage && attachment.preview"
              :src="attachment.preview"
              :alt="attachment.name"
              class="user-attachment-image"
              @click="openImagePreview(attachment.preview)"
            />
            <div v-else class="user-attachment-file">
              <span class="file-icon">{{ getFileIcon(attachment.mimeType) }}</span>
              <span class="file-name">{{ attachment.name }}</span>
            </div>
          </div>
        </div>
      </template>

      <!-- System message -->
      <template v-else-if="message.type === 'system'">
        {{ message.content }}
      </template>

      <!-- Error message -->
      <template v-else-if="message.type === 'error'">
        {{ message.content }}
      </template>
    </div>
  `,
  setup(props) {
    const showAttachments = Vue.ref(false);
    const t = Vue.inject('t');

    const messageClass = Vue.computed(() => {
      return ['message', props.message.type];
    });

    const toggleAttachments = () => {
      showAttachments.value = !showAttachments.value;
    };

    const getAttachmentsText = (attachments) => {
      if (!attachments || attachments.length === 0) return '';
      const imageCount = attachments.filter(a => a.isImage).length;
      const fileCount = attachments.length - imageCount;
      const parts = [];
      if (imageCount > 0) parts.push(t('message.imageCount', { count: imageCount }));
      if (fileCount > 0) parts.push(t('message.fileCount', { count: fileCount }));
      return parts.join(t('common.comma'));
    };

    const getFileIcon = (mimeType) => {
      if (!mimeType) return '📄';
      if (mimeType.startsWith('image/')) return '🖼️';
      if (mimeType.startsWith('video/')) return '🎬';
      if (mimeType.startsWith('audio/')) return '🎵';
      if (mimeType.includes('pdf')) return '📕';
      if (mimeType.includes('word') || mimeType.includes('document')) return '📝';
      if (mimeType.includes('sheet') || mimeType.includes('excel')) return '📊';
      if (mimeType.includes('presentation') || mimeType.includes('powerpoint')) return '📽️';
      if (mimeType.includes('zip') || mimeType.includes('compressed') || mimeType.includes('archive')) return '📦';
      if (mimeType.includes('text') || mimeType.includes('json') || mimeType.includes('xml')) return '📃';
      return '📄';
    };

    const openImagePreview = (src) => {
      window.open(src, '_blank');
    };

    return {
      messageClass,
      showAttachments,
      toggleAttachments,
      getAttachmentsText,
      getFileIcon,
      openImagePreview
    };
  }
};
