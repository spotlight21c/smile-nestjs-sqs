import { Inject, Injectable } from '@nestjs/common';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';
import { SQS_EVENT_HANDLER_METADATA, SQS_MESSAGE_HANDLER_METADATA } from './sqs.constants';
import type {
  DiscoveredEventHandler,
  DiscoveredMessageHandler,
  SqsConsumerEventHandlerMetadata,
  SqsDiscoveredHandlers,
  SqsMessageHandlerMetadata,
} from './sqs.types';

@Injectable()
export class SqsExplorer {
  public constructor(
    @Inject(DiscoveryService)
    private readonly discoveryService: DiscoveryService,
    @Inject(MetadataScanner)
    private readonly metadataScanner: MetadataScanner,
  ) {}

  public explore(options?: { includeControllers?: boolean }): SqsDiscoveredHandlers {
    const includeControllers = options?.includeControllers ?? false;
    const wrappers = includeControllers
      ? [...this.discoveryService.getProviders(), ...this.discoveryService.getControllers()]
      : this.discoveryService.getProviders();

    const messageHandlers: DiscoveredMessageHandler[] = [];
    const eventHandlers: DiscoveredEventHandler[] = [];

    for (const wrapper of wrappers) {
      if (typeof wrapper.isDependencyTreeStatic === 'function' && !wrapper.isDependencyTreeStatic()) {
        continue;
      }

      const instance = wrapper.instance;
      if (!instance || typeof instance !== 'object') {
        continue;
      }

      const prototype = Object.getPrototypeOf(instance);
      const methodNames = this.metadataScanner.getAllMethodNames(prototype);

      for (const methodName of methodNames) {
        const methodRef = (instance as Record<string, unknown>)[methodName];
        if (typeof methodRef !== 'function') {
          continue;
        }

        const messageMetadata = Reflect.getMetadata(SQS_MESSAGE_HANDLER_METADATA, methodRef) as
          | SqsMessageHandlerMetadata
          | undefined;
        if (messageMetadata) {
          messageHandlers.push({
            metadata: messageMetadata,
            instance,
            methodName,
            handler: methodRef as (...args: unknown[]) => unknown,
          });
        }

        const eventMetadata = Reflect.getMetadata(SQS_EVENT_HANDLER_METADATA, methodRef) as
          | SqsConsumerEventHandlerMetadata
          | undefined;
        if (eventMetadata) {
          eventHandlers.push({
            metadata: eventMetadata,
            instance,
            methodName,
            handler: methodRef as (...args: unknown[]) => unknown,
          });
        }
      }
    }

    return {
      messageHandlers,
      eventHandlers,
    };
  }
}
