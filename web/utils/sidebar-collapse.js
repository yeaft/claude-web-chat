export function collapseSidebar({ isMobileView, showMobileSidebar, closeMobileSidebar, toggleSidebar }) {
  if (isMobileView && showMobileSidebar) {
    closeMobileSidebar();
    return;
  }
  toggleSidebar();
}
