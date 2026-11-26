// Логика страницы без привязки к DOM, чтобы её можно было проверить в node:test.

export const CLIENT_TIMEOUT_MS = 5_000;

export const TOPIC_LABELS = Object.freeze({
  delivery: "Доставка",
  pricing: "Цены",
  other: "Другое",
});

export const MESSAGES = Object.freeze({
  empty: "Введите текст заявки.",
  loading: "Разбираем заявку…",
  manual_review:
    "Автоматический разбор не удался. Заявка передана в ручной разбор: прочитайте её и ответьте клиенту сами.",
});

/** Состояние экрана. topic и draft есть только у статуса ready. */
export function viewState(status, extra = {}) {
  const base = { status, topic: null, draft: null, message: "" };
  if (status === "ready") return { ...base, topic: extra.topic, draft: extra.draft };
  return { ...base, message: MESSAGES[status] ?? MESSAGES.manual_review };
}

/** Превращает ответ API в состояние экрана. Любой неожиданный ответ = ручной разбор. */
export function stateFromResponse(httpStatus, body) {
  if (httpStatus === 400 && body?.status === "invalid_input") return viewState("empty");
  if (
    httpStatus === 200 &&
    body?.status === "ready" &&
    typeof body.topic === "string" &&
    typeof body.draft === "string" &&
    body.draft.trim() !== ""
  ) {
    return viewState("ready", { topic: body.topic, draft: body.draft });
  }
  return viewState("manual_review");
}

/**
 * Контроллер отправки. Каждый запрос получает растущий requestId,
 * предыдущий запрос отменяется через AbortController, а устаревший ответ
 * отбрасывается и не попадает на экран.
 */
export function createTriageController({ fetchImpl = globalThis.fetch, render, timeoutMs = CLIENT_TIMEOUT_MS }) {
  let lastRequestId = 0;
  let current = null;

  async function submit(rawText) {
    const requestId = ++lastRequestId;
    current?.abort();
    const text = typeof rawText === "string" ? rawText.trim() : "";
    if (text === "") {
      current = null;
      render(viewState("empty"));
      return;
    }

    const controller = new AbortController();
    current = controller;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    render(viewState("loading"));

    let next;
    try {
      const reply = await fetchImpl("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
        signal: controller.signal,
      });
      const body = await reply.json().catch(() => null);
      next = stateFromResponse(reply.status, body);
    } catch {
      next = viewState("manual_review");
    } finally {
      clearTimeout(timer);
    }

    if (requestId !== lastRequestId) return; // устаревший ответ
    current = null;
    render(next);
  }

  return { submit };
}

/**
 * Переносит состояние на элементы страницы. Каждый вызов перезаписывает
 * все поля, поэтому старый черновик не может остаться на экране.
 */
export function renderInto(elements, state) {
  const ready = state.status === "ready";
  elements.message.textContent = state.message;
  elements.topic.textContent = ready ? TOPIC_LABELS[state.topic] ?? state.topic : "";
  elements.draft.textContent = ready ? state.draft : "";
  elements.result.hidden = !ready;
  elements.message.dataset.status = state.status;
}
