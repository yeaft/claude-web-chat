export function shouldCloseLlmConfigAfterSave(result = {}) {
  return !result?.warning;
}
