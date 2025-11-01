export const TELEGRAM_CALLBACK_DATA_LIMIT = 64;

export function assertCallbackWithinLimit(value, context = "callback") {
  if (typeof value !== "string") return;
  const encoder = typeof TextEncoder === "function" ? new TextEncoder() : null;
  const byteLength = encoder ? encoder.encode(value).length : Buffer.byteLength(value, "utf8");
  if (byteLength > TELEGRAM_CALLBACK_DATA_LIMIT) {
    throw new Error(
      `${context} callback_data exceeds ${TELEGRAM_CALLBACK_DATA_LIMIT} bytes (${byteLength})`
    );
  }
  return byteLength;
}
