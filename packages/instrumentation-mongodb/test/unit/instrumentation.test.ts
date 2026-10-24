/*
 * Copyright The OpenTelemetry Authors
 * SPDX-License-Identifier: Apache-2.0
 */

import * as assert from 'assert';
import {
  context,
  trace,
  propagation,
  TextMapPropagator,
} from '@opentelemetry/api';
import { getTestSpans } from '@opentelemetry/contrib-test-utils';
import * as sinon from 'sinon';
import { MongoDBInstrumentation } from '../../src';

describe('MongoDB comment propagation', () => {
  let instrumentation: MongoDBInstrumentation;
  const traceparent = '00-1234567890abcdef1234567890abcdef-1234567890abcdef-01';
  const propagator: TextMapPropagator = {
    inject(_context, carrier, setter) {
      setter.set(carrier, 'traceparent', traceparent);
      setter.set(carrier, 'tracestate', 'vendor=value');
    },
    extract: activeContext => activeContext,
    fields: () => ['traceparent', 'tracestate'],
  };
  const description = {
    maxWireVersion: 9,
    maxBsonObjectSize: 16777216,
    maxMessageSizeBytes: 48000000,
  };

  beforeEach(() => {
    instrumentation = new MongoDBInstrumentation({
      enableCommentPropagation: true,
      commentPropagator: propagator,
    });
  });

  afterEach(() => {
    instrumentation.disable();
    sinon.restore();
  });

  function createMessage(command: Record<string, unknown> = { find: 'users' }) {
    const { OpMsgRequest } = require('mongodb/lib/cmap/commands');
    return new OpMsgRequest('test', command, {});
  }

  function inject(message: any, serverDescription: any = description) {
    return (instrumentation as any)._injectComment(
      { description: serverDescription },
      message
    );
  }

  it('is disabled by default', () => {
    instrumentation.setConfig({});
    const message = createMessage();
    const originalCommand = message.command;
    assert.strictEqual(inject(message), message);
    assert.strictEqual(message.command, originalCommand);
    assert.strictEqual(message.command.comment, undefined);
  });

  it('injects a document with all selected propagator fields', () => {
    const message = createMessage();
    inject(message);
    assert.strictEqual(message.command.comment.traceparent, traceparent);
    assert.strictEqual(message.command.comment.tracestate, 'vendor=value');
    assert(!Object.hasOwn(message.command.comment, 'originalComment'));
  });

  it('uses the global propagator when no override is configured', () => {
    instrumentation.setConfig({ enableCommentPropagation: true });
    const globalInject = sinon
      .stub(propagation, 'inject')
      .callsFake((activeContext, carrier, setter) =>
        propagator.inject(activeContext, carrier, setter!)
      );
    const message = createMessage();
    inject(message);
    assert(globalInject.calledOnce);
    assert.strictEqual(message.command.comment.traceparent, traceparent);
  });

  for (const originalComment of [
    'application comment',
    '',
    null,
    0,
    { job: 'rollup' },
    ['job'],
    new Date('2026-01-01T00:00:00Z'),
    Buffer.from('original'),
  ]) {
    it(`preserves the original comment ${JSON.stringify(originalComment)}`, () => {
      const message = createMessage({
        find: 'users',
        comment: originalComment,
      });
      inject(message);
      assert.strictEqual(
        message.command.comment.originalComment,
        originalComment
      );
      assert.strictEqual(message.command.comment.traceparent, traceparent);
    });
  }

  it('does not let a propagator populate originalComment or non-string fields', () => {
    instrumentation.setConfig({
      enableCommentPropagation: true,
      commentPropagator: {
        ...propagator,
        inject(activeContext, carrier: any, setter) {
          propagator.inject(activeContext, carrier, setter);
          carrier.originalComment = 'forged';
          carrier.invalid = { nested: true };
          setter.set(carrier, 'originalComment', 'also forged');
        },
      },
    });
    const message = createMessage();
    inject(message);
    assert(!Object.hasOwn(message.command.comment, 'originalComment'));
    assert(!Object.hasOwn(message.command.comment, 'invalid'));
  });

  for (const style of ['Callback', 'Promise']) {
    it(`propagates the driver span without changing active context (${style})`, async () => {
      instrumentation.setConfig({ enableCommentPropagation: true });
      instrumentation.setTracerProvider(trace.getTracerProvider());
      const commandsModule = require('mongodb/lib/cmap/commands');
      const module = instrumentation.init()[1].files![0];
      module.patch!(commandsModule);
      const parent = trace.getTracer('test').startSpan('parent');
      const connection = { description, address: 'localhost:27017', id: 1 };
      let injectedTraceparent: string | undefined;
      const original = function (
        this: unknown,
        _namespace: unknown,
        command: Record<string, unknown>,
        _options: unknown,
        callback?: (error: null, result: unknown) => void
      ) {
        assert.strictEqual(this, connection);
        assert.strictEqual(trace.getSpan(context.active()), parent);
        const message = createMessage(command);
        injectedTraceparent = message.command.comment.traceparent;
        if (style === 'Callback') {
          callback!(null, { ok: 1 });
          return;
        }
        return Promise.resolve({ ok: 1 });
      };
      const wrapped = (instrumentation as any)[`_getV4PatchCommand${style}`]()(
        original
      );
      try {
        await context.with(trace.setSpan(context.active(), parent), () =>
          wrapped.call(
            connection,
            { db: 'test', collection: 'users' },
            { find: 'users' },
            {},
            () => assert.strictEqual(trace.getSpan(context.active()), parent)
          )
        );
        const driverSpan = getTestSpans().find(
          span => span.name === 'find users'
        );
        assert(driverSpan);
        const spanContext = driverSpan.spanContext();
        assert.strictEqual(
          injectedTraceparent,
          `00-${spanContext.traceId}-${spanContext.spanId}-01`
        );
      } finally {
        parent.end();
        module.unpatch!(commandsModule);
      }
    });
  }

  for (const serverDescription of [
    undefined,
    {},
    { ...description, maxWireVersion: 8 },
  ]) {
    it('skips unknown or unsupported server capabilities', () => {
      const message = createMessage();
      const originalCommand = message.command;
      (instrumentation as any)._injectComment(
        { description: serverDescription },
        message
      );
      assert.strictEqual(message.command, originalCommand);
    });
  }

  for (const limit of ['maxBsonObjectSize', 'maxMessageSizeBytes']) {
    for (const originalComment of [undefined, null, 'original']) {
      it(`leaves the command unchanged when injection exceeds ${limit}`, () => {
        const command: Record<string, unknown> = { find: 'users' };
        if (originalComment !== undefined) {
          command.comment = originalComment;
        }
        const message = createMessage(command);
        const originalCommand = message.command;
        const originalSize = Buffer.concat(message.toBin()).length;
        inject(message, {
          ...description,
          [limit]:
            limit === 'maxBsonObjectSize' ? originalSize - 21 : originalSize,
        });
        assert.strictEqual(message.command, originalCommand);
        assert.strictEqual(message.command.comment, originalComment);
      });
    }
  }

  it('leaves the command unchanged when a propagator injects nothing', () => {
    instrumentation.setConfig({
      enableCommentPropagation: true,
      commentPropagator: { ...propagator, inject() {} },
    });
    const message = createMessage();
    const originalCommand = message.command;
    inject(message);
    assert.strictEqual(message.command, originalCommand);
  });

  it('does not fail a command when propagation throws', () => {
    instrumentation.setConfig({
      enableCommentPropagation: true,
      commentPropagator: {
        ...propagator,
        inject() {
          throw new Error('propagator failure');
        },
      },
    });
    const message = createMessage();
    const originalCommand = message.command;
    assert.doesNotThrow(() => inject(message));
    assert.strictEqual(message.command, originalCommand);
  });

  it('does not fail a command when serialization throws', () => {
    const message = createMessage();
    message.toBin = () => {
      throw new Error('serialization failure');
    };
    const originalCommand = message.command;
    assert.doesNotThrow(() => inject(message));
    assert.strictEqual(message.command, originalCommand);
  });

  for (const command of [{ hello: 1 }, { ismaster: 1 }]) {
    it('does not inject into handshakes', () => {
      const message = createMessage(command);
      const originalCommand = message.command;
      inject(message);
      assert.strictEqual(message.command, originalCommand);
    });
  }
});

