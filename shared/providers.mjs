/** Prefer the current service if configured, otherwise choose one that is ready. */
export function selectConfiguredProvider(current, providers) {
  if (providers[current]) return current;
  if (providers.openai) return 'openai';
  if (providers.azure) return 'azure';
  if (providers.google) return 'google';
  return current;
}
