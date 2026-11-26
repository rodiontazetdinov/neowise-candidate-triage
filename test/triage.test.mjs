import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTriageInput, triage, validateModelOutput } from "../lib/triage.mjs";

const good = JSON.stringify({ topic: "delivery", draft: "Спасибо, проверим доставку." });

test("parseTriageInput: пустой, пробельный, нестроковый и битый ввод отклоняются", () => {
  for (const raw of ["", "not json", "null", "[]", "{}", '{"text":""}', '{"text":"   \\n\\t"}', '{"text":42}']) {
    assert.equal(parseTriageInput(raw), null, raw);
  }
  assert.equal(parseTriageInput('{"text":"  Где заказ?  "}'), "Где заказ?");
});

test("validateModelOutput: схема ответа модели", () => {
  assert.deepEqual(validateModelOutput(good), { ok: true, topic: "delivery", draft: "Спасибо, проверим доставку." });
  assert.equal(validateModelOutput("not json").reason, "invalid_json");
  assert.equal(validateModelOutput("[1]").reason, "invalid_shape");
  assert.equal(validateModelOutput('{"topic":"refund","draft":"x"}').reason, "unknown_topic");
  assert.equal(validateModelOutput('{"topic":"other","draft":"  "}').reason, "empty_draft");
  assert.equal(validateModelOutput('{"topic":"other"}').reason, "empty_draft");
});

test("triage: один повтор после сбоя модели, второй ответ принимается", async () => {
  let calls = 0;
  const classify = async () => (++calls === 1 ? "garbage" : good);
  const result = await triage("текст", { classify });
  assert.equal(calls, 2);
  assert.equal(result.attempts, 2);
  assert.equal(result.reason, null);
  assert.equal(result.response.status, "ready");
});

test("triage: после двух неудачных попыток manual_review с причиной", async () => {
  let calls = 0;
  const classify = async () => {
    calls += 1;
    return JSON.stringify({ topic: "other", draft: "" });
  };
  const result = await triage("текст", { classify });
  assert.equal(calls, 2);
  assert.equal(result.reason, "empty_draft");
  assert.deepEqual(result.response, { status: "manual_review", topic: null, draft: null });
});

test("triage: модель, игнорирующая signal, всё равно обрывается по таймауту", async () => {
  const classify = () => new Promise((resolve) => setTimeout(() => resolve(good), 1_000));
  const started = performance.now();
  const result = await triage("текст", { classify, timeoutMs: 50 });
  const elapsed = performance.now() - started;
  assert.equal(result.reason, "timeout");
  assert.equal(result.attempts, 1, "таймаут не повторяется");
  assert.ok(elapsed < 300, `ждали ${elapsed} мс`);
});
