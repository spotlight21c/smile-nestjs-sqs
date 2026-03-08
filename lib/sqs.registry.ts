import { Injectable } from '@nestjs/common';
import { SqsConfigurationError, SqsNotFoundError } from './sqs.errors';
import type { QueueName, SqsConsumerContext, SqsProducerContext } from './sqs.types';

@Injectable()
export class SqsRegistry {
  private readonly consumers = new Map<QueueName, SqsConsumerContext>();
  private readonly producers = new Map<QueueName, SqsProducerContext>();

  public addConsumer(context: SqsConsumerContext): void {
    if (this.consumers.has(context.name)) {
      throw new SqsConfigurationError(`Consumer \"${context.name}\" is already registered.`);
    }

    this.consumers.set(context.name, context);
  }

  public addProducer(context: SqsProducerContext): void {
    if (this.producers.has(context.name)) {
      throw new SqsConfigurationError(`Producer \"${context.name}\" is already registered.`);
    }

    this.producers.set(context.name, context);
  }

  public getConsumer(name: QueueName): SqsConsumerContext {
    const context = this.consumers.get(name);
    if (!context) {
      throw new SqsNotFoundError(`Consumer \"${name}\" was not found.`);
    }

    return context;
  }

  public getProducer(name: QueueName): SqsProducerContext {
    const context = this.producers.get(name);
    if (!context) {
      throw new SqsNotFoundError(`Producer \"${name}\" was not found.`);
    }

    return context;
  }

  public findConsumer(name: QueueName): SqsConsumerContext | undefined {
    return this.consumers.get(name);
  }

  public findProducer(name: QueueName): SqsProducerContext | undefined {
    return this.producers.get(name);
  }

  public getConsumers(): SqsConsumerContext[] {
    return [...this.consumers.values()];
  }

  public getProducers(): SqsProducerContext[] {
    return [...this.producers.values()];
  }
}
