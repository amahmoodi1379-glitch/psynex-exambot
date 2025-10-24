export const TEMPLATE_KEYS = {
  KONKOORI: "konkoori",
  TAALIFI: "taalifi",
  MIX: "mix",
};

export const ACTIVE_TEMPLATES = new Set([TEMPLATE_KEYS.KONKOORI]);
export const INACTIVE_TEMPLATES = new Set([
  TEMPLATE_KEYS.TAALIFI,
  TEMPLATE_KEYS.MIX,
]);
export const KNOWN_TEMPLATES = new Set([
  ...ACTIVE_TEMPLATES,
  ...INACTIVE_TEMPLATES,
]);
export const ALLOWED_TEMPLATES = new Set([
  TEMPLATE_KEYS.KONKOORI,
  TEMPLATE_KEYS.TAALIFI,
]);
export const TEMPLATE_DISABLED_MESSAGE = "فعلاً غیرفعال است";
