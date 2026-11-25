/**
 * The download budget, resolved once for both the settings card and the engine.
 *
 * Result images are downloaded from a URL the provider hands back, so the cost
 * of one image is the provider's upload speed plus the user's line — neither is
 * known here. The budget is therefore a setting (seconds, as the card shows it)
 * with a hard range: below 10 s a large PNG cannot finish, above 10 min a
 * stalled connection would hold one of the four queue slots for too long.
 */

/** Default budget in seconds, and the range the engine guarantees. */
export const DEFAULT_DOWNLOAD_TIMEOUT_SECONDS = 60
export const MIN_DOWNLOAD_TIMEOUT_SECONDS = 10
export const MAX_DOWNLOAD_TIMEOUT_SECONDS = 600

/**
 * Effective budget for downloading one result image.
 *
 * Values arrive as numbers through the settings schema, but a document written
 * by an older build (or edited by hand) can carry a numeric string, so both are
 * accepted; anything unusable falls back to the default instead of failing a
 * generation.
 * @param value - the raw `downloadTimeoutSeconds` setting.
 * @returns milliseconds inside {@link MIN_DOWNLOAD_TIMEOUT_SECONDS}–{@link MAX_DOWNLOAD_TIMEOUT_SECONDS}.
 */
export function effectiveDownloadTimeoutMs(value: unknown): number {
  const seconds = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== ''
      ? Number(value)
      : Number.NaN
  const clamped = Number.isFinite(seconds)
    ? Math.min(MAX_DOWNLOAD_TIMEOUT_SECONDS, Math.max(MIN_DOWNLOAD_TIMEOUT_SECONDS, Math.round(seconds)))
    : DEFAULT_DOWNLOAD_TIMEOUT_SECONDS
  return clamped * 1000
}
