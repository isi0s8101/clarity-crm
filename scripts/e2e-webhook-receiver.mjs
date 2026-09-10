import { createServer } from "node:http";
import { appendFileSync } from "node:fs";

const output = process.env.HOOK_OUTPUT;
const port = Number(process.env.HOOK_PORT ?? 8790);
if (!output || !Number.isInteger(port)) process.exit(2);

const server = createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    appendFileSync(output, JSON.stringify({
      method: request.method,
      url: request.url,
      event: request.headers["x-clarity-event"] ?? null,
      delivery: request.headers["x-clarity-delivery"] ?? null,
      signature: request.headers["x-clarity-signature"] ?? null,
      body,
    }) + "\n");
    response.statusCode = 204;
    response.end();
  });
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`webhook receiver ready on ${port}\n`);
});

const stop = () => server.close(() => process.exit(0));
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
