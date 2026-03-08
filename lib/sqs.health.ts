import { Inject, Injectable } from '@nestjs/common';
import type { HealthIndicatorResult } from '@nestjs/terminus';
import { SqsRegistry } from './sqs.registry';
import { SqsService } from './sqs.service';
import type { QueueName } from './sqs.types';

@Injectable()
export class SqsHealthIndicator {
  public constructor(
    @Inject(SqsService)
    private readonly sqsService: SqsService,
    @Inject(SqsRegistry)
    private readonly sqsRegistry: SqsRegistry,
  ) {}

  public check(key = 'sqs', consumerNames?: QueueName[]): HealthIndicatorResult {
    const names = consumerNames ?? this.sqsRegistry.getConsumers().map((consumer) => consumer.name);
    const details: Record<string, { isRunning: boolean; isPolling: boolean }> = {};

    let isHealthy = true;
    for (const name of names) {
      try {
        const status = this.sqsService.getConsumerStatus(name);
        details[name] = status;
        if (!status.isRunning) {
          isHealthy = false;
        }
      } catch {
        details[name] = { isRunning: false, isPolling: false };
        isHealthy = false;
      }
    }

    return {
      [key]: {
        status: isHealthy ? 'up' : 'down',
        ...details,
      },
    } as HealthIndicatorResult;
  }
}
