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
import type * as bullmq from 'bullmq';
import { context, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { AsyncHooksContextManager } from '@opentelemetry/context-async-hooks';
import * as testUtils from '@opentelemetry/contrib-test-utils';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { removeAllQueueData } from 'bullmq';
import { default as IORedis } from 'ioredis';
import * as sinon from 'sinon';
import { v4 } from 'uuid';

import { BullMQInstrumentation } from '../src'

const memoryExporter = new InMemorySpanExporter();

const CONFIG = {
  host: process.env.OPENTELEMETRY_REDIS_HOST || 'localhost',
  port: parseInt(process.env.OPENTELEMETRY_REDIS_PORT || '63790', 10),
};

let Queue: typeof bullmq.Queue;
let QueueEvents: typeof bullmq.QueueEvents;
let Worker: typeof bullmq.Worker;

function getWait(): [Promise<any>, Function, Function] {
  let resolve: Function;
  let reject: Function
  const p = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });

  // @ts-ignore
  return [p, resolve, reject];
}

describe('BullMQ Instrumentation', () => {
  let sandbox: sinon.SinonSandbox;
  let instrumentation: BullMQInstrumentation;
  let contextManager: AsyncHooksContextManager;

  const provider = new NodeTracerProvider();

  before(function () {
    testUtils.startDocker('redis');
  });

  after(function () {
    testUtils.cleanUpDocker('redis');
  })

  describe('Queue', () => {
    let queue: bullmq.Queue;
    let queueName: string;

    beforeEach(async function () {
      sandbox = sinon.createSandbox();
      queueName = `test-${v4()}`;

      contextManager = new AsyncHooksContextManager().enable();
      context.setGlobalContextManager(contextManager);
      provider.addSpanProcessor(new SimpleSpanProcessor(memoryExporter));
      instrumentation = new BullMQInstrumentation();
      instrumentation.setTracerProvider(provider);
      instrumentation.enable()

      // eslint-disable-next-line @typescript-eslint/no-var-requires
      Queue = require('bullmq').Queue;

      queue = new Queue(queueName, { connection: CONFIG });
      await queue.waitUntilReady();
    });

    afterEach(async function () {
      sandbox.restore();
      contextManager.disable();
      contextManager.enable();
      memoryExporter.reset();
      instrumentation.disable();
      context.disable();
      await queue.close();
      await removeAllQueueData(new IORedis(CONFIG.port), queueName);
    });

    it('should create a Job.addJob span when calling add method', async () => {
      sandbox.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 1 })

      const expectedJobName = 'testJob';

      const expectedAttributes = {
        'message.id': 'unknown',
        'messaging.bullmq.job.name': expectedJobName,
        'messaging.bullmq.job.opts.attempts': 0,
        'messaging.bullmq.job.opts.delay': 0,
        'messaging.bullmq.job.parentOpts.parentKey': 'unknown',
        'messaging.bullmq.job.parentOpts.waitChildrenKey': 'unknown',
        'messaging.bullmq.job.timestamp': 0,
        'messaging.destination': queueName,
        'messaging.system': 'BullMQ'
      }

      await queue.add(expectedJobName, { test: 'yes' });

      const endedSpans = memoryExporter.getFinishedSpans();

      const addJobSpan = endedSpans.filter(span => span.name.includes('Job.addJob'))[0];
      testUtils.assertSpan(addJobSpan, SpanKind.PRODUCER, expectedAttributes, [], { code: SpanStatusCode.UNSET })
    });

    it('should create a Queue.addBulk span when calling addBulk method', async () => {
      sandbox.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 1 })

      const expectedJobs = [{ name: 'testJob1', data: { test: 'yes' } }, { name: 'testJob2', data: { test: 'no' } }];

      const expectedAttributes = {
        'messaging.bullmq.job.bulk.count': expectedJobs.length,
        'messaging.bullmq.job.bulk.names': [expectedJobs[0].name, expectedJobs[1].name],
        'messaging.destination': queueName,
        'messaging.system': 'BullMQ'
      }

      await queue.addBulk(expectedJobs)

      const endedSpans = memoryExporter.getFinishedSpans()

      const addBulkSpan = endedSpans.filter(span => span.name.includes('Queue.addBulk'))[0];
      testUtils.assertSpan(addBulkSpan, SpanKind.INTERNAL, expectedAttributes, [], { code: SpanStatusCode.UNSET })
    });
  });

  describe('Worker', () => {
    let queue: bullmq.Queue;
    let queueEvents: bullmq.QueueEvents;
    let queueName: string;

    beforeEach(async function () {
      sandbox = sinon.createSandbox();
      queueName = `test-${v4()}`;

      contextManager = new AsyncHooksContextManager().enable();
      context.setGlobalContextManager(contextManager);
      provider.addSpanProcessor(new SimpleSpanProcessor(memoryExporter));
      instrumentation = new BullMQInstrumentation();
      instrumentation.setTracerProvider(provider);
      instrumentation.enable()

      // eslint-disable-next-line @typescript-eslint/no-var-requires
      Queue = require('bullmq').Queue;
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      QueueEvents = require('bullmq').QueueEvents;
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      Worker = require('bullmq').Worker;

      queue = new Queue(queueName, { connection: CONFIG });
      queueEvents = new QueueEvents(queueName, { connection: CONFIG });
      await queueEvents.waitUntilReady();
    });

    afterEach(async function () {
      sandbox.restore();
      contextManager.disable();
      contextManager.enable();
      memoryExporter.reset();
      instrumentation.disable();
      context.disable();
      await queue.close();
      await queueEvents.close();
      await removeAllQueueData(new IORedis(CONFIG.port), queueName);
    });


    it('should create a Worker.${jobName} span when calling callProcessJob method', async () => {
      sandbox.useFakeTimers();

      const expectedJobName = 'testJob';

      const expectedAttributes = {
        'messaging.bullmq.job.attempts': 1,
        'messaging.bullmq.job.delay': 0,
        'messaging.bullmq.job.name': expectedJobName,
        'messaging.bullmq.job.opts.attempts': 0,
        'messaging.bullmq.job.opts.delay': 0,
        'messaging.bullmq.job.processedOn': 30000,
        'messaging.bullmq.job.timestamp': 0,
        'messaging.bullmq.queue.name': queueName,
        'messaging.bullmq.worker.name': queueName,
        'messaging.consumer_id': queueName,
        'messaging.message_id': '1',
        'messaging.operation': 'receive',
        'messaging.system': 'BullMQ'
      };

      const [processor, processorDone] = getWait();

      const w = new Worker(queueName, async () => {
        sandbox.clock.tick(1000);
        sandbox.clock.next();
        await processorDone();
        return { completed: new Date().toTimeString() }
      }, { connection: CONFIG })
      await w.waitUntilReady();


      await queue.add('testJob', { test: 'yes' });

      sandbox.clock.tick(1000);
      sandbox.clock.next();

      await processor;
      await w.close();

      const endedSpans = memoryExporter.getFinishedSpans();
      const workerSpan = endedSpans.filter(span => span.name.includes(`Worker.${queueName}`))[0];
      testUtils.assertSpan(workerSpan, SpanKind.CONSUMER, expectedAttributes, [], { code: SpanStatusCode.UNSET })
    });
  });
});
