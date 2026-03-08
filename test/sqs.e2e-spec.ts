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

  const queueName = `orders-${Date.now()}`;
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
  let queueUrl: string | undefined;
  let shouldThrow = false;

  const receivedMessageIds: string[] = [];
  const processingErrorSpy = vi.fn();

  @Injectable()
  class OrdersHandler {
    @SqsMessageHandler('orders')
    public async onMessage(message: Message): Promise<Message | undefined> {
      const body = JSON.parse(message.Body ?? '{}') as { id?: string };
      if (shouldThrow) {
        throw new Error('forced-processing-error');
      }

      if (body.id) {
        receivedMessageIds.push(body.id);
      }
      return message;
    }

    @SqsConsumerEventHandler('orders', 'processing_error')
    public onProcessingError(error: Error): void {
      processingErrorSpy(error);
    }
  }

  beforeAll(async () => {
    const createQueueResult = await sqsClient.send(
      new CreateQueueCommand({
        QueueName: queueName,
      }),
    );
    if (!createQueueResult.QueueUrl) {
      throw new Error('Failed to create test queue for e2e.');
    }
    queueUrl = createQueueResult.QueueUrl;

    moduleRef = await Test.createTestingModule({
      imports: [
        SqsModule.register({
          defaultSqsClient: sqsClient,
          consumers: [
            {
              name: 'orders',
              queueUrl,
              waitTimeSeconds: 1,
              batchSize: 1,
            },
          ],
          producers: [
            {
              name: 'orders',
              queueUrl,
            },
          ],
        }),
      ],
      providers: [OrdersHandler],
    }).compile();

    await moduleRef.init();
    sqsService = moduleRef.get(SqsService);
    await vi.waitFor(
      () => {
        expect(sqsService.getConsumerStatus('orders').isRunning).toBe(true);
      },
      {
        timeout: 15_000,
        interval: 200,
      },
    );
  });

  beforeEach(() => {
    shouldThrow = false;
    processingErrorSpy.mockReset();
  });

  afterAll(async () => {
    await moduleRef?.close();
    if (queueUrl) {
      await sqsClient.send(
        new DeleteQueueCommand({
          QueueUrl: queueUrl,
        }),
      );
    }
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
        expect(receivedMessageIds).toContain(messageId);
      },
      {
        timeout: 20_000,
        interval: 250,
      },
    );
  });

  it('emits processing_error event on handler failure', async () => {
    shouldThrow = true;
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
  });
});
