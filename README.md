# OpenAI-Compatible API Proxy

A fast Node.js proxy that sits between your apps and any third-party OpenAI-compatible API.

It exposes OpenAI-compatible endpoints locally and forwards requests to your configured upstream provider.

## Supported endpoints

- POST /v1/chat/completions
- POST /v1/embeddings
- GET /v1/models

Streaming works automatically for chat completions when your request contains stream: true and your upstream provider supports streaming.

## Setup

1. Install dependencies

npm install

2. Create your environment file

cp .env.example .env

3. Edit .env

Set at least:

UPSTREAM_BASE_URL=https://your-provider.example.com/v1
UPSTREAM_API_KEY=your-upstream-api-key
PROXY_API_KEY=your-own-proxy-key

If your upstream base URL already ends with /v1, keep it as is. The proxy handles both of these correctly:

UPSTREAM_BASE_URL=https://api.example.com
UPSTREAM_BASE_URL=https://api.example.com/v1

4. Start the proxy

npm start

The proxy will run on:

http://localhost:3000

## Authentication

Your apps should call the proxy using the proxy API key:

Authorization: Bearer your-own-proxy-key

The proxy then calls the upstream provider using:

Authorization: Bearer your-upstream-api-key

If PROXY_API_KEY is empty, client authentication is disabled. This is not recommended for public deployments.

## Request and response logging

The proxy logs proxied requests and responses by default.

Logging includes:

- Request method and URL
- Upstream target URL
- Sanitised request headers
- Request body preview
- Upstream response status
- Sanitised response headers
- Response body preview

Sensitive headers are redacted automatically. This includes headers such as authorization, cookie, set-cookie, proxy-authorization, x-api-key, api-key, and openai-api-key.

Configure logging in .env:

REQUEST_RESPONSE_LOGGING=true
LOG_BODY_CONTENT=true
LOG_MAX_BODY_CHARS=20000

To disable all request and response proxy logs:

REQUEST_RESPONSE_LOGGING=false

To keep request and response metadata logs but hide body content:

LOG_BODY_CONTENT=false

LOG_MAX_BODY_CHARS controls the maximum number of body characters stored in logs per request or response. Larger bodies are truncated.

Important: request and response bodies can contain prompts, user data, embeddings input, and model output. In production, disable body logging if these logs may contain sensitive data.

## Example chat completion request

curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer your-own-proxy-key" \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"gpt-4o-mini\",\"messages\":[{\"role\":\"user\",\"content\":\"Hello\"}]}"

## Example streaming request

curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer your-own-proxy-key" \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"gpt-4o-mini\",\"stream\":true,\"messages\":[{\"role\":\"user\",\"content\":\"Write a short poem\"}]}"

## Example embeddings request

curl http://localhost:3000/v1/embeddings \
  -H "Authorization: Bearer your-own-proxy-key" \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"text-embedding-3-small\",\"input\":\"Hello world\"}"

## Example models request

curl http://localhost:3000/v1/models \
  -H "Authorization: Bearer your-own-proxy-key"

## Extra upstream headers

Some providers need extra headers. You can configure them using JSON:

UPSTREAM_EXTRA_HEADERS={"http-referer":"https://your-site.com","x-title":"Your App"}

Header keys are normalised to lowercase before forwarding.

## CORS

By default CORS is disabled.

To allow all origins:

CORS_ORIGIN=*

To allow selected origins:

CORS_ORIGIN=https://app.example.com,https://admin.example.com

## Timeout configuration

HEADERS_TIMEOUT_MS controls how long the proxy waits for upstream response headers.

BODY_TIMEOUT_MS controls upstream body inactivity timeout.

For streaming, BODY_TIMEOUT_MS defaults to 0, which disables body timeout so long streams are not killed unexpectedly.

## Health check

GET /health

Returns:

{"status":"ok","service":"openai-compatible-api-proxy"}
