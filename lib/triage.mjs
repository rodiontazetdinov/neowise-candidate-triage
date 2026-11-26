// Логика разбора заявки без HTTP: проверка ввода, вызов модели с таймаутом,
// проверка ответа модели по схеме и один повтор при сбое.

export const TOPICS = Object.freeze(["delivery", "pricing", "other"]);
export const MODEL_TIMEOUT_MS = 300;
export const MAX_TEXT_LENGTH = 10_000;

export const MANUAL_REVIEW = Object.freeze({ status: "manual_review", topic: null, draft: null });

/** Разбирает сырое тело запроса. Возвращает текст заявки или null, если ввод некорректен. */
export function parseTriageInput(rawBody) {
  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const { text } = payload;
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (trimmed === "" || trimmed.length > MAX_TEXT_LENGTH) return null;
  return trimmed;
}

/**
 * Проверяет ответ модели по схеме { topic: одна из TOPICS, draft: непустая строка }.
 * Возвращает { ok: true, topic, draft } или { ok: false, reason }.
 */
export function validateModelOutput(raw) {
  if (typeof raw !== "string") return { ok: false, reason: "invalid_json" };
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, reason: "invalid_shape" };
  }
  if (!TOPICS.includes(data.topic)) return { ok: false, reason: "unknown_topic" };
  if (typeof data.draft !== "string" || data.draft.trim() === "") {
    return { ok: false, reason: "empty_draft" };
  }
  return { ok: true, topic: data.topic, draft: data.draft };
}

class ModelTimeoutError extends Error {}

/**
 * Вызывает модель не дольше timeoutMs суммарно на все попытки.
 * Ошибку или неподходящий ответ повторяет один раз (retries), таймаут не повторяет:
 * бюджет ожидания уже исчерпан.
 * Возвращает { response, reason, attempts }; reason === null при успехе.
 */
export async function triage(text, { classify, timeoutMs = MODEL_TIMEOUT_MS, retries = 1 } = {}) {
  const controller = new AbortController();
  let onAbort;
  const deadline = new Promise((_, reject) => {
    onAbort = () => reject(new ModelTimeoutError("model timeout"));
    controller.signal.addEventListener("abort", onAbort, { once: true });
  });
  deadline.catch(() => {});
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let reason = "model_error";
  let attempts = 0;
  try {
    while (attempts <= retries && !controller.signal.aborted) {
      attempts += 1;
      try {
        // Promise.race нужен на случай, если модель игнорирует signal.
        const raw = await Promise.race([classify(text, { signal: controller.signal }), deadline]);
        const checked = validateModelOutput(raw);
        if (checked.ok) {
          return {
            response: { status: "ready", topic: checked.topic, draft: checked.draft },
            reason: null,
            attempts,
          };
        }
        reason = checked.reason;
      } catch (error) {
        if (error instanceof ModelTimeoutError || controller.signal.aborted) {
          reason = "timeout";
          break;
        }
        reason = "model_error";
      }
    }
    return { response: { ...MANUAL_REVIEW }, reason, attempts };
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener("abort", onAbort);
  }
}

/** Очередь ручного разбора в памяти процесса. Хранит последние limit записей. */
export function createReviewQueue({ limit = 100, now = () => new Date() } = {}) {
  const items = [];
  let nextId = 1;
  return {
    add(text, reason) {
      const item = { id: nextId++, text, reason, createdAt: now().toISOString() };
      items.push(item);
      if (items.length > limit) items.shift();
      return item;
    },
    list() {
      return items.map((item) => ({ ...item }));
    },
  };
}
