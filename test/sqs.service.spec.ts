import 'reflect-metadata';

import { EventEmitter } from 'node:events';
import type { Message } from '@aws-sdk/client-sqs';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { Injectable } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SqsConfigurationError, SqsConsumerEventHandler, SqsMessageHandler, SqsModule, SqsService } from '../lib';

const consumerCreateSpy = vi.fn();
const producerCreateSpy = vi.fn();

class MockConsumer extends EventEmitter {
  public readonly options: Record<string, unknown>;
  public readonly start = vi.fn(() => {
    this.status.isRunning = true;
    this.emit('started');
  });
  public readonly stop = vi.fn((_options?: unknown) => {
    this.status.isRunning = false;
    this.emit('stopped');
  });
  public readonly updateOption = vi.fn();
  public status = {
    isRunning: false,
    isPolling: false,
  };

  public constructor(options: Record<string, unknown>) {
    super();
    this.options = options;
  }
}

class MockProducer {
  public readonly queueUrl: string;
  public readonly sqs: { send: ReturnType<typeof vi.fn> };
  public readonly send = vi.fn(async () => [{ Id: 'ok' }]);
  public readonly queueSize = vi.fn(async () => 42);

  public constructor(options: { queueUrl: string; sqs: { send: ReturnType<typeof vi.fn> } }) {
    this.queueUrl = options.queueUrl;
    this.sqs = options.sqs;
  }
}

vi.mock('sqs-consumer', () => {
  return {
    Consumer: {
      create: vi.fn((options: Record<string, unknown>) => {
        const instance = new MockConsumer(options);
        consumerCreateSpy(options, instance);
        return instance;
      }),
    },
  };
});

vi.mock('sqs-producer', () => {
  return {
    Producer: {
      create: vi.fn((options: { queueUrl: string; sqs: { send: ReturnType<typeof vi.fn> } }) => {
        const instance = new MockProducer(options);
        producerCreateSpy(options, instance);
        return instance;
      }),
    },
  };
});

