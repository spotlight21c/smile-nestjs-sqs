import type { QueueAttributeName, SQSClient, SendMessageBatchResultEntry } from '@aws-sdk/client-sqs';
import type { LoggerService, ModuleMetadata, Type } from '@nestjs/common';
import type { Consumer, Events as ConsumerEvents, ConsumerOptions, StopOptions, UpdatableOptions } from 'sqs-consumer';
import type { Producer, Message as ProducerMessage, ProducerOptions } from 'sqs-producer';

export type QueueName = string;
export type SqsConsumerEventName = keyof ConsumerEvents;

export type SqsConsumerOptions = Omit<ConsumerOptions, 'handleMessage' | 'handleMessageBatch'> & {
  name: QueueName;
  stopOptions?: StopOptions;
};

export type SqsProducerOptions = ProducerOptions & {
  name: QueueName;
};

export interface SqsBodySerializerContext {
  queueName: QueueName;
}

export type SqsBodySerializer = (body: unknown, context: SqsBodySerializerContext) => string;

export interface SqsOptions {
  consumers?: SqsConsumerOptions[];
  producers?: SqsProducerOptions[];
  isGlobal?: boolean;
  defaultSqsClient?: SQSClient;
  logger?: LoggerService;
  globalStopOptions?: StopOptions;
  includeControllers?: boolean;
  shutdownTimeoutMs?: number;
  defaultStrictReturn?: boolean;
  bodySerializer?: SqsBodySerializer;
}

export interface SqsModuleOptionsFactory {
  createSqsOptions(): Promise<SqsOptions> | SqsOptions;
}

export interface SqsModuleAsyncOptions extends Pick<ModuleMetadata, 'imports'> {
  isGlobal?: boolean;
  useExisting?: Type<SqsModuleOptionsFactory>;
  useClass?: Type<SqsModuleOptionsFactory>;
  useFactory?: (...args: unknown[]) => Promise<SqsOptions> | SqsOptions;
  inject?: Array<Type<unknown> | string | symbol>;
}

export interface SqsSendMessage<T = unknown> extends Omit<ProducerMessage, 'body'> {
  body: T;
}

export interface SqsMessageHandlerMetadata {
  name: QueueName;
  batch: boolean;
}

export interface SqsConsumerEventHandlerMetadata {
  name: QueueName;
  eventName: SqsConsumerEventName;
}

export interface DiscoveredMessageHandler {
  metadata: SqsMessageHandlerMetadata;
  instance: object;
  methodName: string;
  handler: (...args: unknown[]) => unknown;
}

export interface DiscoveredEventHandler {
  metadata: SqsConsumerEventHandlerMetadata;
  instance: object;
  methodName: string;
  handler: (...args: unknown[]) => unknown;
}

export interface SqsDiscoveredHandlers {
  messageHandlers: DiscoveredMessageHandler[];
  eventHandlers: DiscoveredEventHandler[];
}

export interface SqsConsumerContext {
  name: QueueName;
  queueUrl: string;
  sqs: SQSClient;
  instance: Consumer;
  stopOptions: StopOptions;
  messageHandler: DiscoveredMessageHandler;
  eventHandlers: DiscoveredEventHandler[];
}

export interface SqsProducerContext {
  name: QueueName;
  queueUrl: string;
  sqs: SQSClient;
  instance: Producer;
}

export type QueueAttributes = Partial<Record<QueueAttributeName, string>>;
export type SqsSendResult = SendMessageBatchResultEntry[];

export interface SqsStopConsumerOptions extends StopOptions {
  timeoutMs?: number;
}

export type SqsUpdatableConsumerOption = UpdatableOptions;
