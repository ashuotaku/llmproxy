'use strict';

require('dotenv').config();

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Transform } = require('node:stream');
const Fastify = require('fastify');
const cors = require('@fastify/cors');
const { request: undiciRequest } = require('undici');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const LOG_FILE_PATH = process.env.LOG_FILE_PATH === undefined
  ? 'logs/proxy.log'
  : process.env.LOG_FILE_PATH.trim();
const BODY_LIMIT_BYTES = Number(process.env.BODY_LIMIT_BYTES || 10 * 1024 * 1024);
const HEADERS_TIMEOUT_MS = Number(process.env.HEADERS_TIMEOUT_MS || 300000);
const BODY_TIMEOUT_MS = Number(process.env.BODY_TIMEOUT_MS || 0);
const STREAMING_ENABLED = parseBoolean(process.env.STREAMING_ENABLED, true);
const REQUEST_RESPONSE_LOGGING = parseBoolean(process.env.REQUEST_RESPONSE_LOGGING, true);
const LOG_BODY_CONTENT = parseBoolean(process.env.LOG_BODY_CONTENT, true);
const LOG_MAX_BODY_CHARS = toPositiveInteger(process.env.LOG_MAX_BODY_CHARS || '20000', 20000);
const NORMALISE_STREAMING_REASONING = parseBoolean(process.env.NORMALISE_STREAMING_REASONING, true);
const STRIP_STREAMING_REASONING = parseBoolean(process.env.STRIP_STREAMING_REASONING, false);

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

const STREAMING_REQUEST_HEADERS = new Set([
  'cache-control',
  'x-accel-buffering'
]);

const SENSITIVE_HEADERS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'proxy-authorization',
  'x-api-key',
  'api-key',
  'openai-api-key'
]);

initialiseLogFile();

const fastify = Fastify({
  logger: false,
  disableRequestLogging: true,
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
    writeImportantLog('WARN', 'Unauthorized request', {
      requestId: request.id,
      method: request.method,
      url: request.url,
      remoteAddress: request.ip
    });

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
  writeImportantLog('WARN', 'Endpoint not configured', {
    requestId: request.id,
    method: request.method,
    url: request.url
  });

  return reply.code(404).send({
    error: {
      message: `Endpoint not configured on proxy: ${request.method} ${request.url}`,
      type: 'invalid_request_error',
      code: 'endpoint_not_found'
    }
  });
});

