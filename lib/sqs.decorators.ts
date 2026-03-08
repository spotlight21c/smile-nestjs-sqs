import { SetMetadata } from '@nestjs/common';
import { SQS_EVENT_HANDLER_METADATA, SQS_MESSAGE_HANDLER_METADATA } from './sqs.constants';
import type {
  QueueName,
  SqsConsumerEventHandlerMetadata,
  SqsConsumerEventName,
  SqsMessageHandlerMetadata,
} from './sqs.types';

export function SqsMessageHandler(name: QueueName, options?: boolean | { batch?: boolean }): MethodDecorator {
  const metadata: SqsMessageHandlerMetadata = {
    name,
    batch: typeof options === 'boolean' ? options : (options?.batch ?? false),
  };

  return SetMetadata(SQS_MESSAGE_HANDLER_METADATA, metadata);
}

export function SqsConsumerEventHandler(name: QueueName, eventName: SqsConsumerEventName): MethodDecorator {
  const metadata: SqsConsumerEventHandlerMetadata = {
    name,
    eventName,
  };

  return SetMetadata(SQS_EVENT_HANDLER_METADATA, metadata);
}
