'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  extractChatCompletionContents,
  isReferenceErrorMessage,
  isRetryableChatCompletionResponse,
  isUpstreamProviderUnavailableErrorResponse
} = require('../server');

const referenceError = '[An error occurred. Reference: chat_1784015974183_qjmkktqug at 2026-07-14T07:59:40.306Z]';

test('matches only the reference-bearing temporary error format', () => {
  assert.equal(isReferenceErrorMessage(referenceError), true);
  assert.equal(isReferenceErrorMessage('[An error occurred.]'), false);
  assert.equal(isReferenceErrorMessage('An error occurred. Reference: chat_123 at 2026-07-14T07:59:40.306Z'), false);
  assert.equal(isReferenceErrorMessage('[An error occurred. Reference: chat_123]'), false);
});

test('detects the temporary error in a non-streaming chat completion', () => {
  const response = Buffer.from(JSON.stringify({
    choices: [{
      message: {
        role: 'assistant',
        content: referenceError
      }
    }]
  }));

  assert.equal(isRetryableChatCompletionResponse(response), true);
});

test('detects the temporary error in an SSE chat-completion chunk', () => {
  const response = `data: ${JSON.stringify({
    choices: [{
      delta: {
        content: referenceError
      }
    }]
  })}\n\ndata: [DONE]\n\n`;

  assert.deepEqual(extractChatCompletionContents(response), [referenceError]);
  assert.equal(isRetryableChatCompletionResponse(Buffer.from(response)), true);
});

test('does not retry ordinary assistant output or generic error text', () => {
  const normalResponse = Buffer.from(JSON.stringify({
    choices: [{
      message: {
        role: 'assistant',
        content: 'Here is the answer you requested.'
      }
    }]
  }));
  const genericError = Buffer.from(JSON.stringify({
    choices: [{
      message: {
        role: 'assistant',
        content: '[An error occurred.]'
      }
    }]
  }));

  assert.equal(isRetryableChatCompletionResponse(normalResponse), false);
  assert.equal(isRetryableChatCompletionResponse(genericError), false);
});

test('does not retry when the reference text is only part of an otherwise valid response', () => {
  const response = Buffer.from(JSON.stringify({
    choices: [{
      message: {
        role: 'assistant',
        content: `The provider included this note: ${referenceError}`
      }
    }]
  }));

  assert.equal(isRetryableChatCompletionResponse(response), false);
});

test('retries only the exact upstream-provider-unavailable error payload', () => {
  const unavailableError = JSON.stringify({
    error: {
      message: 'The upstream provider is currently unavailable',
      type: 'authentication_error'
    }
  });
  const otherAuthenticationError = JSON.stringify({
    error: {
      message: 'Invalid API key',
      type: 'authentication_error'
    }
  });

  assert.equal(isUpstreamProviderUnavailableErrorResponse(unavailableError), true);
  assert.equal(isRetryableChatCompletionResponse(Buffer.from(unavailableError)), true);
  assert.equal(isUpstreamProviderUnavailableErrorResponse(otherAuthenticationError), false);
  assert.equal(isRetryableChatCompletionResponse(Buffer.from(otherAuthenticationError)), false);
});