describe('DbStatementSerializer', () => {
  let instrumentation: MongoDBInstrumentation;

  beforeEach(() => {
    instrumentation = new MongoDBInstrumentation();
  });

  const testDefaultDbStatementSerialization = (
    commandObj: Record<string, unknown>,
    config: any
  ): string => {
    instrumentation.setConfig(config);
    return (instrumentation as any)._defaultDbStatementSerializer(commandObj);
  };

  describe('default db statement serialization', () => {
    it('should handle deeply nested objects without stack overflow', () => {
      // Create a deeply nested object that could cause stack overflow
      let deeplyNested: any = { value: 'test' };
      for (let i = 0; i < 500; i++) {
        deeplyNested = { level: i, nested: deeplyNested };
      }

      const commandObj = {
        insert: 'test-collection',
        documents: [deeplyNested],
      };

      const result = testDefaultDbStatementSerialization(commandObj, {
        enhancedDatabaseReporting: false,
      });

      assert(typeof result === 'string', 'Result should be a string');
      assert(result!.length > 0, 'Result should not be empty');
    });

    it('should handle circular references gracefully with replacer function', () => {
      // Create an object with circular reference
      const circularObj: any = { a: 1, b: 2 };
      circularObj.circular = circularObj;

      const commandObj = {
        insert: 'test-collection',
        documents: [circularObj],
      };

      const result = testDefaultDbStatementSerialization(commandObj, {
        enhancedDatabaseReporting: false,
      });

      assert(typeof result === 'string', 'Result should be a string');
      assert(result.length > 0, 'Result should not be empty');

      const parsed = JSON.parse(result);
      assert.strictEqual(parsed.insert, '?', 'Values should be scrubbed');
      assert.strictEqual(
        parsed.documents[0].circular,
        '[Circular]',
        'Circular reference should be marked as [Circular]'
      );
    });

    it('should handle enhancedDatabaseReporting: true with circular references', () => {
      const circularObj: any = { a: 1 };
      circularObj.circular = circularObj;

      const commandObj = {
        insert: 'test-collection',
        documents: [circularObj],
      };

      // With enhancedDatabaseReporting: true, it uses simple JSON.stringify which should throw
      assert.throws(
        () => {
          testDefaultDbStatementSerialization(commandObj, {
            enhancedDatabaseReporting: true,
          });
        },
        /Converting circular structure to JSON/,
        'Should throw on circular references with enhancedDatabaseReporting: true'
      );
    });

    it('should scrub values when enhancedDatabaseReporting is false', () => {
      const commandObj = {
        insert: 'test-collection',
        documents: [{ name: 'John', age: 30 }],
      };

      const result = testDefaultDbStatementSerialization(commandObj, {
        enhancedDatabaseReporting: false,
      });

      const expected = JSON.stringify({
        insert: '?',
        documents: [{ name: '?', age: '?' }],
      });

      assert.strictEqual(result, expected, 'All values should be scrubbed');
    });

    it('should not scrub values when enhancedDatabaseReporting is true', () => {
      const commandObj = {
        insert: 'test-collection',
        documents: [{ name: 'John', age: 30 }],
      };

      const expected = JSON.stringify(commandObj);
      const actualResult = testDefaultDbStatementSerialization(commandObj, {
        enhancedDatabaseReporting: true,
      });

      assert.strictEqual(
        actualResult,
        expected,
        'Values should not be scrubbed'
      );
    });

    it('should handle arrays properly', () => {
      const commandObj = {
        find: 'users',
        filter: { $or: ['condition1', 'condition2', { nested: 'value' }] },
      };

      const result = testDefaultDbStatementSerialization(commandObj, {
        enhancedDatabaseReporting: false,
      });

      const expected = JSON.stringify({
        find: '?',
        filter: { $or: ['?', '?', { nested: '?' }] },
      });

      assert.strictEqual(result, expected, 'Array values should be scrubbed');
    });

    it('should handle objects properly', () => {
      const commandObj = {
        filter: { category: 'electronics' },
        update: { $set: { price: 299.99, available: true } },
      };

      const result = testDefaultDbStatementSerialization(commandObj, {
        enhancedDatabaseReporting: false,
      });

      const expected = JSON.stringify({
        filter: { category: '?' },
        update: { $set: { price: '?', available: '?' } },
      });

      assert.strictEqual(result, expected, 'Object values should be scrubbed');
    });

    it('should handle bigint values', () => {
      const commandObj = {
        insert: 'analytics',
        documents: [
          {
            userId: BigInt(123456789012345),
            timestamp: BigInt(Date.now()),
          },
        ],
      };

      const result = testDefaultDbStatementSerialization(commandObj, {
        enhancedDatabaseReporting: false,
      });

      const expected = JSON.stringify({
        insert: '?',
        documents: [{ userId: '?', timestamp: '?' }],
      });

      assert.strictEqual(result, expected, 'BigInt values should be scrubbed');
    });

    it('should handle deep nested objects', () => {
      const commandObj = {
        aggregate: 'orders',
        pipeline: [
          {
            $match: {
              user: {
                profile: {
                  preferences: {
                    notifications: {
                      email: true,
                      sms: false,
                      push: {
                        enabled: true,
                        frequency: 'daily',
                        categories: ['updates', 'promotions'],
                      },
                    },
                  },
                },
              },
            },
          },
        ],
      };

      const result = testDefaultDbStatementSerialization(commandObj, {
        enhancedDatabaseReporting: false,
      });

      const expected = JSON.stringify({
        aggregate: '?',
        pipeline: [
          {
            $match: {
              user: {
                profile: {
                  preferences: {
                    notifications: {
                      email: '?',
                      sms: '?',
                      push: {
                        enabled: '?',
                        frequency: '?',
                        categories: ['?', '?'],
                      },
                    },
                  },
                },
              },
            },
          },
        ],
      });

      assert.strictEqual(
        result,
        expected,
        'Deep nested values should be scrubbed while preserving structure'
      );
    });

    it('should handle string values', () => {
      const commandObj = {
        find: 'messages',
        filter: { content: 'hello world', sender: 'user123' },
        sort: { timestamp: -1 },
      };

      const result = testDefaultDbStatementSerialization(commandObj, {
        enhancedDatabaseReporting: false,
      });

      const expected = JSON.stringify({
        find: '?',
        filter: { content: '?', sender: '?' },
        sort: { timestamp: '?' },
      });

      assert.strictEqual(result, expected, 'String values should be scrubbed');
    });
  });
});

