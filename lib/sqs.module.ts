import { type DynamicModule, Module, type Provider, type Type } from '@nestjs/common';
import { DiscoveryModule, MetadataScanner } from '@nestjs/core';
import { SQS_OPTIONS } from './sqs.constants';
import { SqsConfigurationError } from './sqs.errors';
import { SqsExplorer } from './sqs.explorer';
import { SqsRegistry } from './sqs.registry';
import { SqsService } from './sqs.service';
import type { SqsModuleAsyncOptions, SqsModuleOptionsFactory, SqsOptions } from './sqs.types';

@Module({
  imports: [DiscoveryModule],
  providers: [MetadataScanner, SqsExplorer, SqsRegistry, SqsService],
  exports: [SqsService, SqsRegistry],
})
export class SqsModule {
  public static register(options: SqsOptions): DynamicModule {
    return {
      global: options.isGlobal ?? true,
      module: SqsModule,
      imports: [DiscoveryModule],
      providers: [
        {
          provide: SQS_OPTIONS,
          useValue: options,
        },
      ],
      exports: [SqsService, SqsRegistry],
    };
  }

  public static registerAsync(options: SqsModuleAsyncOptions): DynamicModule {
    return {
      global: options.isGlobal ?? true,
      module: SqsModule,
      imports: [DiscoveryModule, ...(options.imports ?? [])],
      providers: SqsModule.createAsyncProviders(options),
      exports: [SqsService, SqsRegistry],
    };
  }

  private static createAsyncProviders(options: SqsModuleAsyncOptions): Provider[] {
    if (options.useFactory) {
      return [
        {
          provide: SQS_OPTIONS,
          useFactory: options.useFactory,
          inject: options.inject ?? ([] as Array<Type<unknown> | string | symbol>),
        },
      ];
    }

    if (options.useExisting) {
      return [
        {
          provide: SQS_OPTIONS,
          useFactory: async (optionsFactory: SqsModuleOptionsFactory) => await optionsFactory.createSqsOptions(),
          inject: [options.useExisting],
        },
      ];
    }

    if (options.useClass) {
      const useClass = options.useClass as Type<SqsModuleOptionsFactory>;
      return [
        {
          provide: useClass,
          useClass,
        },
        {
          provide: SQS_OPTIONS,
          useFactory: async (optionsFactory: SqsModuleOptionsFactory) => await optionsFactory.createSqsOptions(),
          inject: [useClass],
        },
      ];
    }

    throw new SqsConfigurationError('SqsModule.registerAsync requires useFactory, useClass, or useExisting.');
  }
}
