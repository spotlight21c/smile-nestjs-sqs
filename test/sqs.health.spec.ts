import { HealthIndicatorService } from '@nestjs/terminus';
import { describe, expect, it, vi } from 'vitest';
import { SqsHealthIndicator } from '../lib/sqs.health';
import type { SqsRegistry } from '../lib/sqs.registry';
import type { SqsService } from '../lib/sqs.service';

describe('SqsHealthIndicator', () => {
  const healthIndicatorService = new HealthIndicatorService();

  it('returns healthy status when all consumers are running', () => {
    const sqsService = {
      getConsumerStatus: vi.fn(() => ({ isRunning: true, isPolling: true })),
    } as unknown as SqsService;
    const registry = {
      getConsumers: vi.fn(() => [{ name: 'orders' }, { name: 'payments' }]),
    } as unknown as SqsRegistry;

    const indicator = new SqsHealthIndicator(sqsService, registry, healthIndicatorService);
    const result = indicator.check('sqs');

    expect(result.sqs.status).toBe('up');
    expect(result.sqs.orders.isRunning).toBe(true);
    expect(result.sqs.payments.isRunning).toBe(true);
  });

  it('returns down status when at least one consumer is not running', () => {
    const sqsService = {
      getConsumerStatus: vi
        .fn()
        .mockImplementationOnce(() => ({ isRunning: true, isPolling: true }))
        .mockImplementationOnce(() => ({ isRunning: false, isPolling: false })),
    } as unknown as SqsService;
    const registry = {
      getConsumers: vi.fn(() => [{ name: 'orders' }, { name: 'payments' }]),
    } as unknown as SqsRegistry;

    const indicator = new SqsHealthIndicator(sqsService, registry, healthIndicatorService);
    const result = indicator.check('sqs');

    expect(result.sqs.status).toBe('down');
    expect(result.sqs.payments.isRunning).toBe(false);
  });

  it('supports checking a subset of consumers', () => {
    const sqsService = {
      getConsumerStatus: vi.fn(() => ({ isRunning: true, isPolling: false })),
    } as unknown as SqsService;
    const registry = {
      getConsumers: vi.fn(() => [{ name: 'orders' }, { name: 'payments' }]),
    } as unknown as SqsRegistry;

    const indicator = new SqsHealthIndicator(sqsService, registry, healthIndicatorService);
    const result = indicator.check('sqs', ['orders']);

    expect(Object.keys(result.sqs).sort()).toEqual(['orders', 'status']);
    expect(result.sqs.status).toBe('up');
    expect(result.sqs.orders.isRunning).toBe(true);
  });
});
