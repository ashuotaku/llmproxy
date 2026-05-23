'use strict';

require('dotenv').config();

const crypto = require('node:crypto');
const Fastify = require('fastify');
const cors = require('@fastify/cors');
const { request: undiciRequest } = require('undici');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const BODY_LIMIT_BYTES = Number(process.env.BODY_LIMIT_BYTES || 10 * 1024 * 1024);
const HEADERS_TIMEOUT_MS = Number(process.env.HEADERS_TIMEOUT_MS || 300000);
const BODY_TIMEOUT_MS = Number(process.env.BODY_TIMEOUT_MS || 0);

const PROXY_API_KEY = process.env.PROXY_API_KEY || '';
const UPSTREAM_BASE_URL = normaliseBaseUrl(process.env.UPSTREAM_BASE_URL || '');
const UPSTREAM_API_KEY = process.env.UPSTREAM_API_KEY || '';
const UPSTREAM_ORGANIZATION = process.env.UPSTREAM_ORGANIZATION || '';
const UPSTREAM_PROJECT = process.env.UPSTREAM_PROJECT || '';
const UPSTREAM_EXTRA_HEADERS = parseExtraHeaders(process.env.UPSTREAM_EXTRA_HEADERS || '{}');

const HOP_BY_HOP_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length'
]);

const fastify = Fastify({
  logger: {
    level: LOG_LEVEL
  },
  bodyLimit: BODY_LIMIT_BYTES
});

fastify.register(cors, {
  origin: parseCorsOrigin(process.env.CORS_ORIGIN || ''),
  credentials: String(process.env.CORS_CREDENTIALS || 'false').toLowerCase() === 'true'
});

fastify.addHook('preHandler', async (request, reply) => {
  if (request.url === '/health') {
    return;
  }

  if (!PROXY_API_KEY) {
    return;
  }

  const authHeader = getHeader(request.headers, 'authorization') || '';
  const token = extractBearerToken(authHeader);

  if (!token || !safeEqual(token, PROXY_API_KEY)) {
    return reply.code(401).send({
      error: {
        message: 'Unauthorized. Provide a valid Bearer token.',
        type: 'invalid_request_error',
        code: 'invalid_api_key'
      }
    });
  }
});

fastify.get('/health', async () => {
  return {
    status: 'ok',
    service: 'openai-compatible-api-proxy'
  };
});

fastify.post('/v1/chat/completions', async (request, reply) => {
  return proxyToUpstream(request, reply, '/v1/chat/completions');
});

fastify.post('/v1/embeddings', async (request, reply) => {
  return proxyToUpstream(request, reply, '/v1/embeddings');
});

fastify.get('/v1/models', async (request, reply) => {
  return proxyToUpstream(request, reply, '/v1/models');
});

fastify.all('/v1/*', async (request, reply) => {
  return reply.code(404).send({
    error: {
      message: `Endpoint not configured on proxy: ${request.method} ${request.url}`,
      type: 'invalid_request_error',
      code: 'endpoint_not_found'
    }
  });
});

fastify.setErrorHandler((error, request, reply) => {
  request.log.error({ error }, 'Request failed');

  if (reply.sent) {
    return;
  }

  return reply.code(error.statusCode || 500).send({
    error: {
      message: error.message || 'Internal server error',
      type: 'proxy_error',
      code: 'internal_error'
    }
  });
});

async function proxyToUpstream(clientRequest, reply, upstreamPath) {
  const targetUrl = buildTargetUrl(upstreamPath, clientRequest.url);
  const method = clientRequest.method;
  const headers = buildUpstreamHeaders(clientRequest.headers);
  const body = shouldSendBody(method) ? serialiseBody(clientRequest.body) : undefined;

  if (body !== undefined && !headers['content-type']) {
    headers['content-type'] = getHeader(clientRequest.headers, 'content-type') || 'application/json';
  }

  try {
    const upstreamResponse = await undiciRequest(targetUrl, {
      method,
      headers,
      body,
      headersTimeout: HEADERS_TIMEOUT_MS,
      bodyTimeout: BODY_TIMEOUT_MS
    });

    reply.code(upstreamResponse.statusCode);
    setDownstreamHeaders(reply, upstreamResponse.headers);

    return reply.send(upstreamResponse.body);
  } catch (error) {
    clientRequest.log.error({ error, targetUrl }, 'Upstream request failed');

    if (reply.sent) {
      return;
    }

    return reply.code(502).send({
      error: {
        message: 'Upstream request failed',
        type: 'proxy_error',
        code: 'upstream_request_failed'
      }
    });
  }
}

