import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/*
 * A local HTTP server that stands in for a supplier in adapter tests (ADR 0005): each test
 * scripts the replies (recorded, sanitized fixtures) and reads back what the adapter sent.
 * Nothing calls a live supplier in tests.
 */

export interface RecordedRequest {
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
  body: string;
}

export interface ScriptedReply {
  status?: number;
  /** Serialized as JSON unless it is a string. */
  body?: unknown;
  headers?: Record<string, string>;
  /** Answer after this many milliseconds (timeouts). */
  delayMs?: number;
}

export interface FakeHttpServer {
  url: string;
  requests: RecordedRequest[];
  /** Replies to requests in order; once only one is left, it answers every later request. */
  reply(...replies: ScriptedReply[]): void;
  close(): Promise<void>;
}

export async function startFakeHttpServer(): Promise<FakeHttpServer> {
  const requests: RecordedRequest[] = [];
  let replies: ScriptedReply[] = [{ status: 200, body: {} }];

  const server: Server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      requests.push({
        method: request.method ?? 'GET',
        path: request.url ?? '/',
        headers: request.headers,
        body,
      });
      const reply = (replies.length > 1 ? replies.shift() : replies[0]) ?? {};
      const send = () => {
        if (response.destroyed) return;
        response.writeHead(reply.status ?? 200, {
          'content-type': 'application/json',
          ...reply.headers,
        });
        response.end(
          typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? {}),
        );
      };
      if (reply.delayMs) setTimeout(send, reply.delayMs);
      else send();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    reply: (...next) => {
      replies = next;
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
