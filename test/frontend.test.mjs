import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { createTriageController, renderInto } from "../public/app.mjs";

function jsonReply(status, body) {
  return { status, json: async () => body };
}

const ready = (draft) => jsonReply(200, { status: "ready", topic: "delivery", draft });
const manual = () => jsonReply(200, { status: "manual_review", topic: null, draft: null });

function fakeElements() {
  return {
    message: { textContent: "", dataset: {} },
    topic: { textContent: "" },
    draft: { textContent: "" },
    result: { hidden: true },
  };
}

function setup(fetchImpl) {
  const elements = fakeElements();
  const states = [];
  const controller = createTriageController({
    fetchImpl,
    render: (state) => {
      states.push(state);
      renderInto(elements, state);
    },
  });
  return { elements, states, controller };
}

test("пустой ввод не уходит на сервер", async () => {
  let calls = 0;
  const { elements, controller } = setup(async () => (calls++, ready("x")));
  await controller.submit("   ");
  assert.equal(calls, 0);
  assert.equal(elements.message.dataset.status, "empty");
});

test("при сбое предыдущий черновик стирается с экрана", async () => {
  const replies = [ready("Старый черновик"), manual()];
  const { elements, controller } = setup(async () => replies.shift());

  await controller.submit("первая заявка");
  assert.equal(elements.draft.textContent, "Старый черновик");
  assert.equal(elements.result.hidden, false);

  await controller.submit("вторая заявка");
  assert.equal(elements.draft.textContent, "");
  assert.equal(elements.topic.textContent, "");
  assert.equal(elements.result.hidden, true);
  assert.equal(elements.message.dataset.status, "manual_review");
});

test("сетевая ошибка и неожиданный ответ тоже ведут в ручной разбор без черновика", async () => {
  const replies = [
    () => ready("Черновик"),
    () => {
      throw new TypeError("network down");
    },
    () => ready("   "),
    () => jsonReply(500, { status: "server_error" }),
  ];
  const { elements, controller } = setup(async () => replies.shift()());
  await controller.submit("a");
  for (const text of ["b", "c", "d"]) {
    await controller.submit(text);
    assert.equal(elements.draft.textContent, "", text);
    assert.equal(elements.message.dataset.status, "manual_review", text);
  }
});

test("гонка: первый ответ через 500 мс, второй сразу, на экране остаётся второй", async () => {
  const fetchImpl = async (_url, { body }) => {
    const { text } = JSON.parse(body);
    if (text === "первая") {
      await delay(500); // намеренно не слушаем signal: устаревший ответ всё равно должен быть отброшен
      return ready("Ответ на первую");
    }
    return ready("Ответ на вторую");
  };
  const { elements, states, controller } = setup(fetchImpl);

  const first = controller.submit("первая");
  const second = controller.submit("вторая");
  await Promise.all([first, second]);

  assert.equal(elements.draft.textContent, "Ответ на вторую");
  assert.ok(!states.some((s) => s.draft === "Ответ на первую"), "устаревший ответ не рендерился");
});

test("зависший запрос обрывается клиентским таймаутом и ведёт в ручной разбор", async () => {
  const fetchImpl = (_url, { signal }) =>
    new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
  const elements = fakeElements();
  const controller = createTriageController({ fetchImpl, timeoutMs: 50, render: (s) => renderInto(elements, s) });
  await controller.submit("заявка");
  assert.equal(elements.message.dataset.status, "manual_review");
  assert.equal(elements.draft.textContent, "");
});
