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
import * as testUtils from '@opentelemetry/contrib-test-utils';
import * as sinon from 'sinon';
import type * as bullmq from 'bullmq';
import { removeAllQueueData } from 'bullmq';

import { default as IORedis } from 'ioredis';
import { context, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { AsyncHooksContextManager } from '@opentelemetry/context-async-hooks';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { v4 } from 'uuid';

import { BullMQInstrumentation } from '../src'

const memoryExporter = new InMemorySpanExporter();

const CONFIG = {
  host: process.env.OPENTELEMETRY_REDIS_HOST || 'localhost',
  port: parseInt(process.env.OPENTELEMETRY_REDIS_PORT || '63790', 10),
};

describe('BullMQ Instrumentation', () => {
  let sandbox: sinon.SinonSandbox;
  let instrumentation: BullMQInstrumentation;
  let contextManager: AsyncHooksContextManager;

  let Queue: typeof bullmq.Queue;

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

      Queue = require('bullmq').Queue;

      queue = new Queue(queueName, { connection: CONFIG });
      await queue.waitUntilReady();
    });

    afterEach(async function () {
      sandbox.restore();
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
});