fastify.setErrorHandler((error, request, reply) => {
  writeImportantLog('ERROR', 'Request failed', {
    requestId: request.id,
    method: request.method,
    url: request.url,
    error: createErrorLogValue(error)
  });

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
  const startedAtNs = process.hrtime.bigint();
  const targetUrl = buildTargetUrl(upstreamPath, clientRequest.url);
  const method = clientRequest.method;
  const streamingForcedOff = shouldForceNonStreaming(upstreamPath);
  const clientStreamRequested = isStreamRequested(clientRequest.body);
  const upstreamRequestBody = shouldSendBody(method)
    ? createUpstreamRequestBody(clientRequest.body, upstreamPath)
    : undefined;
  const body = shouldSendBody(method) ? serialiseBody(upstreamRequestBody) : undefined;
  const headers = buildUpstreamHeaders(clientRequest.headers, {
    upstreamPath,
    streamingForcedOff
  });

  if (body !== undefined && !headers['content-type']) {
    headers['content-type'] = getHeader(clientRequest.headers, 'content-type') || 'application/json';
  }

  logProxyRequest(clientRequest, targetUrl, body, {
    streamingForcedOff,
    clientStreamRequested,
    upstreamStreamRequested: isStreamRequested(upstreamRequestBody)
  });

  try {
    const upstreamResponse = await undiciRequest(targetUrl, {
      method,
      headers,
      body,
      headersTimeout: HEADERS_TIMEOUT_MS,
      bodyTimeout: BODY_TIMEOUT_MS
    });

    if (shouldTryEmulatedStreamingResponse({
      upstreamPath,
      streamingForcedOff,
      clientStreamRequested,
      statusCode: upstreamResponse.statusCode
    })) {
      return sendBufferedChatCompletionResponse({
        upstreamResponse,
        clientRequest,
        reply,
        targetUrl,
        startedAtNs
      });
    }

    reply.code(upstreamResponse.statusCode);
    setDownstreamHeaders(reply, upstreamResponse.headers);

    let upstreamBodyForReply = upstreamResponse.body;

    if (upstreamBodyForReply && shouldNormaliseStreamingChatCompletionResponse({
      upstreamPath,
      streamingForcedOff,
      clientStreamRequested,
      statusCode: upstreamResponse.statusCode
    })) {
      const compatibilityTransform = createChatCompletionStreamCompatibilityTransform(
        clientRequest,
        targetUrl,
        startedAtNs
      );

      upstreamResponse.body.on('error', (error) => {
        compatibilityTransform.destroy(error);
      });

      upstreamBodyForReply = upstreamResponse.body.pipe(compatibilityTransform);
    }

    const responseBody = createLoggedResponseStream(
      upstreamBodyForReply,
      clientRequest,
      targetUrl,
      upstreamResponse.statusCode,
      startedAtNs
    );

    return reply.send(responseBody);
  } catch (error) {
    writeImportantLog('ERROR', 'Upstream request failed', {
      requestId: clientRequest.id,
      method,
      url: clientRequest.url,
      targetUrl,
      durationMs: getElapsedMs(startedAtNs),
      error: createErrorLogValue(error)
    });

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

async function sendBufferedChatCompletionResponse({
  upstreamResponse,
  clientRequest,
  reply,
  targetUrl,
  startedAtNs
}) {
  const responseBuffer = await readStreamToBuffer(upstreamResponse.body);
  const emulatedStreamingBody = createEmulatedStreamingChatCompletionBody(responseBuffer);

  reply.code(upstreamResponse.statusCode);
  setDownstreamHeaders(reply, upstreamResponse.headers);

  if (emulatedStreamingBody) {
    setEmulatedStreamingHeaders(reply);

    logProxyResponse(
      clientRequest,
      targetUrl,
      upstreamResponse.statusCode,
      startedAtNs,
      createResponseLogStateFromBody(emulatedStreamingBody),
      {
        responseMode: 'emulated_stream'
      }
    );

    return reply.send(emulatedStreamingBody);
  }

  logProxyResponse(
    clientRequest,
    targetUrl,
    upstreamResponse.statusCode,
    startedAtNs,
    createResponseLogStateFromBody(responseBuffer),
    {
      responseMode: 'buffered'
    }
  );

  return reply.send(responseBuffer);
}

function initialiseLogFile() {
  if (!LOG_FILE_PATH) {
    return;
  }

  const resolvedLogFilePath = path.resolve(LOG_FILE_PATH);

  fs.mkdirSync(path.dirname(resolvedLogFilePath), {
    recursive: true
  });
}

function writeImportantLog(level, message, details = {}) {
  const line = formatImportantLogLine(level, message, details);

  if (!LOG_FILE_PATH) {
    if (level === 'ERROR') {
      console.error(line);
      return;
    }

    console.log(line);
    return;
  }

  try {
    fs.appendFileSync(path.resolve(LOG_FILE_PATH), `${line}\n`, 'utf8');
  } catch (error) {
    console.error(formatImportantLogLine('ERROR', 'Failed to write log file', {
      logFilePath: LOG_FILE_PATH,
      error: createErrorLogValue(error)
    }));
    console.error(line);
  }
}

function formatImportantLogLine(level, message, details) {
  const timestamp = new Date().toISOString();
  const parts = [
    `[${timestamp}]`,
    level,
    message
  ];

  for (const [key, value] of Object.entries(details || {})) {
    if (value === undefined || value === null) {
      continue;
    }

    parts.push(`${key}=${formatLogValue(value)}`);
  }

  return parts.join(' ');
}

function formatLogValue(value) {
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  return JSON.stringify(value);
}

function createErrorLogValue(error) {
  if (!error) {
    return undefined;
  }

  const value = {
    name: error.name,
    message: error.message
  };

  if (LOG_LEVEL === 'debug' && error.stack) {
    value.stack = error.stack;
  }

  return value;
}

function getElapsedMs(startedAtNs) {
  const elapsedMs = Number(process.hrtime.bigint() - startedAtNs) / 1_000_000;
  return Math.round(elapsedMs * 100) / 100;
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

function buildUpstreamHeaders(incomingHeaders, options = {}) {
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

  const contentType = getHeader(incomingHeaders, 'content-type');
  if (contentType) {
    headers['content-type'] = contentType;
  }

  const finalHeaders = {
    ...headers,
    ...UPSTREAM_EXTRA_HEADERS
  };

  if (options.streamingForcedOff && options.upstreamPath === '/v1/chat/completions') {
    finalHeaders.accept = 'application/json';

    for (const headerName of STREAMING_REQUEST_HEADERS) {
      delete finalHeaders[headerName];
    }
  }

  return finalHeaders;
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

function setEmulatedStreamingHeaders(reply) {
  reply.header('content-type', 'text/event-stream; charset=utf-8');
  reply.header('cache-control', 'no-cache, no-transform');
  reply.header('x-accel-buffering', 'no');
}

function shouldForceNonStreaming(upstreamPath) {
  return !STREAMING_ENABLED && upstreamPath === '/v1/chat/completions';
}

function shouldTryEmulatedStreamingResponse(options) {
  return options.upstreamPath === '/v1/chat/completions'
    && options.streamingForcedOff
    && options.clientStreamRequested
    && options.statusCode >= 200
    && options.statusCode < 300;
}

function shouldNormaliseStreamingChatCompletionResponse(options) {
  return NORMALISE_STREAMING_REASONING
    && options.upstreamPath === '/v1/chat/completions'
    && !options.streamingForcedOff
    && options.clientStreamRequested
    && options.statusCode >= 200
    && options.statusCode < 300;
}

function createUpstreamRequestBody(body, upstreamPath) {
  if (!shouldForceNonStreaming(upstreamPath)) {
    return body;
  }

  return disableStreamingInBody(body);
}

function disableStreamingInBody(body) {
  if (body === undefined || body === null) {
    return body;
  }

  if (Buffer.isBuffer(body)) {
    return disableStreamingInJsonString(body.toString('utf8'), body);
  }

  if (typeof body === 'string') {
    return disableStreamingInJsonString(body, body);
  }

  if (typeof body === 'object' && !Array.isArray(body)) {
    return {
      ...body,
      stream: false
    };
  }

  return body;
}

function disableStreamingInJsonString(content, fallback) {
  let parsed;

  try {
    parsed = JSON.parse(content);
  } catch (error) {
    return fallback;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return fallback;
  }

  return JSON.stringify({
    ...parsed,
    stream: false
  });
}

function isStreamRequested(body) {
  if (body === undefined || body === null) {
    return false;
  }

  if (Buffer.isBuffer(body)) {
    return isStreamRequestedInJsonString(body.toString('utf8'));
  }

  if (typeof body === 'string') {
    return isStreamRequestedInJsonString(body);
  }

  if (typeof body === 'object' && !Array.isArray(body)) {
    return body.stream === true;
  }

  return false;
}

function isStreamRequestedInJsonString(content) {
  let parsed;

  try {
    parsed = JSON.parse(content);
  } catch (error) {
    return false;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return false;
  }

  return parsed.stream === true;
}

function logProxyRequest(clientRequest, targetUrl, body, streamingInfo = {}) {
  if (!REQUEST_RESPONSE_LOGGING) {
    return;
  }

  writeImportantLog('INFO', 'Proxy request', {
    requestId: clientRequest.id,
    method: clientRequest.method,
    url: clientRequest.url,
    targetUrl,
    streamingEnabled: STREAMING_ENABLED,
    streamingForcedOff: Boolean(streamingInfo.streamingForcedOff),
    clientStreamRequested: Boolean(streamingInfo.clientStreamRequested),
    upstreamStreamRequested: Boolean(streamingInfo.upstreamStreamRequested),
    body: createBodyLogValue(body)
  });
}

function createLoggedResponseStream(upstreamBody, clientRequest, targetUrl, statusCode, startedAtNs) {
  if (!REQUEST_RESPONSE_LOGGING) {
    return upstreamBody;
  }

  if (!upstreamBody) {
    logProxyResponse(clientRequest, targetUrl, statusCode, startedAtNs, {
      truncated: false,
      content: ''
    });

    return upstreamBody;
  }

  const responseLogState = {
    truncated: false,
    content: ''
  };

  const loggingStream = new Transform({
    transform(chunk, encoding, callback) {
      captureLogChunk(responseLogState, chunk);
      this.push(chunk);
      callback();
    },
    flush(callback) {
      logProxyResponse(clientRequest, targetUrl, statusCode, startedAtNs, responseLogState);
      callback();
    }
  });

  upstreamBody.on('error', (error) => {
    writeImportantLog('ERROR', 'Upstream response stream failed', {
      requestId: clientRequest.id,
      method: clientRequest.method,
      url: clientRequest.url,
      targetUrl,
      durationMs: getElapsedMs(startedAtNs),
      error: createErrorLogValue(error)
    });

    loggingStream.destroy(error);
  });

  return upstreamBody.pipe(loggingStream);
}

function createChatCompletionStreamCompatibilityTransform(clientRequest, targetUrl, startedAtNs) {
  let bufferedText = '';

  return new Transform({
    transform(chunk, encoding, callback) {
      bufferedText += Buffer.isBuffer(chunk)
        ? chunk.toString('utf8')
        : Buffer.from(chunk, encoding).toString('utf8');

      const extraction = extractCompleteSseEvents(bufferedText);
      bufferedText = extraction.remainder;

      for (const eventText of extraction.events) {
        this.push(normaliseChatCompletionSseEvent(eventText, clientRequest, targetUrl, startedAtNs));
      }

      callback();
    },
    flush(callback) {
      if (bufferedText) {
        this.push(normaliseChatCompletionSseEvent(bufferedText, clientRequest, targetUrl, startedAtNs));
      }

      callback();
    }
  });
}

function extractCompleteSseEvents(content) {
  const events = [];
  let remainder = content;

  while (remainder) {
    const separator = findSseEventSeparator(remainder);

    if (!separator) {
      break;
    }

    events.push(remainder.slice(0, separator.index));
    remainder = remainder.slice(separator.index + separator.length);
  }

  return {
    events,
    remainder
  };
}

function findSseEventSeparator(content) {
  const lfIndex = content.indexOf('\n\n');
  const crlfIndex = content.indexOf('\r\n\r\n');

  if (lfIndex === -1 && crlfIndex === -1) {
    return null;
  }

  if (lfIndex === -1) {
    return {
      index: crlfIndex,
      length: 4
    };
  }

  if (crlfIndex === -1) {
    return {
      index: lfIndex,
      length: 2
    };
  }

  if (lfIndex < crlfIndex) {
    return {
      index: lfIndex,
      length: 2
    };
  }

  return {
    index: crlfIndex,
    length: 4
  };
}

function normaliseChatCompletionSseEvent(eventText, clientRequest, targetUrl, startedAtNs) {
  if (!eventText) {
    return '\n\n';
  }

  const lines = eventText.split(/\r?\n/);
  const dataLineIndexes = [];
  const dataParts = [];

  for (const [index, line] of lines.entries()) {
    if (!line.startsWith('data:')) {
      continue;
    }

    dataLineIndexes.push(index);

    const rawData = line.slice('data:'.length);
    dataParts.push(rawData.startsWith(' ') ? rawData.slice(1) : rawData);
  }

  if (dataLineIndexes.length === 0) {
    return `${eventText}\n\n`;
  }

  const dataText = dataParts.join('\n');

  if (dataText.trim() === '[DONE]') {
    return `${eventText}\n\n`;
  }

  let parsed;

  try {
    parsed = JSON.parse(dataText);
  } catch (error) {
    writeImportantLog('WARN', 'Failed to normalise streaming chat completion chunk', {
      requestId: clientRequest.id,
      method: clientRequest.method,
      url: clientRequest.url,
      targetUrl,
      durationMs: getElapsedMs(startedAtNs),
      error: createErrorLogValue(error)
    });

    return `${eventText}\n\n`;
  }

  const normalisedPayload = normaliseChatCompletionStreamPayload(parsed);
  const normalisedDataLine = `data: ${JSON.stringify(normalisedPayload)}`;
  const outputLines = [];
  let dataLineWritten = false;

  for (const [index, line] of lines.entries()) {
    if (!dataLineIndexes.includes(index)) {
      outputLines.push(line);
      continue;
    }

    if (!dataLineWritten) {
      outputLines.push(normalisedDataLine);
      dataLineWritten = true;
    }
  }

  return `${outputLines.join('\n')}\n\n`;
}

function normaliseChatCompletionStreamPayload(payload) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.choices)) {
    return payload;
  }

  return {
    ...payload,
    choices: payload.choices.map(normaliseChatCompletionStreamChoice)
  };
}

function normaliseChatCompletionStreamChoice(choice) {
  if (!choice || typeof choice !== 'object') {
    return choice;
  }

  const normalisedChoice = {
    ...choice
  };

  if (normalisedChoice.delta && typeof normalisedChoice.delta === 'object') {
    normalisedChoice.delta = normaliseChatCompletionDelta(normalisedChoice.delta);
  }

  return normalisedChoice;
}

function normaliseChatCompletionDelta(delta) {
  const normalisedDelta = {
    ...delta
  };

  normaliseReasoningField(normalisedDelta, 'reasoning_content');
  normaliseReasoningField(normalisedDelta, 'reasoning');

  return normalisedDelta;
}

function normaliseReasoningField(target, fieldName) {
  if (!Object.prototype.hasOwnProperty.call(target, fieldName)) {
    return;
  }

  if (STRIP_STREAMING_REASONING) {
    delete target[fieldName];
    return;
  }

  const normalisedValue = normaliseReasoningValue(target[fieldName]);

  if (normalisedValue === undefined) {
    delete target[fieldName];
    return;
  }

  target[fieldName] = normalisedValue;
}

function normaliseReasoningValue(value) {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .map(normaliseReasoningValue)
      .filter((part) => part !== undefined)
      .join('');
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  if (typeof value !== 'object') {
    return undefined;
  }

  for (const key of ['thinking', 'text', 'content', 'value', 'summary']) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      continue;
    }

    const normalisedValue = normaliseReasoningValue(value[key]);

    if (normalisedValue !== undefined) {
      return normalisedValue;
    }
  }

  try {
    return JSON.stringify(value);
  } catch (error) {
    return undefined;
  }
}

