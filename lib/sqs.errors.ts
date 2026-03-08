export class SqsModuleError extends Error {
  public constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class SqsConfigurationError extends SqsModuleError {
  public constructor(message: string) {
    super(message, 'SQS_CONFIGURATION_ERROR');
  }
}

export class SqsNotFoundError extends SqsModuleError {
  public constructor(message: string) {
    super(message, 'SQS_NOT_FOUND');
  }
}

export class SqsSerializationError extends SqsModuleError {
  public constructor(message: string) {
    super(message, 'SQS_SERIALIZATION_ERROR');
  }
}
