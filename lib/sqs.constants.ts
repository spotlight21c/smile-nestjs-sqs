import type { SqsConsumerEventName } from './sqs.types';

export const SQS_OPTIONS = Symbol('SQS_OPTIONS');
export const SQS_MESSAGE_HANDLER_METADATA = Symbol('SQS_MESSAGE_HANDLER_METADATA');
export const SQS_EVENT_HANDLER_METADATA = Symbol('SQS_EVENT_HANDLER_METADATA');

const SQS_CONSUMER_EVENT_NAME_MAP: Record<SqsConsumerEventName, true> = {
  response_processed: true,
  empty: true,
  message_received: true,
  message_processed: true,
  error: true,
  timeout_error: true,
  processing_error: true,
  aborted: true,
  started: true,
  stopped: true,
  option_updated: true,
  waiting_for_polling_to_complete: true,
  waiting_for_polling_to_complete_timeout_exceeded: true,
};

export const SQS_CONSUMER_EVENT_NAMES: ReadonlyArray<SqsConsumerEventName> = Object.keys(
  SQS_CONSUMER_EVENT_NAME_MAP,
) as SqsConsumerEventName[];

export const SQS_CONSUMER_EVENT_NAME_SET: ReadonlySet<SqsConsumerEventName> = new Set(SQS_CONSUMER_EVENT_NAMES);