function logProxyResponse(clientRequest, targetUrl, statusCode, startedAtNs, responseLogState, extraDetails = {}) {
  writeImportantLog('INFO', 'Proxy response', {
    requestId: clientRequest.id,
    method: clientRequest.method,
    url: clientRequest.url,
    targetUrl,
    statusCode,
    durationMs: getElapsedMs(startedAtNs),
    ...extraDetails,
    body: createResponseBodyLogValue(responseLogState)
  });
}

function captureLogChunk(responseLogState, chunk) {
  if (!LOG_BODY_CONTENT) {
    return;
  }

  if (responseLogState.content.length >= LOG_MAX_BODY_CHARS) {
    responseLogState.truncated = true;
    return;
  }

  const chunkText = Buffer.isBuffer(chunk)
    ? chunk.toString('utf8')
    : Buffer.from(chunk).toString('utf8');

  const remainingChars = LOG_MAX_BODY_CHARS - responseLogState.content.length;

  if (chunkText.length > remainingChars) {
    responseLogState.content += chunkText.slice(0, remainingChars);
    responseLogState.truncated = true;
    return;
  }

  responseLogState.content += chunkText;
}

function createBodyLogValue(body) {
  if (!LOG_BODY_CONTENT) {
    return '[body logging disabled]';
  }

  if (body === undefined || body === null) {
    return undefined;
  }

  const content = bodyToString(body);

  return truncateLogContent(content);
}

