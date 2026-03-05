/**
 * SSE (Server-Sent Events) streaming utilities for Fastify
 */

import { FastifyReply } from 'fastify';

/**
 * Set up SSE headers on a Fastify reply.
 */
export function initSSE(reply: FastifyReply): void {
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
}

/**
 * Send an SSE event.
 */
export function sendSSE(reply: FastifyReply, event: string, data: any): void {
  reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * Send an SSE data-only message (default event).
 */
export function sendSSEData(reply: FastifyReply, data: any): void {
  reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
}

/**
 * End the SSE stream.
 */
export function endSSE(reply: FastifyReply): void {
  reply.raw.write('data: [DONE]\n\n');
  reply.raw.end();
}
