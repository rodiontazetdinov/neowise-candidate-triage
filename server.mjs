import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { classify as mockClassify } from "./mock-ai.mjs";
import {
  MAX_TEXT_LENGTH,
  MODEL_TIMEOUT_MS,
  createReviewQueue,
  parseTriageInput,
  triage,
} from "./lib/triage.mjs";

const MAX_BODY_BYTES = MAX_TEXT_LENGTH * 4 + 1024;

const staticFiles = {
  "/": { file: "./index.html", type: "text/html; charset=utf-8" },
  "/app.mjs": { file: "./public/app.mjs", type: "text/javascript; charset=utf-8" },
};

function json(response, status, body, headers = {}) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...headers });
  response.end(JSON.stringify(body));
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function createApp({
  classify = mockClassify,
  timeoutMs = MODEL_TIMEOUT_MS,
  reviewQueue = createReviewQueue(),
  log = (line) => console.warn(line),
} = {}) {
  async function handleTriage(request, response) {
    const raw = await readBody(request);
    const text = raw === null ? null : parseTriageInput(raw);
    if (text === null) return json(response, 400, { status: "invalid_input" });

    const { response: body, reason, attempts } = await triage(text, { classify, timeoutMs });
    if (reason) {
      const item = reviewQueue.add(text, reason);
      log(`manual_review id=${item.id} reason=${reason} attempts=${attempts}`);
      return json(response, 200, body, { "X-Triage-Reason": reason });
    }
    return json(response, 200, body);
  }

  const server = createServer(async (request, response) => {
    const { pathname } = new URL(request.url, "http://localhost");
    try {
      if (request.method === "GET" && staticFiles[pathname]) {
        const { file, type } = staticFiles[pathname];
        response.writeHead(200, { "Content-Type": type });
        response.end(await readFile(new URL(file, import.meta.url)));
        return;
      }
      if (request.method === "GET" && pathname === "/api/review-queue") {
        return json(response, 200, { items: reviewQueue.list() });
      }
      if (request.method === "POST" && pathname === "/api/triage") {
        return await handleTriage(request, response);
      }
      return json(response, 404, { status: "not_found" });
    } catch (error) {
      log(`server_error ${error?.message}`);
      if (!response.headersSent) json(response, 500, { status: "server_error" });
      else response.end();
    }
  });
  return { server, reviewQueue };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 3000);
  createApp().server.listen(port, "127.0.0.1", () => {
    console.log(`Сервер: http://127.0.0.1:${port}`);
  });
}