function createResponseBodyLogValue(responseLogState) {
  if (!LOG_BODY_CONTENT) {
    return '[body logging disabled]';
  }

  return {
    truncated: responseLogState.truncated,
    content: responseLogState.content
  };
}

function createResponseLogStateFromBody(body) {
  return truncateLogContent(bodyToString(body));
}

function bodyToString(body) {
  if (Buffer.isBuffer(body)) {
    return body.toString('utf8');
  }

  if (typeof body === 'string') {
    return body;
  }

  return JSON.stringify(body);
}

function truncateLogContent(content) {
  if (content.length <= LOG_MAX_BODY_CHARS) {
    return {
      truncated: false,
      content
    };
  }

  return {
    truncated: true,
    content: content.slice(0, LOG_MAX_BODY_CHARS)
  };
}

async function readStreamToBuffer(stream) {
  if (!stream) {
    return Buffer.alloc(0);
  }

  const chunks = [];

  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}

function createEmulatedStreamingChatCompletionBody(responseBuffer) {
  let completion;

  try {
    completion = JSON.parse(responseBuffer.toString('utf8'));
  } catch (error) {
    return '';
  }

  if (!completion || typeof completion !== 'object' || !Array.isArray(completion.choices)) {
    return '';
  }

  const events = createEmulatedChatCompletionStreamEvents(completion);

  if (events.length === 0) {
    return '';
  }

  return `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`;
}

