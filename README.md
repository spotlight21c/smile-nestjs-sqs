# smile-nestjs-sqs

NestJS SQS module built on top of the latest BBC libraries:

- [bbc/sqs-consumer](https://github.com/bbc/sqs-consumer)
- [bbc/sqs-producer](https://github.com/bbc/sqs-producer)

This package provides a decorator-first API, strict boot-time validation, and runtime controls for operating consumers and producers safely in NestJS.

## Compatibility

- Node.js `>=20`
- NestJS `^10 || ^11`

## Highlights

- Graceful shutdown: stops all consumers during `onModuleDestroy`, recommends configuring `pollingCompleteWaitTimeMs`, and waits for each consumer `stopped` event before completing shutdown.
- Prevents duplicate handler definitions: duplicate `@SqsMessageHandler` declarations for the same queue fail fast at bootstrap.
- Fails fast for missing handlers: if a consumer is configured without a matching `@SqsMessageHandler`, startup fails.
- Rejects invalid event names: unsupported `@SqsConsumerEventHandler` event names fail fast at bootstrap.
- Supports `isGlobal`: module global scope is configurable.
- Aligns with latest `bbc/sqs-consumer` behavior: `strictReturn` is enabled by default to enforce explicit handler return contracts.
- Prevents batch/type mismatch: validates `@SqsMessageHandler(..., { batch: true })` declarations against the first parameter type at bootstrap.

## Installation

```bash
pnpm add @aws-sdk/client-sqs sqs-consumer sqs-producer
pnpm add @nestjs/common @nestjs/core
pnpm add smile-nestjs-sqs
# optional: Terminus integration
pnpm add @nestjs/terminus
```

## Quick Start

```ts
import { Module } from '@nestjs/common';
import { SqsModule } from 'smile-nestjs-sqs';

@Module({
  imports: [
    SqsModule.register({
      consumers: [
        {
          name: 'orders',
          queueUrl: 'https://sqs.ap-northeast-2.amazonaws.com/123456789012/orders.fifo',
          region: 'ap-northeast-2',
        },
      ],
      producers: [
        {
          name: 'orders',
          queueUrl: 'https://sqs.ap-northeast-2.amazonaws.com/123456789012/orders.fifo',
          region: 'ap-northeast-2',
        },
      ],
    }),
  ],
})
export class AppModule {}
```

## Consumers

```ts
import { Injectable } from '@nestjs/common';
import { Message } from '@aws-sdk/client-sqs';
import { SqsConsumerEventHandler, SqsMessageHandler } from 'smile-nestjs-sqs';

@Injectable()
export class OrderQueueHandler {
  @SqsMessageHandler('orders')
  public async onMessage(message: Message): Promise<Message | undefined> {
    // return message to ack/delete
    return message;
  }

  @SqsConsumerEventHandler('orders', 'processing_error')
  public onProcessingError(error: Error, message: Message) {
    // report error
  }
}
```

Batch consumer:

```ts
@SqsMessageHandler('orders', { batch: true })
public async onBatch(messages: Message[]): Promise<Message[] | undefined> {
  return messages;
}
```

`@SqsMessageHandler('orders', true)` is also supported as a shorthand for batch mode.

### Message Handler Contract

- `@SqsMessageHandler('queue')`:
  - first parameter must be a single message (not array type)
  - return value must be a message-like object, `undefined`, or `null`
- `@SqsMessageHandler('queue', { batch: true })`:
  - first parameter must be an array type
  - return value must be `Message[]`, `undefined`, or `null`
- If the contract is violated, the module throws `SqsConfigurationError` at bootstrap or handler execution time.

Contract validation behavior:

- Parameter type mismatch (`batch: true` vs non-array parameter, or vice-versa) is checked at bootstrap when decorator metadata is available.
- Return type mismatch is always checked at runtime (`object` for single, `object[]` for batch, or `undefined`/`null`).
- To maximize bootstrap validation, keep TypeScript decorator metadata enabled for the Nest build.
- Keep `strictReturn` enabled (recommended) to fail fast on ambiguous handler returns.

## Producers

```ts
import { Injectable } from '@nestjs/common';
import { SqsService } from 'smile-nestjs-sqs';

@Injectable()
export class OrderPublisher {
  public constructor(private readonly sqsService: SqsService) {}

  public async publishOrderCreated() {
    await this.sqsService.send('orders', {
      id: 'msg-1',
      body: { type: 'order.created', orderId: 'o-100' },
      groupId: 'orders',
      deduplicationId: 'msg-1',
    });
  }
}
```

- Non-string `body` is serialized with `JSON.stringify`.
- Override with `bodySerializer` if needed.

## Configuration

```ts
SqsModule.register({
  isGlobal: true,
  defaultSqsClient: new SQSClient({ region: 'ap-northeast-2' }),
  consumers: [...],
  producers: [...],
  logger,
  globalStopOptions: { abort: false },
  includeControllers: false,
  shutdownTimeoutMs: 30_000,
  defaultStrictReturn: true,
  bodySerializer: (body, ctx) => JSON.stringify({ queue: ctx.queueName, body }),
});
```

### defaultSqsClient Example (Nest DI style)

```ts
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { SQSClient } from '@aws-sdk/client-sqs';
import { SqsModule } from 'smile-nestjs-sqs';

@Module({
  imports: [
    ConfigModule.forRoot(),
    SqsModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const region = config.getOrThrow<string>('AWS_REGION');
        const queueUrl = config.getOrThrow<string>('ORDERS_QUEUE_URL');
        const defaultSqsClient = new SQSClient({ region });

        return {
          defaultSqsClient,
          consumers: [{ name: 'orders', queueUrl }],
          producers: [{ name: 'orders', queueUrl }],
        };
      },
    }),
  ],
})
export class AppModule {}
```

### SqsOptions

| Option | Type | Default | Description |
|---|---|---|---|
| `consumers` | `SqsConsumerOptions[]` | `[]` | Consumer definitions (`name`, `queueUrl`, consumer options). |
| `producers` | `SqsProducerOptions[]` | `[]` | Producer definitions (`name`, `queueUrl`, producer options). |
| `isGlobal` | `boolean` | `true` | Registers `SqsModule` as global module. |
| `defaultSqsClient` | `SQSClient` | auto-created | Shared fallback SQS client for consumers/producers without `sqs`. |
| `logger` | `LoggerService` | Nest Logger | Logger used by `SqsService`. |
| `globalStopOptions` | `StopOptions` | `{}` | Base stop options merged into each consumer stop config. |
| `includeControllers` | `boolean` | `false` | Includes Nest controllers in decorator discovery scan. Keep `false` unless SQS handlers are intentionally declared in controllers. |
| `shutdownTimeoutMs` | `number` | `30000` | Timeout while waiting consumer stop during shutdown. |
| `defaultStrictReturn` | `boolean` | `true` | Default `strictReturn` for consumer creation. |
| `bodySerializer` | `(body, { queueName }) => string` | `JSON.stringify` | Custom message body serialization hook. Must return a string. |

Option notes:

- `includeControllers` defaults to `false` to avoid broad controller scanning and unintended handler pickup.
- `defaultStrictReturn: true` is recommended and should generally be kept enabled.
- Per-consumer `strictReturn` override is available from `sqs-consumer` options, but disabling it is not recommended.
- `bodySerializer` is only applied when message `body` is not already a string.
- `body` cannot be `undefined`; send will throw `SqsSerializationError`.
- If `bodySerializer` returns non-string, send will throw `SqsSerializationError`.

## Runtime API

`SqsService` provides:

- `getConsumer(name)`
- `getProducer(name)`
- `hasConsumer(name)`
- `hasProducer(name)`
- `getConsumerStatus(name)`
- `updateConsumerOption(name, option, value)`
- `startConsumer(name)`
- `stopConsumer(name, options?)`
- `stopAllConsumers(options?)`
- `send(name, message | message[])`
- `getProducerQueueSize(name)`
- `purgeQueue(name)`
- `getQueueAttributes(name, attributeNames?)`

`SqsRegistry` is also exported for advanced control/use-cases:

- `getConsumer(name)` / `findConsumer(name)`
- `getProducer(name)` / `findProducer(name)`
- `getConsumers()` / `getProducers()`

Shutdown behavior:

- Consumers are stopped on `onModuleDestroy`.
- For graceful stop, configure `pollingCompleteWaitTimeMs` in consumer options so in-flight polling can finish cleanly.
- The module waits for each consumer `stopped` event and uses `shutdownTimeoutMs` as a fallback timeout.

## Boot Validation

At startup, the module validates:

- duplicate consumer names
- duplicate producer names
- duplicate `@SqsMessageHandler` for same queue
- configured consumer with missing `@SqsMessageHandler` (always fail-fast)
- unsupported event names
- same queue name with mismatched consumer/producer `queueUrl`
- orphan `@SqsConsumerEventHandler` without configured consumer (always fail-fast)

### Consumer Event Name Integrity

- `@SqsConsumerEventHandler` event names are typed from `keyof ConsumerEvents` (`sqs-consumer`).
- The internal supported-event list is implemented as a typed map, so `sqs-consumer` event key changes are caught during type-check/build.
- When upgrading `sqs-consumer`, run full CI (type-check/test/build) and update the event map if new/removed events are reported.

## Health Check (Terminus)

`SqsHealthIndicator` is available through the `terminus` subpath export:

```ts
import { SqsHealthIndicator } from 'smile-nestjs-sqs/terminus';
```

Example usage:

```ts
import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';
import { SqsHealthIndicator } from 'smile-nestjs-sqs/terminus';

@Controller('health')
export class HealthController {
  public constructor(
    private readonly health: HealthCheckService,
    private readonly sqs: SqsHealthIndicator,
  ) {}

  @Get()
  @HealthCheck()
  public check() {
    return this.health.check([() => this.sqs.check('sqs')]);
  }
}
```

## E2E Execution Notes

- `pnpm test:e2e` always executes e2e tests.
- Default endpoint is `http://127.0.0.1:4566` (LocalStack SQS).
- Required env vars for local run:
  - `SQS_ENDPOINT=http://127.0.0.1:4566`
  - `AWS_REGION=us-east-1`
  - `AWS_ACCESS_KEY_ID=test`
  - `AWS_SECRET_ACCESS_KEY=test`

## Health Check Notes

- `SqsHealthIndicator` evaluates health by consumer `isRunning` state.
- `isPolling=false` alone is not treated as unhealthy.
- Check specific consumers by passing names to `sqs.check('sqs', ['orders'])`.

## GitHub Workflows

This repository includes:

- `CI` workflow (`.github/workflows/ci.yml`): lint/build/unit/e2e test on push/PR
- `Publish` workflow (`.github/workflows/publish.yml`): validate (lint/build/unit/e2e test) then publish on release

To publish from GitHub Actions, add repository secret:

- `NPM_TOKEN`: npm automation token with publish permission

## License

MIT
