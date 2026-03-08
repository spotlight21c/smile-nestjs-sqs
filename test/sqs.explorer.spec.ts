import 'reflect-metadata';

import { Injectable } from '@nestjs/common';
import { type DiscoveryService, MetadataScanner } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { SqsMessageHandler } from '../lib';
import { SqsExplorer } from '../lib/sqs.explorer';

@Injectable()
class StaticHandler {
  @SqsMessageHandler('static-queue')
  public async handle() {
    return undefined;
  }
}

@Injectable()
class DynamicHandler {
  @SqsMessageHandler('dynamic-queue')
  public async handle() {
    return undefined;
  }
}

describe('SqsExplorer', () => {
  it('skips non-static providers during handler discovery', () => {
    const discoveryService = {
      getProviders: () => [
        { instance: new StaticHandler(), isDependencyTreeStatic: () => true },
        { instance: new DynamicHandler(), isDependencyTreeStatic: () => false },
      ],
      getControllers: () => [],
    } as unknown as DiscoveryService;

    const metadataScanner = new MetadataScanner();
    const explorer = new SqsExplorer(discoveryService, metadataScanner);
    const discovered = explorer.explore();

    expect(discovered.messageHandlers).toHaveLength(1);
    expect(discovered.messageHandlers[0].metadata.name).toBe('static-queue');
  });
});