function createEmulatedChatCompletionStreamEvents(completion) {
  const events = [];
  const baseEvent = {
    id: completion.id,
    object: 'chat.completion.chunk',
    created: completion.created,
    model: completion.model
  };

  if (completion.system_fingerprint) {
    baseEvent.system_fingerprint = completion.system_fingerprint;
  }

  for (const [fallbackIndex, choice] of completion.choices.entries()) {
    if (!choice || typeof choice !== 'object') {
      continue;
    }

    const index = Number.isInteger(choice.index) ? choice.index : fallbackIndex;
    const message = choice.message && typeof choice.message === 'object'
      ? choice.message
      : {};
    const role = typeof message.role === 'string' && message.role
      ? message.role
      : 'assistant';

    events.push({
      ...baseEvent,
      choices: [
        {
          index,
          delta: {
            role
          },
          finish_reason: null
        }
      ]
    });

    const content = normaliseStreamingContent(message.content);
    if (content) {
      events.push({
        ...baseEvent,
        choices: [
          {
            index,
            delta: {
              content
            },
            finish_reason: null
          }
        ]
      });
    }

    if (message.tool_calls) {
      events.push({
        ...baseEvent,
        choices: [
          {
            index,
            delta: {
              tool_calls: message.tool_calls
            },
            finish_reason: null
          }
        ]
      });
    }

    if (message.function_call) {
      events.push({
        ...baseEvent,
        choices: [
          {
            index,
            delta: {
              function_call: message.function_call
            },
            finish_reason: null
          }
        ]
      });
    }

    events.push({
      ...baseEvent,
      choices: [
        {
          index,
          delta: {},
          finish_reason: choice.finish_reason || 'stop'
        }
      ]
    });
  }

  return events;
}

