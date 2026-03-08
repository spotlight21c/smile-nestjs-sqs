import { GetQueueAttributesCommand, PurgeQueueCommand, type QueueAttributeName, SQSClient } from '@aws-sdk/client-sqs';
import {
  Inject,
  Injectable,
  Logger,
  type LoggerService,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { Consumer, type ConsumerOptions, type StopOptions } from 'sqs-consumer';
import { Producer, type Message as ProducerMessage } from 'sqs-producer';
import { SQS_CONSUMER_EVENT_NAME_SET, SQS_OPTIONS } from './sqs.constants';
import { SqsConfigurationError, SqsNotFoundError, SqsSerializationError } from './sqs.errors';
import { SqsExplorer } from './sqs.explorer';
import { SqsRegistry } from './sqs.registry';
import type {
  DiscoveredEventHandler,
  DiscoveredMessageHandler,
  QueueAttributes,
  QueueName,
  SqsConsumerContext,
  SqsConsumerOptions,
  SqsOptions,
  SqsProducerOptions,
  SqsSendMessage,
  SqsSendResult,
  SqsStopConsumerOptions,
  SqsUpdatableConsumerOption,
} from './sqs.types';

@Injectable()
export class SqsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly shutdownTimeoutMs: number;
  private readonly defaultStrictReturn: boolean;
  private logger: LoggerService;

  public constructor(
    @Inject(SQS_OPTIONS) public readonly options: SqsOptions,
    @Inject(SqsExplorer)
    private readonly explorer: SqsExplorer,
    @Inject(SqsRegistry)
    private readonly registry: SqsRegistry,
  ) {
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? 30_000;
    this.defaultStrictReturn = options.defaultStrictReturn ?? true;
    this.logger = options.logger ?? new Logger(SqsService.name, { timestamp: false });
  }

  public async onApplicationBootstrap(): Promise<void> {
    const discovered = this.explorer.explore({
      includeControllers: this.options.includeControllers ?? false,
    });

    const messageHandlersByName = this.indexMessageHandlers(discovered.messageHandlers);
    const eventHandlersByName = this.indexEventHandlers(discovered.eventHandlers);

    this.registerConsumers(messageHandlersByName, eventHandlersByName);
    this.registerProducers();
    this.warnUnusedHandlers(messageHandlersByName, eventHandlersByName);

    this.startAllConsumers();
  }

  public async onModuleDestroy(): Promise<void> {
    await this.stopAllConsumers();
  }

  public getConsumer(name: QueueName): Consumer {
    return this.registry.getConsumer(name).instance;
  }

  public getProducer(name: QueueName): Producer {
    return this.registry.getProducer(name).instance;
  }

  public hasConsumer(name: QueueName): boolean {
    return this.registry.findConsumer(name) !== undefined;
  }

  public hasProducer(name: QueueName): boolean {
    return this.registry.findProducer(name) !== undefined;
  }

  public getConsumerStatus(name: QueueName): { isRunning: boolean; isPolling: boolean } {
    return this.getConsumer(name).status;
  }

  public updateConsumerOption(name: QueueName, option: SqsUpdatableConsumerOption, value: number): void {
    this.getConsumer(name).updateOption(option, value);
  }

  public startConsumer(name: QueueName): void {
    this.getConsumer(name).start();
  }

  public async stopConsumer(name: QueueName, options: SqsStopConsumerOptions = {}): Promise<void> {
    const context = this.registry.getConsumer(name);
    await this.stopConsumerContext(context, options);
  }

  public async stopAllConsumers(options: SqsStopConsumerOptions = {}): Promise<void> {
    const contexts = this.registry.getConsumers();
    await Promise.all(contexts.map(async (context) => await this.stopConsumerContext(context, options)));
  }

  public async purgeQueue(name: QueueName): Promise<void> {
    const queueInfo = this.getQueueInfo(name);
    await queueInfo.sqs.send(
      new PurgeQueueCommand({
        QueueUrl: queueInfo.queueUrl,
      }),
    );
  }

  public async getQueueAttributes(
    name: QueueName,
    attributeNames: QueueAttributeName[] = ['All'],
  ): Promise<QueueAttributes> {
    const queueInfo = this.getQueueInfo(name);
    const response = await queueInfo.sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: queueInfo.queueUrl,
        AttributeNames: attributeNames,
      }),
    );

    return response.Attributes ?? {};
  }

  public async getProducerQueueSize(name: QueueName): Promise<number> {
    return await this.registry.getProducer(name).instance.queueSize();
  }

  public async send<T = unknown>(
    name: QueueName,
    payload: SqsSendMessage<T> | SqsSendMessage<T>[],
  ): Promise<SqsSendResult> {
    const producer = this.registry.getProducer(name).instance;
    const originalMessages = Array.isArray(payload) ? payload : [payload];

    const serializedMessages: ProducerMessage[] = originalMessages.map((message) => ({
      ...message,
      body: this.serializeBody(name, message.body),
    }));

    return await producer.send(serializedMessages);
  }

  private registerConsumers(
    messageHandlersByName: Map<QueueName, DiscoveredMessageHandler>,
    eventHandlersByName: Map<QueueName, DiscoveredEventHandler[]>,
  ): void {
    for (const options of this.options.consumers ?? []) {
      if (this.registry.findConsumer(options.name)) {
        throw new SqsConfigurationError(`Consumer \"${options.name}\" is already registered.`);
      }

      const messageHandler = messageHandlersByName.get(options.name);
      if (!messageHandler) {
        throw new SqsConfigurationError(`No @SqsMessageHandler was found for consumer \"${options.name}\".`);
      }

      this.validateMessageHandlerContract(options.name, messageHandler);

      const eventHandlers = eventHandlersByName.get(options.name) ?? [];
      this.validateEventHandlers(options.name, eventHandlers);

      const sqs = this.resolveConsumerClient(options);
      const consumer = this.createConsumer(options, messageHandler, sqs);

      for (const eventHandler of eventHandlers) {
        this.addConsumerEventListener(consumer, eventHandler);
      }

      const stopOptions: StopOptions = {
        ...(this.options.globalStopOptions ?? {}),
        ...(options.stopOptions ?? {}),
      };

      this.registry.addConsumer({
        name: options.name,
        queueUrl: options.queueUrl,
        sqs,
        instance: consumer,
        stopOptions,
        messageHandler,
        eventHandlers,
      });
    }
  }

  private registerProducers(): void {
    for (const options of this.options.producers ?? []) {
      if (this.registry.findProducer(options.name)) {
        throw new SqsConfigurationError(`Producer \"${options.name}\" is already registered.`);
      }

      const sqs = this.resolveProducerClient(options);
      const { name: _name, ...producerOptions } = options;
      const producer = Producer.create({
        ...producerOptions,
        sqs,
      });

      const existingConsumer = this.registry.findConsumer(options.name);
      if (existingConsumer && existingConsumer.queueUrl !== options.queueUrl) {
        throw new SqsConfigurationError(
          `Queue name \"${options.name}\" is configured for both consumer and producer with different queueUrl values.`,
        );
      }

      this.registry.addProducer({
        name: options.name,
        queueUrl: options.queueUrl,
        sqs,
        instance: producer,
      });
    }
  }

  private startAllConsumers(): void {
    for (const context of this.registry.getConsumers()) {
      context.instance.start();
    }
  }

  private async stopConsumerContext(context: SqsConsumerContext, options: SqsStopConsumerOptions): Promise<void> {
    if (!context.instance.status.isRunning) {
      return;
    }

    const { timeoutMs, ...stopOptions } = options;
    const mergedOptions: StopOptions = {
      ...context.stopOptions,
      ...stopOptions,
    };

    const waitTimeoutMs = timeoutMs ?? this.shutdownTimeoutMs;
    await new Promise<void>((resolve) => {
      let settled = false;
      const cleanup = () => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timeout);
        context.instance.off('stopped', handleStopped);
        resolve();
      };

      const handleStopped = () => {
        cleanup();
      };

      context.instance.once('stopped', handleStopped);
      const timeout = setTimeout(() => {
        this.logger.warn(`Timed out while waiting consumer \"${context.name}\" to stop.`);
        cleanup();
      }, waitTimeoutMs);

      context.instance.stop(mergedOptions);
    });
  }

  private indexMessageHandlers(handlers: DiscoveredMessageHandler[]): Map<QueueName, DiscoveredMessageHandler> {
    const byName = new Map<QueueName, DiscoveredMessageHandler>();

    for (const handler of handlers) {
      if (byName.has(handler.metadata.name)) {
        const existing = byName.get(handler.metadata.name);
        throw new SqsConfigurationError(
          `Multiple @SqsMessageHandler methods found for queue \"${handler.metadata.name}\" (${existing?.methodName}, ${handler.methodName}).`,
        );
      }

      byName.set(handler.metadata.name, handler);
    }

    return byName;
  }

  private indexEventHandlers(handlers: DiscoveredEventHandler[]): Map<QueueName, DiscoveredEventHandler[]> {
    const byName = new Map<QueueName, DiscoveredEventHandler[]>();

    for (const handler of handlers) {
      const existingHandlers = byName.get(handler.metadata.name);
      if (existingHandlers) {
        existingHandlers.push(handler);
      } else {
        byName.set(handler.metadata.name, [handler]);
      }
    }

    return byName;
  }

  private warnUnusedHandlers(
    messageHandlersByName: Map<QueueName, DiscoveredMessageHandler>,
    eventHandlersByName: Map<QueueName, DiscoveredEventHandler[]>,
  ): void {
    const configuredConsumerNames = new Set((this.options.consumers ?? []).map((consumer) => consumer.name));

    for (const queueName of messageHandlersByName.keys()) {
      if (!configuredConsumerNames.has(queueName)) {
        this.logger.warn(
          `@SqsMessageHandler exists for queue \"${queueName}\" but no matching consumer is configured.`,
        );
      }
    }

    for (const queueName of eventHandlersByName.keys()) {
      if (!configuredConsumerNames.has(queueName)) {
        throw new SqsConfigurationError(
          `@SqsConsumerEventHandler exists for queue \"${queueName}\" but no matching consumer is configured.`,
        );
      }
    }
  }

  private validateEventHandlers(name: QueueName, eventHandlers: DiscoveredEventHandler[]): void {
    for (const eventHandler of eventHandlers) {
      if (!SQS_CONSUMER_EVENT_NAME_SET.has(eventHandler.metadata.eventName)) {
        throw new SqsConfigurationError(
          `Unsupported SQS consumer event \"${eventHandler.metadata.eventName}\" for queue \"${name}\".`,
        );
      }
    }
  }

  private addConsumerEventListener(consumer: Consumer, eventHandler: DiscoveredEventHandler): void {
    const addListener = consumer.on.bind(consumer) as (event: string, listener: (...args: unknown[]) => void) => void;
    addListener(eventHandler.metadata.eventName, eventHandler.handler.bind(eventHandler.instance));
  }

  private createConsumer(
    options: SqsConsumerOptions,
    messageHandler: DiscoveredMessageHandler,
    sqs: SQSClient,
  ): Consumer {
    const baseOptions: SqsConsumerOptions = {
      ...options,
      sqs,
      strictReturn: options.strictReturn ?? this.defaultStrictReturn,
    };

    const boundHandler = messageHandler.handler.bind(messageHandler.instance);

    if (messageHandler.metadata.batch) {
      const handleMessageBatch: NonNullable<ConsumerOptions['handleMessageBatch']> = async (messages) => {
        const result = await Promise.resolve(boundHandler(messages));
        this.validateBatchHandlerReturn(options.name, messageHandler.methodName, result);
        return result as Awaited<ReturnType<NonNullable<ConsumerOptions['handleMessageBatch']>>>;
      };

      return Consumer.create({
        ...this.toConsumerCreateOptions(baseOptions),
        handleMessageBatch,
      });
    }

    const handleMessage: NonNullable<ConsumerOptions['handleMessage']> = async (message) => {
      const result = await Promise.resolve(boundHandler(message));
      this.validateSingleHandlerReturn(options.name, messageHandler.methodName, result);
      return result as Awaited<ReturnType<NonNullable<ConsumerOptions['handleMessage']>>>;
    };

    return Consumer.create({
      ...this.toConsumerCreateOptions(baseOptions),
      handleMessage,
    });
  }

  private toConsumerCreateOptions(
    options: SqsConsumerOptions,
  ): Omit<ConsumerOptions, 'handleMessage' | 'handleMessageBatch'> {
    const { name, stopOptions, ...consumerOptions } = options;
    void name;
    void stopOptions;
    return consumerOptions;
  }

  private validateMessageHandlerContract(name: QueueName, messageHandler: DiscoveredMessageHandler): void {
    const prototype = Object.getPrototypeOf(messageHandler.instance) as object | undefined;
    const reflectedParameterTypes =
      prototype &&
      (Reflect.getMetadata('design:paramtypes', prototype, messageHandler.methodName) as unknown[] | undefined);
    const firstParameterType = reflectedParameterTypes?.[0];

    if (messageHandler.metadata.batch && firstParameterType && firstParameterType !== Array) {
      throw new SqsConfigurationError(
        `@SqsMessageHandler(\"${name}\", { batch: true }) method \"${messageHandler.methodName}\" must declare its first parameter as an array type.`,
      );
    }

    if (!messageHandler.metadata.batch && firstParameterType === Array) {
      throw new SqsConfigurationError(
        `@SqsMessageHandler(\"${name}\") method \"${messageHandler.methodName}\" must not declare its first parameter as an array type.`,
      );
    }
  }

  private validateSingleHandlerReturn(name: QueueName, methodName: string, result: unknown): void {
    if (result === undefined || result === null) {
      return;
    }

    if (Array.isArray(result) || typeof result !== 'object') {
      throw new SqsConfigurationError(
        `@SqsMessageHandler(\"${name}\") method \"${methodName}\" returned an invalid value. Expected a message-like object, undefined, or null.`,
      );
    }
  }

  private validateBatchHandlerReturn(name: QueueName, methodName: string, result: unknown): void {
    if (result === undefined || result === null) {
      return;
    }

    if (!Array.isArray(result)) {
      throw new SqsConfigurationError(
        `@SqsMessageHandler(\"${name}\", { batch: true }) method \"${methodName}\" returned an invalid value. Expected Message[], undefined, or null.`,
      );
    }

    const hasInvalidItem = result.some((message) => !message || typeof message !== 'object' || Array.isArray(message));
    if (hasInvalidItem) {
      throw new SqsConfigurationError(
        `@SqsMessageHandler(\"${name}\", { batch: true }) method \"${methodName}\" must return an array of message-like objects.`,
      );
    }
  }

  private resolveConsumerClient(options: SqsConsumerOptions): SQSClient {
    if (options.sqs) {
      return options.sqs;
    }

    if (this.options.defaultSqsClient) {
      return this.options.defaultSqsClient;
    }

    return new SQSClient({
      region: options.region ?? process.env.AWS_REGION ?? 'eu-west-1',
      useQueueUrlAsEndpoint: options.useQueueUrlAsEndpoint ?? true,
    });
  }

  private resolveProducerClient(options: SqsProducerOptions): SQSClient {
    if (options.sqs) {
      return options.sqs;
    }

    if (this.options.defaultSqsClient) {
      return this.options.defaultSqsClient;
    }

    return new SQSClient({
      region: options.region ?? process.env.AWS_REGION ?? 'eu-west-1',
      useQueueUrlAsEndpoint: options.useQueueUrlAsEndpoint ?? true,
    });
  }

  private getQueueInfo(name: QueueName): { queueUrl: string; sqs: SQSClient } {
    const producerContext = this.registry.findProducer(name);
    if (producerContext) {
      return {
        queueUrl: producerContext.queueUrl,
        sqs: producerContext.sqs,
      };
    }

    const consumerContext = this.registry.findConsumer(name);
    if (consumerContext) {
      return {
        queueUrl: consumerContext.queueUrl,
        sqs: consumerContext.sqs,
      };
    }

    throw new SqsNotFoundError(`Consumer/producer \"${name}\" was not found.`);
  }

  private serializeBody(name: QueueName, body: unknown): string {
    if (typeof body === 'string') {
      return body;
    }

    if (body === undefined) {
      throw new SqsSerializationError(`Message body for queue \"${name}\" cannot be undefined.`);
    }

    const serializer = this.options.bodySerializer;
    const serialized = serializer ? serializer(body, { queueName: name }) : JSON.stringify(body);

    if (typeof serialized !== 'string') {
      throw new SqsSerializationError(`Message body serializer must return a string for queue \"${name}\".`);
    }

    return serialized;
  }
}