describe('_patchEnd', () => {
  let instrumentation: MongoDBInstrumentation;

  beforeEach(() => {
    instrumentation = new MongoDBInstrumentation();
  });

  afterEach(() => {
    instrumentation.disable();
  });

  function createMockSpan() {
    let endCallCount = 0;
    let setStatusCallCount = 0;
    let lastStatus: any = null;

    return {
      end: () => {
        endCallCount++;
      },
      setStatus: (status: any) => {
        setStatusCallCount++;
        lastStatus = status;
      },
      recordException: () => {},
      setAttribute: () => {},
      setAttributes: () => {},
      addEvent: () => {},
      isRecording: () => endCallCount === 0,
      getEndCallCount: () => endCallCount,
      getSetStatusCallCount: () => setStatusCallCount,
      getLastStatus: () => lastStatus,
    };
  }

  // https://github.com/open-telemetry/opentelemetry-js-contrib/issues/2788
  describe('double callback invocation guard', () => {
    it('should only call span.end() once even when callback is invoked multiple times', () => {
      const mockSpan = createMockSpan();
      let resultHandlerCallCount = 0;

      const resultHandler = () => {
        resultHandlerCallCount++;
        return 'result';
      };

      const patchedEnd = (instrumentation as any)._patchEnd(
        mockSpan,
        resultHandler,
        123,
        'find'
      );

      patchedEnd(null, { ok: 1 });
      patchedEnd(null, { ok: 1 });
      patchedEnd(null, { ok: 1 });

      assert.strictEqual(mockSpan.getEndCallCount(), 1);
      assert.strictEqual(resultHandlerCallCount, 3);
    });

    it('should only set error status once when callback is invoked multiple times with error', () => {
      const mockSpan = createMockSpan();
      const resultHandler = () => 'result';

      const patchedEnd = (instrumentation as any)._patchEnd(
        mockSpan,
        resultHandler,
        123,
        'find'
      );

      const testError = new Error('Connection timeout');
      patchedEnd(testError);
      patchedEnd(testError);
      patchedEnd(testError);

      assert.strictEqual(mockSpan.getSetStatusCallCount(), 1);
      assert.strictEqual(mockSpan.getEndCallCount(), 1);
      assert.strictEqual(mockSpan.getLastStatus().code, 2);
      assert.strictEqual(
        mockSpan.getLastStatus().message,
        'Connection timeout'
      );
    });

    it('should handle undefined span gracefully on multiple invocations', () => {
      let resultHandlerCallCount = 0;
      const resultHandler = () => {
        resultHandlerCallCount++;
        return 'result';
      };

      const patchedEnd = (instrumentation as any)._patchEnd(
        undefined,
        resultHandler,
        123,
        'find'
      );

      assert.doesNotThrow(() => {
        patchedEnd(null, { ok: 1 });
        patchedEnd(null, { ok: 1 });
        patchedEnd(null, { ok: 1 });
      });
      assert.strictEqual(resultHandlerCallCount, 3);
    });

    it('should only update metrics once for endSessions command', () => {
      const mockSpan = createMockSpan();
      let metricsAddCallCount = 0;

      (instrumentation as any)._connectionsCount = {
        add: () => {
          metricsAddCallCount++;
        },
      };
      (instrumentation as any)._poolName = 'mongodb://localhost:27017/test';

      const patchedEnd = (instrumentation as any)._patchEnd(
        mockSpan,
        () => 'result',
        123,
        'endSessions'
      );

      patchedEnd(null, { ok: 1 });
      patchedEnd(null, { ok: 1 });
      patchedEnd(null, { ok: 1 });

      assert.strictEqual(metricsAddCallCount, 1);
      assert.strictEqual(mockSpan.getEndCallCount(), 1);
    });

    it('should handle mixed success and error calls correctly', () => {
      const mockSpan = createMockSpan();
      let resultHandlerCallCount = 0;
      const resultHandler = () => {
        resultHandlerCallCount++;
      };

      const patchedEnd = (instrumentation as any)._patchEnd(
        mockSpan,
        resultHandler,
        123,
        'find'
      );

      patchedEnd(null, { ok: 1 });
      patchedEnd(new Error('Late error 1'));
      patchedEnd(new Error('Late error 2'));

      assert.strictEqual(mockSpan.getEndCallCount(), 1);
      assert.strictEqual(mockSpan.getSetStatusCallCount(), 0);
      assert.strictEqual(resultHandlerCallCount, 3);
    });
  });
});