function normaliseStreamingContent(content) {
  if (content === undefined || content === null) {
    return '';
  }

  if (typeof content === 'string') {
    return content;
  }

  return JSON.stringify(content);
}

function sanitiseHeaders(headers) {
  const sanitised = {};

  for (const [key, value] of Object.entries(headers || {})) {
    const lowerKey = key.toLowerCase();

    if (SENSITIVE_HEADERS.has(lowerKey)) {
      sanitised[lowerKey] = '[redacted]';
      continue;
    }

    sanitised[lowerKey] = Array.isArray(value) ? value.join(', ') : value;
  }

  return sanitised;
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

function parseBoolean(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }

  const normalisedValue = String(value).trim().toLowerCase();

  if (['1', 'true', 'yes', 'on'].includes(normalisedValue)) {
    return true;
  }

  if (['0', 'false', 'no', 'off'].includes(normalisedValue)) {
    return false;
  }

  return defaultValue;
}

function toPositiveInteger(value, fallback) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.floor(parsed);
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

  writeImportantLog('INFO', 'Server started', {
    host: HOST,
    port: PORT,
    upstreamBaseUrl: UPSTREAM_BASE_URL,
    streamingEnabled: STREAMING_ENABLED,
    logFilePath: LOG_FILE_PATH || '[terminal]'
  });
}

start().catch((error) => {
  writeImportantLog('ERROR', 'Server failed to start', {
    error: createErrorLogValue(error)
  });
  process.exit(1);
});
