// Zod >=4.6.6 checks explicit array bounds before parsing their elements.
// Keep full history/queue submissions practical while bounding validation work.
export const MAX_HISTORY_ITEMS = 10_000;
export const MAX_QUEUE_ITEMS = 10_000;
export const MAX_BOOTSTRAP_FILAMENTS = 1_000;
export const MAX_SUPPORTED_MATERIALS = 1_000;
