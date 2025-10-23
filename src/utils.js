// ----- Utils (مشترک) -----
export const now = () => Date.now();

export const shortId = () =>
  now().toString(36).slice(-6) +
  Math.floor(Math.random() * 2176782336).toString(36).slice(-2);

// استخراج امن دستور حتی با @username
export function getCommand(msg) {
  const text = msg?.text || "";
  const entities = msg?.entities || [];
  const cmdEnt = entities.find((e) => e.type === "bot_command" && e.offset === 0);
  if (!cmdEnt) return null;
  const raw = text.substring(cmdEnt.offset, cmdEnt.offset + cmdEnt.length).toLowerCase();
  return raw.split("@")[0]; // "/newgame" | "/start"
}

// Deep-link encoder/decoder برای chat_id گروه
export function encChatId(chatId) {
  const n = Number(chatId);
  return n < 0 ? "n" + (-n).toString(36) : "p" + n.toString(36);
}
export function decChatId(s) {
  if (!s || typeof s !== "string") return null;
  if (s[0] === "n") return -parseInt(s.slice(1), 36);
  if (s[0] === "p") return parseInt(s.slice(1), 36);
  return null;
}