describe('SqsService', () => {
  afterEach(async () => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('binds event handlers to the instance that declares them', async () => {
    const callTrace: string[] = [];

    @Injectable()
    class MessageOwner {
      @SqsMessageHandler('orders')
      public async handleMessage() {
        callTrace.push('message');
        return undefined;
      }
    }

    @Injectable()
    class EventOwner {
      private readonly marker = 'event-owner';

      @SqsConsumerEventHandler('orders', 'processing_error')
      public onProcessingError() {
        callTrace.push(this.marker);
      }
    }

    const moduleRef = await Test.createTestingModule({
      imports: [
        SqsModule.register({
          consumers: [{ name: 'orders', queueUrl: 'https://example.com/orders' }],
        }),
      ],
      providers: [MessageOwner, EventOwner],
    }).compile();

    await moduleRef.init();

    const service = moduleRef.get(SqsService);
    const consumer = service.getConsumer('orders') as unknown as MockConsumer;

    consumer.emit('processing_error', new Error('boom'), { MessageId: '1' });

    expect(callTrace).toEqual(['event-owner']);
    expect(consumer.start).toHaveBeenCalledTimes(1);

    await moduleRef.close();
  });

  it('fails fast when a consumer has no matching message handler', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        SqsModule.register({
          consumers: [{ name: 'missing', queueUrl: 'https://example.com/missing' }],
        }),
      ],
    }).compile();

    await expect(moduleRef.init()).rejects.toThrow(SqsConfigurationError);
  });

  it('fails fast when an event handler has no matching consumer', async () => {
    @Injectable()
    class EventOnlyHandler {
      @SqsConsumerEventHandler('orders', 'processing_error')
      public onProcessingError() {
        return undefined;
      }
    }

    const moduleRef = await Test.createTestingModule({
      imports: [SqsModule.register({})],
      providers: [EventOnlyHandler],
    }).compile();

    await expect(moduleRef.init()).rejects.toThrow(SqsConfigurationError);
  });

  it('fails fast when an event handler uses an unsupported consumer event name', async () => {
    @Injectable()
    class Handler {
      @SqsMessageHandler('orders')
      public async handleMessage() {
        return undefined;
      }

      @SqsConsumerEventHandler('orders', 'unsupported_event' as never)
      public onUnsupportedEvent() {
        return undefined;
      }
    }

    const moduleRef = await Test.createTestingModule({
      imports: [
        SqsModule.register({
          consumers: [{ name: 'orders', queueUrl: 'https://example.com/orders' }],
        }),
      ],
      providers: [Handler],
    }).compile();

    await expect(moduleRef.init()).rejects.toThrow(SqsConfigurationError);
  });

  it('fails fast when duplicate message handlers target the same queue', async () => {
    @Injectable()
    class HandlerA {
      @SqsMessageHandler('orders')
      public async handleMessage() {
        return undefined;
      }
    }

    @Injectable()
    class HandlerB {
      @SqsMessageHandler('orders')
      public async handleMessage() {
        return undefined;
      }
    }

    const moduleRef = await Test.createTestingModule({
      imports: [
        SqsModule.register({
          consumers: [{ name: 'orders', queueUrl: 'https://example.com/orders' }],
        }),
      ],
      providers: [HandlerA, HandlerB],
    }).compile();

    await expect(moduleRef.init()).rejects.toThrow(SqsConfigurationError);
  });

  it('fails fast when batch handler first parameter is not an array type', async () => {
    @Injectable()
    class Handler {
      @SqsMessageHandler('orders', { batch: true })
      public async handleMessage(_message: Message) {
        return [];
      }
    }
    Reflect.defineMetadata('design:paramtypes', [Object], Handler.prototype, 'handleMessage');

    const moduleRef = await Test.createTestingModule({
      imports: [
        SqsModule.register({
          consumers: [{ name: 'orders', queueUrl: 'https://example.com/orders' }],
        }),
      ],
      providers: [Handler],
    }).compile();

    await expect(moduleRef.init()).rejects.toThrow(SqsConfigurationError);
  });

  it('fails fast when non-batch handler first parameter is an array type', async () => {
    @Injectable()
    class Handler {
      @SqsMessageHandler('orders')
      public async handleMessage(_messages: Message[]) {
        return undefined;
      }
    }
    Reflect.defineMetadata('design:paramtypes', [Array], Handler.prototype, 'handleMessage');

    const moduleRef = await Test.createTestingModule({
      imports: [
        SqsModule.register({
          consumers: [{ name: 'orders', queueUrl: 'https://example.com/orders' }],
        }),
      ],
      providers: [Handler],
    }).compile();

    await expect(moduleRef.init()).rejects.toThrow(SqsConfigurationError);
  });

  it('serializes non-string message bodies before sending', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        SqsModule.register({
          producers: [{ name: 'orders', queueUrl: 'https://example.com/orders' }],
        }),
      ],
    }).compile();

    await moduleRef.init();

    const service = moduleRef.get(SqsService);
    await service.send('orders', {
      id: '1',
      body: { ok: true },
    });

    const producer = service.getProducer('orders') as unknown as MockProducer;
    expect(producer.send).toHaveBeenCalledWith([
      {
        id: '1',
        body: '{"ok":true}',
      },
    ]);

    await moduleRef.close();
  });

  it('uses defaultSqsClient when queue-level sqs client is not provided', async () => {
    @Injectable()
    class Handler {
      @SqsMessageHandler('orders')
      public async handleMessage() {
        return undefined;
      }
    }

    const defaultSqsClient = { send: vi.fn() } as unknown as SQSClient;

    const moduleRef = await Test.createTestingModule({
      imports: [
        SqsModule.register({
          defaultSqsClient,
          consumers: [{ name: 'orders', queueUrl: 'https://example.com/orders' }],
          producers: [{ name: 'orders', queueUrl: 'https://example.com/orders' }],
        }),
      ],
      providers: [Handler],
    }).compile();

    await moduleRef.init();

    const consumerCreateOptions = consumerCreateSpy.mock.calls[0][0];
    const producerCreateOptions = producerCreateSpy.mock.calls[0][0];

    expect(consumerCreateOptions.sqs).toBe(defaultSqsClient);
    expect(producerCreateOptions.sqs).toBe(defaultSqsClient);

    await moduleRef.close();
  });

  it('exposes hasConsumer and hasProducer helper methods', async () => {
    @Injectable()
    class Handler {
      @SqsMessageHandler('orders')
      public async handleMessage() {
        return undefined;
      }
    }

    const moduleRef = await Test.createTestingModule({
      imports: [
        SqsModule.register({
          consumers: [{ name: 'orders', queueUrl: 'https://example.com/orders' }],
          producers: [{ name: 'orders', queueUrl: 'https://example.com/orders' }],
        }),
      ],
      providers: [Handler],
    }).compile();

    await moduleRef.init();

    const service = moduleRef.get(SqsService);
    expect(service.hasConsumer('orders')).toBe(true);
    expect(service.hasProducer('orders')).toBe(true);
    expect(service.hasConsumer('unknown')).toBe(false);
    expect(service.hasProducer('unknown')).toBe(false);

    await moduleRef.close();
  });

  it('updates consumer runtime options through sqs-consumer API', async () => {
    @Injectable()
    class Handler {
      @SqsMessageHandler('orders')
      public async handleMessage() {
        return undefined;
      }
    }

    const moduleRef = await Test.createTestingModule({
      imports: [
        SqsModule.register({
          consumers: [{ name: 'orders', queueUrl: 'https://example.com/orders' }],
        }),
      ],
      providers: [Handler],
    }).compile();

    await moduleRef.init();

    const service = moduleRef.get(SqsService);
    const consumer = service.getConsumer('orders') as unknown as MockConsumer;

    service.updateConsumerOption('orders', 'batchSize', 5);

    expect(consumer.updateOption).toHaveBeenCalledWith('batchSize', 5);

    await moduleRef.close();
  });

  it('throws when non-batch handler returns an array', async () => {
    @Injectable()
    class Handler {
      @SqsMessageHandler('orders')
      public async handleMessage(_message: Message) {
        return [{ MessageId: 'wrong' }];
      }
    }

    const moduleRef = await Test.createTestingModule({
      imports: [
        SqsModule.register({
          consumers: [{ name: 'orders', queueUrl: 'https://example.com/orders' }],
        }),
      ],
      providers: [Handler],
    }).compile();

    await moduleRef.init();

    const consumerOptions = consumerCreateSpy.mock.calls[0][0] as {
      handleMessage?: (message: Message) => Promise<Message | undefined>;
    };

    await expect(
      consumerOptions.handleMessage?.({
        MessageId: 'm-1',
        Body: '{"ok":true}',
      }),
    ).rejects.toThrow(SqsConfigurationError);

    await moduleRef.close();
  });

  it('throws when batch handler returns a non-array value', async () => {
    @Injectable()
    class Handler {
      @SqsMessageHandler('orders', { batch: true })
      public async handleBatch(_messages: Message[]) {
        return { MessageId: 'wrong' };
      }
    }

    const moduleRef = await Test.createTestingModule({
      imports: [
        SqsModule.register({
          consumers: [{ name: 'orders', queueUrl: 'https://example.com/orders' }],
        }),
      ],
      providers: [Handler],
    }).compile();

    await moduleRef.init();

    const consumerOptions = consumerCreateSpy.mock.calls[0][0] as {
      handleMessageBatch?: (messages: Message[]) => Promise<Message[]>;
    };

    await expect(
      consumerOptions.handleMessageBatch?.([
        {
          MessageId: 'm-1',
          Body: '{"ok":true}',
        },
      ]),
    ).rejects.toThrow(SqsConfigurationError);

    await moduleRef.close();
  });

  it('applies merged stop options when shutting down a consumer', async () => {
    @Injectable()
    class Handler {
      @SqsMessageHandler('orders')
      public async handleMessage() {
        return undefined;
      }
    }

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [
        SqsModule.register({
          globalStopOptions: { abort: false },
          consumers: [
            {
              name: 'orders',
              queueUrl: 'https://example.com/orders',
              stopOptions: { abort: true },
            },
          ],
        }),
      ],
      providers: [Handler],
    }).compile();

    await moduleRef.init();

    const service = moduleRef.get(SqsService);
    const consumer = service.getConsumer('orders') as unknown as MockConsumer;

    await service.stopConsumer('orders');

    expect(consumer.stop).toHaveBeenCalledWith({ abort: true });

    await moduleRef.close();
  });

  it('waits for consumer stopped event before resolving stopConsumer', async () => {
    vi.useFakeTimers();

    @Injectable()
    class Handler {
      @SqsMessageHandler('orders')
      public async handleMessage() {
        return undefined;
      }
    }

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [
        SqsModule.register({
          consumers: [{ name: 'orders', queueUrl: 'https://example.com/orders' }],
        }),
      ],
      providers: [Handler],
    }).compile();

    await moduleRef.init();

    const service = moduleRef.get(SqsService);
    const consumer = service.getConsumer('orders') as unknown as MockConsumer;

    consumer.stop.mockImplementationOnce(() => {
      consumer.status.isRunning = false;
      setTimeout(() => {
        consumer.emit('stopped');
      }, 50);
    });

    let settled = false;
    const stopPromise = service.stopConsumer('orders', { timeoutMs: 500 }).then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(49);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await stopPromise;
    expect(settled).toBe(true);

    await moduleRef.close();
  });

  it('stops consumers on onModuleDestroy', async () => {
    @Injectable()
    class Handler {
      @SqsMessageHandler('orders')
      public async handleMessage() {
        return undefined;
      }
    }

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [
        SqsModule.register({
          consumers: [{ name: 'orders', queueUrl: 'https://example.com/orders' }],
        }),
      ],
      providers: [Handler],
    }).compile();

    await moduleRef.init();

    const service = moduleRef.get(SqsService);
    const consumer = service.getConsumer('orders') as unknown as MockConsumer;

    await service.onModuleDestroy();

    expect(consumer.stop).toHaveBeenCalledTimes(1);

    await moduleRef.close();
  });
});
