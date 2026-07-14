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

## Docker setup

You can also run the proxy using Docker.

1. Create your environment file

cp .env.example .env

2. Edit .env

Set at least:

UPSTREAM_BASE_URL=https://your-provider.example.com/v1
UPSTREAM_API_KEY=your-upstream-api-key
PROXY_API_KEY=your-own-proxy-key

3. Build the Docker image

docker build -t openai-compatible-api-proxy .

4. Run the container

docker run --rm \
  --name openai-compatible-api-proxy \
  --env-file .env \
  -p 3000:3000 \
  -v "$(pwd)/logs:/app/logs" \
  openai-compatible-api-proxy

The proxy will be available at:

http://localhost:3000

If you are running this on Windows Command Prompt, use this command instead:

docker run --rm --name openai-compatible-api-proxy --env-file .env -p 3000:3000 -v "%cd%/logs:/app/logs" openai-compatible-api-proxy

## Docker Compose setup

Docker Compose is the easiest way to run the proxy in Docker.

1. Create your environment file

cp .env.example .env

2. Edit .env with your upstream and proxy API keys.

3. Start the proxy

docker compose up -d

4. View container logs

docker compose logs -f

5. Stop the proxy

docker compose down

By default, Docker Compose maps the proxy to:

http://localhost:3000

If you set a different PORT in .env, Docker Compose will use that port.

## Authentication

Your apps should call the proxy using the proxy API key:

Authorization: Bearer your-own-proxy-key

The proxy then calls the upstream provider using:

Authorization: Bearer your-upstream-api-key

If PROXY_API_KEY is empty, client authentication is disabled. This is not recommended for public deployments.

## Streaming control

Streaming is enabled by default.

Configure it in .env:

STREAMING_ENABLED=true

If you want to force non-streaming upstream requests, set any one of these values:

STREAMING_ENABLED=false
STREAMING_ENABLED=off
STREAMING_ENABLED=no
STREAMING_ENABLED=0

When STREAMING_ENABLED is false or off, the proxy will override POST /v1/chat/completions request bodies and send stream: false to the third-party API, even if the client sends stream: true.

The proxy also forces the upstream Accept header to application/json for chat completions when streaming is disabled. This prevents providers that use Accept: text/event-stream as a streaming signal from returning a streaming response.

If the client did not request streaming, the client receives the normal non-streaming JSON response from the upstream provider.

If the client requested stream: true but streaming is disabled on the proxy, the proxy now converts the upstream non-streaming JSON chat completion into an OpenAI-compatible Server-Sent Events response. This keeps streaming clients and agents compatible while still avoiding a streaming upstream request.

You can confirm this in logs. For a chat completion request with streaming disabled, the request log should show these fields:

streamingEnabled=false
streamingForcedOff=true
clientStreamRequested=true
upstreamStreamRequested=false

For a client streaming request where the proxy emulates the stream from a non-streaming upstream response, the response log will include:

responseMode="emulated_stream"

## Reference-error retries

Some providers return a successful chat completion whose assistant message is only a temporary error such as:

```text
[An error occurred. Reference: chat_1784015974183_qjmkktqug at 2026-07-14T07:59:40.306Z]
```

The proxy retries only that exact reference-bearing format and this exact upstream error payload:

```json
{"error":{"message":"The upstream provider is currently unavailable","type":"authentication_error"}}
```

It does not retry generic `An error occurred` messages, other authentication errors, or any other response. The upstream-unavailable payload is retried even if the provider sends it with a non-2xx status.

This is enabled by default. Configure it in `.env`:

```env
REFERENCE_ERROR_RETRY_ENABLED=true
REFERENCE_ERROR_RETRY_DELAY_MS=1000
REFERENCE_ERROR_RETRY_MAX_ATTEMPTS=0
```

`REFERENCE_ERROR_RETRY_MAX_ATTEMPTS=0` means keep retrying until the upstream returns a different chat-completion response. Set a positive value if you want to cap retries; after the limit is reached, the last retryable response is returned unchanged.

To reliably identify the response before sending it to the client, chat-completion responses are buffered while this feature is enabled. This means streaming clients receive the completed stream after the upstream response finishes.

## Log file

Logs are written to a file instead of the terminal by default.

The default log file is:

logs/proxy.log

You can change it in .env:

LOG_FILE_PATH=logs/proxy.log

The logs directory is created automatically if it does not exist.

To view logs while the API is running:

tail -f logs/proxy.log

If you want logs back in the terminal, set LOG_FILE_PATH to an empty value:

LOG_FILE_PATH=

When running with Docker or Docker Compose, the local logs directory can be mounted into the container:

./logs:/app/logs

This means logs written inside the container are still visible on your machine in the logs folder.

## Clean important logs

The proxy stores clean plain-text logs instead of noisy Fastify JSON logs.

Fastify automatic logs such as incoming request and request completed are disabled.

Normal proxy logs include only important fields:

- Request id
- Request method
- Proxy URL
- Upstream target URL
- Streaming status
- Upstream response status code
- Response duration
- Request body preview, if body logging is enabled
- Response body preview, if body logging is enabled

Example log lines look like this:

[2026-05-23T18:52:05.448Z] INFO Proxy request requestId="req-v" method="POST" url="/v1/chat/completions" targetUrl="https://api.example.com/v1/chat/completions" streamingEnabled=false streamingForcedOff=true clientStreamRequested=true upstreamStreamRequested=false body={"truncated":false,"content":"{\"stream\":false,\"model\":\"gpt-4o-mini\"}"}

[2026-05-23T18:52:05.448Z] INFO Proxy response requestId="req-v" method="POST" url="/v1/chat/completions" targetUrl="https://api.example.com/v1/chat/completions" statusCode=200 durationMs=10700.11 responseMode="emulated_stream" body={"truncated":false,"content":"data: {\"id\":\"chat_123\",\"object\":\"chat.completion.chunk\",\"created\":1779562690,\"model\":\"gpt-4o-mini\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\"},\"finish_reason\":null}]}\n\ndata: [DONE]\n\n"}

## Request and response logging

The proxy logs proxied requests and responses by default.

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

If STREAMING_ENABLED=false or STREAMING_ENABLED=off in .env, this request is sent upstream as a non-streaming request with stream: false. The client still receives an OpenAI-compatible streaming response generated by the proxy from the upstream JSON response.

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
