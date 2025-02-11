/*
Copyright 2022 Jennifer Moore
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at
    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.

This derivative work has modifications by Screencastify staff for internal usage
*/
import type { Attributes, Span } from '@opentelemetry/api'
import type * as bullmq from 'bullmq';
import { context, propagation, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import {
  InstrumentationBase,
  InstrumentationConfig,
  InstrumentationNodeModuleDefinition,
} from '@opentelemetry/instrumentation';
import { SemanticAttributes } from '@opentelemetry/semantic-conventions';
import {
  Job,
  JobsOptions,
  ParentOpts,
  Worker,
} from 'bullmq';
import { flatten } from 'flat';

import { BullMQAttributes } from './attributes';
import { VERSION } from './version';


export class Instrumentation extends InstrumentationBase {
  constructor(config: InstrumentationConfig = {}) {
    super('opentelemetry-instrumentation-bullmq', VERSION, config);
  }

  /**
   * Init method will be called when the plugin is constructed.
   * It returns an `InstrumentationNodeModuleDefinition` which describes
   *   the node module to be instrumented and patched.
   * It may also return a list of `InstrumentationNodeModuleDefinition`s if
   *   the plugin should patch multiple modules or versions.
   */
  protected init() {
    return new InstrumentationNodeModuleDefinition<typeof bullmq>(
      'bullmq',
      ['1.*', '2.*', '3.*'],
      this._onPatchMain(),
      this._onUnPatchMain(),
    );
  }

  private _onPatchMain() {
    return (moduleExports: typeof bullmq) => {
      this._diag.debug('patching');

      // As Spans
      this._wrap(moduleExports.Queue.prototype, 'addBulk', this._patchQueueAddBulk());
      this._wrap(moduleExports.Job.prototype, 'addJob', this._patchAddJob());

      // @ts-expect-error
      this._wrap(moduleExports.Worker.prototype, 'callProcessJob', this._patchCallProcessJob());

      return moduleExports;
    }
  }

  private _onUnPatchMain() {
    return (moduleExports: typeof bullmq) => {
      this._diag.debug('un-patching');

      this._unwrap(moduleExports.Queue.prototype, 'addBulk');
      this._unwrap(moduleExports.Job.prototype, 'addJob');

      // @ts-expect-error
      this._unwrap(moduleExports.Worker.prototype, 'callProcessJob');
    }
  }

  private _patchAddJob(): (original: Function) => (...args: any) => any {
    const instrumentation = this;
    const tracer = instrumentation.tracer;
    const action = 'Job.addJob';

    return function addJob(original) {
      return async function patch(this: Job, client: never, parentOpts?: ParentOpts): Promise<string> {
        const currentQueue = this.queueName;

        const spanName = `${currentQueue}.${this.name} ${action}`;
        const span = tracer.startSpan(spanName, {
          attributes: {
            [SemanticAttributes.MESSAGING_SYSTEM]: BullMQAttributes.MESSAGING_SYSTEM,
            [SemanticAttributes.MESSAGING_DESTINATION]: this.queueName,
            [BullMQAttributes.JOB_NAME]: this.name,
            ...Instrumentation.attrMap(BullMQAttributes.JOB_OPTS, this.opts),
          },
          kind: SpanKind.PRODUCER,
        });
        if (parentOpts) {
          span.setAttributes({
            [BullMQAttributes.JOB_PARENT_KEY]: parentOpts.parentKey ?? 'unknown',
            [BullMQAttributes.JOB_WAIT_CHILDREN_KEY]: parentOpts.waitChildrenKey ?? 'unknown',
          });
        }
        const parentContext = context.active();
        const shouldDiverge = propagation.getBaggage(parentContext)?.getEntry('shouldDiverge')?.value === 'true';
        const messageContext = trace.setSpan(parentContext, span);

        this.data = {...this.data, shouldDiverge}

        propagation.inject(messageContext, this.opts);
        return await context.with(messageContext, async () => {
          try {
            return await original.apply(this, [client, parentOpts]);
          } catch (e) {
            throw Instrumentation.setError(span, e as Error);
          } finally {
            span.setAttribute(SemanticAttributes.MESSAGE_ID, this.id ?? 'unknown');
            span.setAttribute(BullMQAttributes.JOB_TIMESTAMP, this.timestamp)
            span.end();
          }
        });
      }
    }
  }

  private _patchQueueAddBulk(): (original: Function) => (...args: any) => any {
    const instrumentation = this;
    const tracer = instrumentation.tracer;
    const action = 'Queue.addBulk';

    return function addBulk(original) {
      return async function patch(this: bullmq.Queue, ...args: [bullmq.Job[]]): Promise<bullmq.Job[]> {
        const names = args[0].map(job => job.name);

        let currentContext = context.active();

        // get queue information from baggage to make propagation decision
        const currentQueue = this.name;
        const lastQueue = propagation.getBaggage(currentContext)?.getEntry('queue')?.value;
        const shouldDiverge = !!lastQueue && lastQueue !== currentQueue;

        const spanName = `${currentQueue} ${action}`;

        if (shouldDiverge) {
          const shouldDivergeBaggage = propagation.createBaggage({ shouldDiverge: { value: 'true' } });
          currentContext = propagation.setBaggage(currentContext, shouldDivergeBaggage);
        }

        const span = tracer.startSpan(spanName, {
          attributes: {
            [SemanticAttributes.MESSAGING_SYSTEM]: BullMQAttributes.MESSAGING_SYSTEM,
            [SemanticAttributes.MESSAGING_DESTINATION]: this.name,
            [BullMQAttributes.JOB_BULK_NAMES]: names,
            [BullMQAttributes.JOB_BULK_COUNT]: names.length,
          },
          kind: SpanKind.INTERNAL,
        });

        const messageContext = trace.setSpan(currentContext, span);

        return await context.with(messageContext, async () => {
          try {
            return await original.apply(this, [...args]);
          } catch (e) {
            throw Instrumentation.setError(span, e as Error);
          } finally {
            span.end();
          }
        });
      };
    };
  }

  private _patchCallProcessJob(): (original: Function) => (...args: any) => any {
    const instrumentation = this;
    const tracer = instrumentation.tracer;

    return function patch(original) {
      return async function callProcessJob(this: Worker, job: any, ...rest: any[]) {
        const workerName = this.name ?? 'anonymous';
        const parentContext = propagation.extract(context.active(), job.opts);

        const shouldDiverge = !!job?.data?.shouldDiverge;

        // Set queue baggage in worker patch because its the last place with same queue name
        const queueBaggage = propagation.createBaggage({ queue: { value: job.queueName } });
        const baggageContext = propagation.setBaggage(parentContext, queueBaggage);

        const parentSpanCtx = trace.getSpanContext(baggageContext);

        //TODO: get propagation decision from baggage
        const currentQueue = job.queueName;

        const spanName = `${currentQueue}.${job.name} Worker.${workerName} #${job.attemptsMade}`;
        const span = tracer.startSpan(spanName, {
          attributes: {
            [SemanticAttributes.MESSAGING_SYSTEM]: BullMQAttributes.MESSAGING_SYSTEM,
            [SemanticAttributes.MESSAGING_CONSUMER_ID]: workerName,
            [SemanticAttributes.MESSAGING_MESSAGE_ID]: job.id ?? 'unknown',
            [SemanticAttributes.MESSAGING_OPERATION]: 'receive',
            [BullMQAttributes.JOB_NAME]: job.name,
            [BullMQAttributes.JOB_ATTEMPTS]: job.attemptsMade,
            [BullMQAttributes.JOB_TIMESTAMP]: job.timestamp,
            [BullMQAttributes.JOB_DELAY]: job.delay,
            ...Instrumentation.attrMap(BullMQAttributes.JOB_OPTS, job.opts),
            [BullMQAttributes.QUEUE_NAME]: job.queueName,
            [BullMQAttributes.WORKER_NAME]: workerName,
          },
          kind: SpanKind.CONSUMER,
          root: shouldDiverge,
          links: shouldDiverge && parentSpanCtx ? [{ context: parentSpanCtx }] : undefined
        }, baggageContext);
        if (job.repeatJobKey) span.setAttribute(BullMQAttributes.JOB_REPEAT_KEY, job.repeatJobKey);
        const messageContext = trace.setSpan(baggageContext, span);

        return await context.with(messageContext, async () => {
          try {
            const result = await original.apply(this, [job, ...rest]);
            return result;
          } catch (e) {
            throw Instrumentation.setError(span, e as Error);
          } finally {
            if (job.finishedOn) span.setAttribute(BullMQAttributes.JOB_FINISHED_TIMESTAMP, job.finishedOn);
            if (job.processedOn) span.setAttribute(BullMQAttributes.JOB_PROCESSED_TIMESTAMP, job.processedOn);
            if (job.failedReason) span.setAttribute(BullMQAttributes.JOB_FAILED_REASON, job.failedReason);

            span.end();
          }
        });
      }
    }
  }

  private static setError = (span: Span, error: Error) => {
    span.recordException(error);
    span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
    return error;
  }

  private static attrMap(prefix: string, opts: JobsOptions): Attributes {
    const attrs = flatten({ [prefix]: opts }) as Attributes;
    for (const key in attrs) {
      if (attrs[key] === undefined) delete attrs[key];
    }

    return attrs;
  }

  private static async withContext(thisArg: any, original: Function, span: Span, args: any[]): Promise<any> {
    const parentContext = context.active();
    const messageContext = trace.setSpan(parentContext, span);

    return await context.with(messageContext, async () => {
      try {
        return await original.apply(thisArg, ...[args]);
      } catch (e) {
        throw Instrumentation.setError(span, e as Error);
      } finally {
        span.end();
      }
    });
  }
}


