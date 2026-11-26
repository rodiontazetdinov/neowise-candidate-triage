import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../server.mjs";

let app;
let base;

before(async () => {
  app = createApp({ log: () => {} }); // настоящий имитатор mock-ai.mjs
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${app.server.address().port}`;
});

after(() => new Promise((resolve) => app.server.close(resolve)));

async function post(body) {
  const reply = await fetch(`${base}/api/triage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: reply.status, reason: reply.headers.get("x-triage-reason"), body: await reply.json() };
}

test("POST /api/triage: корректная заявка -> ready", async () => {
  const res = await post({ text: "Когда будет доставка?" });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    status: "ready",
    topic: "delivery",
    draft: "Спасибо за обращение. Уточним детали заявки.",
  });
});

test("POST /api/triage: пустой и битый ввод -> 400 invalid_input", async () => {
  for (const body of [{ text: "" }, { text: "   " }, {}, { text: 5 }, "{broken", "null", "[]"]) {
    const res = await post(body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.deepEqual(res.body, { status: "invalid_input" });
  }
});

const failures = [
  ["[timeout]", "timeout"],
  ["[error]", "model_error"],
  ["[bad-json]", "invalid_json"],
  ["[bad-topic]", "unknown_topic"],
  ["[empty-draft]", "empty_draft"],
];

for (const [mark, reason] of failures) {
  test(`POST /api/triage: ${mark} -> manual_review (${reason})`, async () => {
    const started = performance.now();
    const res = await post({ text: `Вопрос по цене ${mark}` });
    const elapsed = performance.now() - started;
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { status: "manual_review", topic: null, draft: null });
    assert.equal(res.reason, reason);
    assert.ok(elapsed < 600, `ответ за ${Math.round(elapsed)} мс, лимит модели 300 мс`);
  });
}

test("GET /api/review-queue: сбои попадают в очередь ручного разбора с причиной", async () => {
  const reply = await fetch(`${base}/api/review-queue`);
  const { items } = await reply.json();
  assert.deepEqual(
    items.map((item) => item.reason),
    failures.map(([, reason]) => reason),
  );
  assert.equal(items[0].text, "Вопрос по цене [timeout]");
});

test("GET / и /app.mjs отдаются", async () => {
  assert.equal((await fetch(`${base}/`)).status, 200);
  const js = await fetch(`${base}/app.mjs`);
  assert.equal(js.status, 200);
  assert.match(js.headers.get("content-type"), /javascript/);
});
