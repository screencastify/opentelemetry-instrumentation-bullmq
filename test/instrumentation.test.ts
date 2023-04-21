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
import { context, propagation, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { AsyncHooksContextManager } from '@opentelemetry/context-async-hooks';
import * as testUtils from '@opentelemetry/contrib-test-utils';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import * as assert from 'assert';
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
  const provider = new NodeTracerProvider();
  provider.addSpanProcessor(new SimpleSpanProcessor(memoryExporter));
  const instrumentation = new BullMQInstrumentation();
  instrumentation.setTracerProvider(provider);
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());


  let sandbox: sinon.SinonSandbox;
  let contextManager: AsyncHooksContextManager;

  beforeEach(async function () {
    contextManager = new AsyncHooksContextManager();
    context.setGlobalContextManager(contextManager.enable());

    assert.strictEqual(memoryExporter.getFinishedSpans().length, 0);
  });

  afterEach(() => {
    memoryExporter.reset();
    context.disable();
  });

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
      instrumentation.enable()

      // eslint-disable-next-line @typescript-eslint/no-var-requires
      Queue = require('bullmq').Queue;

      queue = new Queue(queueName, { connection: CONFIG });
      await queue.waitUntilReady();
    });

    afterEach(async function () {
      sandbox.restore();
      instrumentation.disable();
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

      // ASSERT
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

      // ASSERT
      testUtils.assertSpan(addBulkSpan, SpanKind.INTERNAL, expectedAttributes, [], { code: SpanStatusCode.UNSET })
    });

    it('propagates Job.addJob span from the addBulk span', async () => {
      sandbox.useFakeTimers();

      await queue.addBulk([{name: 'testJob', data: { test: 'yes' }}]);

      const endedSpans = memoryExporter.getFinishedSpans();

      const producerSpan = endedSpans.filter(span => span.name.includes('Queue.addBulk'))[0];
      const consumerSpan = endedSpans.filter(span => span.name.includes(`${queueName}.testJob Job.addJob`))[0];

      // ASSERT
      //@ts-expect-error producerSpan still works at runtime
      testUtils.assertPropagation(consumerSpan, producerSpan);
    });
  });

  describe('Worker', () => {
    let queue: bullmq.Queue;
    let queueName: string;

    beforeEach(async function () {
      sandbox = sinon.createSandbox();
      queueName = `test-${v4()}`;
      instrumentation.enable()

      // eslint-disable-next-line @typescript-eslint/no-var-requires
      Queue = require('bullmq').Queue;
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      Worker = require('bullmq').Worker;

      queue = new Queue(queueName, { connection: CONFIG });
      await queue.waitUntilReady();
    });

    afterEach(async function () {
      sandbox.restore();
      instrumentation.disable();
      await queue.close();
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

      const { traceId, spanId } = endedSpans.filter(span => span.name.includes('Job.addJob'))[0].spanContext();
      const workerSpan = endedSpans.filter(span => span.name.includes(`Worker.${queueName}`))[0];

      // ASSERT
      testUtils.assertSpan(workerSpan, SpanKind.CONSUMER, { ...expectedAttributes, 'messaging.bullmq.job.opts.traceparent': `00-${traceId}-${spanId}-01` }, [], { code: SpanStatusCode.UNSET })
    });

    it('propagates Worker.${jobName} span from the addJobSpan', async () => {
      sandbox.useFakeTimers();

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

      const producerSpan = endedSpans.filter(span => span.name.includes('Job.addJob'))[0];
      const consumerSpan = endedSpans.filter(span => span.name.includes(`Worker.${queueName}`))[0];

      // ASSERT
      //@ts-expect-error producerSpan still works at runtime
      testUtils.assertPropagation(consumerSpan, producerSpan);
    });

    it('propagates addBulk span from the worker span when from same queue', async () => {
      sandbox.useFakeTimers();
      let keepGoing = true;

      const [processor, processorDone] = getWait();

      const w = new Worker(queueName, async () => {
        sandbox.clock.tick(1000);
        sandbox.clock.next();
        await processorDone();
        if (keepGoing) {
          keepGoing = false;
          await queue.addBulk([{ name: 'testJob2', data: { test: 'no' } }]);
          sandbox.clock.tick(1000);
          sandbox.clock.next();
        }
      }, { connection: CONFIG })
      await w.waitUntilReady();

      await queue.addBulk([{ name: 'testJob', data: { test: 'yes' } }]);

      sandbox.clock.tick(1000);
      sandbox.clock.next();

      await processor;
      await w.close();

      const endedSpans = memoryExporter.getFinishedSpans();

      const producerSpanContext = endedSpans.filter(span => span.name.includes(`Worker.${queueName}`))[0].spanContext();
      const consumerSpans = endedSpans.filter(span => span.name.includes(`${queueName} Queue.addBulk`));
      const consumerSpan = consumerSpans[consumerSpans.length - 1];
      const consumerSpanContext = consumerSpan.spanContext();

      // ASSERT
      assert.strictEqual(consumerSpanContext.traceId, producerSpanContext.traceId);
      assert.strictEqual(consumerSpan.parentSpanId, producerSpanContext.spanId);
    });

    it('does not propagate addBulk span from the worker span when from different queue', async () => {
      sandbox.useFakeTimers();

      const downstreamQueue = 'nextQueue'

      const [processor, processorDone] = getWait();
      const [nextProcessor, nextProcessorDone] = getWait();

      const nextQueue = new Queue(downstreamQueue, { connection: CONFIG });
      const nextWorker = new Worker(downstreamQueue, async () => {
        sandbox.clock.tick(1000);
        sandbox.clock.next();
        await nextProcessorDone();
        return { completed: new Date().toTimeString() }
      }, { connection: CONFIG })
      await nextWorker.waitUntilReady();

      const w = new Worker(queueName, async () => {
        sandbox.clock.tick(1000);
        sandbox.clock.next();
        await processorDone();
        nextQueue.addBulk([{ name: 'testNextJob', data: { test: 'shide' } }])

        sandbox.clock.tick(1000);
        sandbox.clock.next();

        await nextProcessor;
        await nextWorker.close();
      }, { connection: CONFIG })
      await w.waitUntilReady();


      await queue.addBulk([{name: 'testJob', data: { test: 'yes' }}]);

      sandbox.clock.tick(1000);
      sandbox.clock.next();

      await processor;
      await w.close();

      const endedSpans = memoryExporter.getFinishedSpans();
      const producerSpanContext = endedSpans.filter(span => span.name.includes(`Worker.${queueName}`))[0].spanContext();
      const consumerSpan = endedSpans.filter(span => span.name.includes(`${downstreamQueue} Queue.addBulk`))[0];
      const consumerSpanContext = consumerSpan.spanContext();

      // ASSERT
      assert.notStrictEqual(consumerSpanContext.traceId, producerSpanContext.traceId);
      assert.notStrictEqual(consumerSpan.parentSpanId, producerSpanContext.spanId);
    });
  });
});