function buildTargetUrl(upstreamPath, originalRequestUrl) {
  const localUrl = new URL(originalRequestUrl, 'http://localhost');
  const baseUrl = new URL(UPSTREAM_BASE_URL);
  const basePath = baseUrl.pathname.replace(/\/+$/, '');
  const baseAlreadyHasV1 = basePath === '/v1' || basePath.endsWith('/v1');

  const pathToAppend = baseAlreadyHasV1 && upstreamPath.startsWith('/v1/')
    ? upstreamPath.slice('/v1'.length)
    : upstreamPath;

  return `${UPSTREAM_BASE_URL}${pathToAppend}${localUrl.search}`;
}

function buildUpstreamHeaders(incomingHeaders) {
  const headers = {
    accept: getHeader(incomingHeaders, 'accept') || 'application/json',
    'accept-encoding': 'identity'
  };

  const userAgent = getHeader(incomingHeaders, 'user-agent');
  if (userAgent) {
    headers['user-agent'] = userAgent;
  }

  const openaiBeta = getHeader(incomingHeaders, 'openai-beta');
  if (openaiBeta) {
    headers['openai-beta'] = openaiBeta;
  }

  if (UPSTREAM_API_KEY) {
    headers.authorization = `Bearer ${UPSTREAM_API_KEY}`;
  }

  if (UPSTREAM_ORGANIZATION) {
    headers['openai-organization'] = UPSTREAM_ORGANIZATION;
  }

  if (UPSTREAM_PROJECT) {
    headers['openai-project'] = UPSTREAM_PROJECT;
  }

  return {
    ...headers,
    ...UPSTREAM_EXTRA_HEADERS
  };
}

function setDownstreamHeaders(reply, upstreamHeaders) {
  for (const [key, value] of Object.entries(upstreamHeaders)) {
    const lowerKey = key.toLowerCase();

    if (HOP_BY_HOP_RESPONSE_HEADERS.has(lowerKey)) {
      continue;
    }

    reply.header(key, value);
  }
}

function serialiseBody(body) {
  if (body === undefined || body === null) {
    return undefined;
  }

  if (Buffer.isBuffer(body)) {
    return body;
  }

  if (typeof body === 'string') {
    return body;
  }

  return JSON.stringify(body);
}

function shouldSendBody(method) {
  return method !== 'GET' && method !== 'HEAD';
}

function getHeader(headers, name) {
  const value = headers[name.toLowerCase()];

  if (Array.isArray(value)) {
    return value.join(', ');
  }

  return value;
}

function extractBearerToken(authHeader) {
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function safeEqual(actual, expected) {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);

  if (actualBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function normaliseBaseUrl(value) {
  if (!value) {
    return '';
  }

  const parsed = new URL(value);
  return parsed.toString().replace(/\/+$/, '');
}

function parseCorsOrigin(value) {
  if (!value) {
    return false;
  }

  if (value === '*') {
    return true;
  }

  return value
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function parseExtraHeaders(value) {
  let parsed;

  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error('UPSTREAM_EXTRA_HEADERS must be valid JSON');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('UPSTREAM_EXTRA_HEADERS must be a JSON object');
  }

  const headers = {};

  for (const [key, headerValue] of Object.entries(parsed)) {
    if (typeof headerValue !== 'string') {
      throw new Error('UPSTREAM_EXTRA_HEADERS values must be strings');
    }

    headers[key.toLowerCase()] = headerValue;
  }

  return headers;
}

function validateConfig() {
  if (!UPSTREAM_BASE_URL) {
    throw new Error('UPSTREAM_BASE_URL is required');
  }
}

async function start() {
  validateConfig();

  await fastify.listen({
    port: PORT,
    host: HOST
  });
}

start().catch((error) => {
  fastify.log.error(error);
  process.exit(1);
});
