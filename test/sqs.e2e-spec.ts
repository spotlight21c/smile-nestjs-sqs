import 'reflect-metadata';

import { CreateQueueCommand, DeleteQueueCommand, type Message, SQSClient } from '@aws-sdk/client-sqs';
import { Injectable } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqsConsumerEventHandler, SqsMessageHandler, SqsModule, SqsService } from '../lib';

describe('SqsModule E2E (real queue integration)', () => {
  const endpoint = process.env.SQS_ENDPOINT ?? 'http://127.0.0.1:4566';
  const region = process.env.AWS_REGION ?? 'us-east-1';
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID ?? 'test';
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY ?? 'test';

  const ordersQueueName = `orders-${Date.now()}`;
  const batchQueueName = `batch-orders-${Date.now()}`;
  const sqsClient = new SQSClient({
    endpoint,
    region,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  });

  let moduleRef: TestingModule | undefined;
  let sqsService: SqsService;
  let queueUrls: string[] = [];
  let singleHandlerResult: 'message' | 'throw' | 'undefined' = 'message';
  let batchMessageIdToRetry: string | undefined;

  const messageDeliveries: MessageDelivery[] = [];
  const batchDeliveries: MessageDelivery[][] = [];
  const processingErrorSpy = vi.fn();

  interface MessageDelivery {
    id: string;
    sqsMessageId: string | undefined;
  }

  @Injectable()
  class OrdersHandler {
    @SqsMessageHandler('orders')
    public async onMessage(message: Message): Promise<Message | undefined> {
      const body = JSON.parse(message.Body ?? '{}') as { id?: string };
      if (body.id) {
        messageDeliveries.push({ id: body.id, sqsMessageId: message.MessageId });
      }

      if (singleHandlerResult === 'throw') {
        singleHandlerResult = 'message';
        throw new Error('forced-processing-error');
      }

      if (singleHandlerResult === 'undefined') {
        singleHandlerResult = 'message';
        return undefined;
      }

      return message;
    }

    @SqsConsumerEventHandler('orders', 'processing_error')
    public onProcessingError(error: Error): void {
      processingErrorSpy(error);
    }
  }

  @Injectable()
  class BatchOrdersHandler {
    @SqsMessageHandler('batch-orders', { batch: true })
    public async onMessages(messages: Message[]): Promise<Message[]> {
      const deliveries = messages.flatMap((message) => {
        const body = JSON.parse(message.Body ?? '{}') as { id?: string };
        return body.id ? [{ id: body.id, sqsMessageId: message.MessageId }] : [];
      });
      batchDeliveries.push(deliveries);

      if (batchMessageIdToRetry) {
        const messageIdToRetry = batchMessageIdToRetry;
        batchMessageIdToRetry = undefined;
        return messages.filter((message) => JSON.parse(message.Body ?? '{}').id !== messageIdToRetry);
      }

      return messages;
    }
  }

  beforeAll(async () => {
    const createQueue = async (queueName: string): Promise<string> => {
      const createQueueResult = await sqsClient.send(
        new CreateQueueCommand({
          QueueName: queueName,
          Attributes: {
            VisibilityTimeout: '1',
          },
        }),
      );
      if (!createQueueResult.QueueUrl) {
        throw new Error('Failed to create test queue for e2e.');
      }
      return createQueueResult.QueueUrl;
    };

    const [ordersQueueUrl, batchQueueUrl] = await Promise.all([
      createQueue(ordersQueueName),
      createQueue(batchQueueName),
    ]);
    if (!ordersQueueUrl || !batchQueueUrl) {
      throw new Error('Failed to create test queue for e2e.');
    }
    queueUrls = [ordersQueueUrl, batchQueueUrl];

    moduleRef = await Test.createTestingModule({
      imports: [
        SqsModule.register({
          defaultSqsClient: sqsClient,
          consumers: [
            {
              name: 'orders',
              queueUrl: ordersQueueUrl,
              waitTimeSeconds: 1,
              batchSize: 1,
            },
            {
              name: 'batch-orders',
              queueUrl: batchQueueUrl,
              waitTimeSeconds: 1,
              batchSize: 2,
            },
          ],
          producers: [
            {
              name: 'orders',
              queueUrl: ordersQueueUrl,
            },
            {
              name: 'batch-orders',
              queueUrl: batchQueueUrl,
            },
          ],
        }),
      ],
      providers: [OrdersHandler, BatchOrdersHandler],
    }).compile();

    await moduleRef.init();
    sqsService = moduleRef.get(SqsService);
    await vi.waitFor(
      () => {
        expect(sqsService.getConsumerStatus('orders').isRunning).toBe(true);
        expect(sqsService.getConsumerStatus('batch-orders').isRunning).toBe(true);
      },
      {
        timeout: 15_000,
        interval: 200,
      },
    );
  });

  beforeEach(() => {
    singleHandlerResult = 'message';
    batchMessageIdToRetry = undefined;
    messageDeliveries.length = 0;
    batchDeliveries.length = 0;
    processingErrorSpy.mockReset();
  });

  afterAll(async () => {
    await moduleRef?.close();
    await Promise.all(queueUrls.map(async (QueueUrl) => await sqsClient.send(new DeleteQueueCommand({ QueueUrl }))));
  });

  it('processes published messages through real SQS queue', async () => {
    const messageId = `msg-${Date.now()}`;
    expect(sqsService.hasConsumer('orders')).toBe(true);
    expect(sqsService.hasProducer('orders')).toBe(true);

    await sqsService.send('orders', {
      id: messageId,
      body: { id: messageId, type: 'created' },
    });

    await vi.waitFor(
      () => {
        expect(messageDeliveries).toContainEqual({ id: messageId, sqsMessageId: expect.any(String) });
      },
      {
        timeout: 20_000,
        interval: 250,
      },
    );
  });

  it('redelivers the same message after a handler failure', async () => {
    singleHandlerResult = 'throw';
    const messageId = `err-${Date.now()}`;
    await sqsService.send('orders', {
      id: messageId,
      body: { id: messageId, type: 'error' },
    });

    await vi.waitFor(
      () => {
        expect(processingErrorSpy).toHaveBeenCalled();
      },
      {
        timeout: 20_000,
        interval: 250,
      },
    );

    await vi.waitFor(
      () => {
        const deliveries = messageDeliveries.filter((delivery) => delivery.id === messageId);
        expect(deliveries).toHaveLength(2);
        expect(deliveries[0]?.sqsMessageId).toBeTruthy();
        expect(new Set(deliveries.map((delivery) => delivery.sqsMessageId)).size).toBe(1);
      },
      {
        timeout: 20_000,
        interval: 250,
      },
    );
  });

  it('redelivers the same message when a single-message handler returns undefined', async () => {
    singleHandlerResult = 'undefined';
    const messageId = `undefined-${Date.now()}`;
    await sqsService.send('orders', {
      id: messageId,
      body: { id: messageId, type: 'undefined' },
    });

    await vi.waitFor(
      () => {
        const deliveries = messageDeliveries.filter((delivery) => delivery.id === messageId);
        expect(deliveries).toHaveLength(2);
        expect(deliveries[0]?.sqsMessageId).toBeTruthy();
        expect(new Set(deliveries.map((delivery) => delivery.sqsMessageId)).size).toBe(1);
      },
      {
        timeout: 20_000,
        interval: 250,
      },
    );
  });

  it('redelivers batch messages excluded from the returned array', async () => {
    const acknowledgedMessageId = `batch-ack-${Date.now()}`;
    const retriedMessageId = `batch-retry-${Date.now()}`;
    batchMessageIdToRetry = retriedMessageId;
    await sqsService.send('batch-orders', [
      {
        id: acknowledgedMessageId,
        body: { id: acknowledgedMessageId, type: 'batch' },
      },
      {
        id: retriedMessageId,
        body: { id: retriedMessageId, type: 'batch' },
      },
    ]);
    sqsService.startConsumer('batch-orders');

    await vi.waitFor(
      () => {
        expect(batchDeliveries[0]).toEqual(
          expect.arrayContaining([
            { id: acknowledgedMessageId, sqsMessageId: expect.any(String) },
            { id: retriedMessageId, sqsMessageId: expect.any(String) },
          ]),
        );
      },
      {
        timeout: 20_000,
        interval: 250,
      },
    );

    await vi.waitFor(
      () => {
        const retriedDeliveries = batchDeliveries.flat().filter((delivery) => delivery.id === retriedMessageId);
        expect(retriedDeliveries).toHaveLength(2);
        expect(retriedDeliveries[0]?.sqsMessageId).toBeTruthy();
        expect(new Set(retriedDeliveries.map((delivery) => delivery.sqsMessageId)).size).toBe(1);
      },
      {
        timeout: 20_000,
        interval: 250,
      },
    );
  });
});
