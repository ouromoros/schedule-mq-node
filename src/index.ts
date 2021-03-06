import { parseExpression } from "cron-parser";
import * as redis from "redis";
import { v4 as uuid } from "uuid";
import { RedisBroker } from "./redis_impl";
import { Execution, parseExec } from "./struct";
import { sleep } from "./sleep";

interface Handler {
  (data?: string): boolean | Promise<boolean>;
}

export interface SchedulerOptions {
  /**
   * { host: "127.0.0.1", port: 6379 , password: "dummy", db: 0 }
   */
  redisConfig: redis.ClientOpts;
  /**
   * The prefix for redis objects.
   */
  redisPrefix?: string;
  /**
   * Interval between each polling from the time queue. Defaults to 1000 and usually needn't be changed.
   */
  pollInterval?: number;
}

interface ScheduleOptions {
  cronExpr: string;

  /**
   * Setting `retry` to `true` so that the task will be automatically retried if it doesn't get executed successfully.
   * One of `retryTimeout` or `retryStrategy` must be provided if `retry` is `true`.
   *
   * If `retryTimeout` is provided, the task will be retried indefinitely until it succeeds.
   *
   * If `retryStrategy` is provided, the task will be retried each time after waiting for the specified time. After the
   * specified number of retries, the scheduler will drop the task whether it has succeeded in the last time or not.
   */
  retry?: boolean;
  /**
   * The timeout between each retry.
   */
  retryTimeout?: number;
}

interface PushOptions {
  data?: string;

  delay?: number;

  /**
   * Setting `retry` to `true` so that the task will be automatically retried if it doesn't get executed successfully.
   * One of `retryTimeout` or `retryStrategy` must be provided if `retry` is `true`.
   *
   * If `retryTimeout` is provided, the task will be retried indefinitely until it succeeds.
   *
   * If `retryStrategy` is provided, the task will be retried each time after waiting for the specified time. After the
   * specified number of retries, the scheduler will drop the task whether it has succeeded in the last time or not.
   */
  retry?: boolean;
  /**
   * The timeout between each retry.
   */
  retryTimeout?: number;
}

enum Status {
  RUNNING,
  STOPPED,
}

class Scheduler {
  private registerMap: Record<string, ScheduleOptions>;
  private bindMap: Record<string, Handler>;
  private status: Status;
  private broker: RedisBroker;
  private opts: SchedulerOptions;

  constructor(opts: SchedulerOptions) {
    this.registerMap = {};
    this.bindMap = {};
    this.status = Status.STOPPED;
    this.opts = opts;

    opts.pollInterval = opts.pollInterval || 1000;
    opts.redisPrefix = opts.redisPrefix || "_schedule_mq:";

    this.broker = new RedisBroker(
      opts.redisConfig,
      opts.redisPrefix!,
      opts.pollInterval!
    );
  }

  /**
   * Once `start()` is called, the scheduler would start scheduling registered tasks and listen for binded tasks
   */
  start() {
    this.status = Status.RUNNING;
    this.startSchedules();

    this.checkTimeoutTasks();
    this.checkBindTasks();
  }

  /**
   * Stop all actions including listen for tasks and schedule tasks
   */
  stop() {
    this.status = Status.STOPPED;
  }

  /**
   * Register a job to be scheduled according to cronExpr
   * @param taskId unique taskId for a task
   * @param options specify cronExpr and other strategies for scheduling
   */
  register(taskId: string, options: ScheduleOptions) {
    this.registerMap[taskId] = options;
  }

  /**
   * After bind a task to the scheduler, the scheduler will try to pull task from task queue with specified
   * `taskId` and take action specified by `handler`
   * @param taskId unique id of a task
   * @param handler specify action when task arrives
   */
  bind(taskId: string, handler: Handler) {
    this.bindMap[taskId] = handler;
  }

  /**
   * Push a task with `taskId` to task queue
   * @param taskId unique id of a task
   * @param opts specify additional data and retry stratigies
   */
  push(taskId: string, opts: PushOptions) {
    const exec = {
      taskId,
      execId: uuid(),
      data: opts.data,
      retry: opts.retry,
      retryTimeout: opts.retryTimeout,
    };
    if (!opts.delay) {
      this.pushExecution(exec);
    } else {
      this.pushDelayed(exec, opts.delay);
    }
  }

  /**
   * Clear the scheduler task configs
   */
  clear() {
    if (this.status === Status.RUNNING) {
      throw Error("Can only clear when Scheduler is not running");
    }
    this.bindMap = {};
    this.registerMap = {};
  }

  private async checkTimeoutTasks() {
    while (this.status === Status.RUNNING) {
      const exe = await this.broker.tpop();
      if (!exe) {
        await sleep(this.opts.pollInterval!);
      } else if (typeof exe === "number") {
        await sleep(exe - Date.now());
      } else {
        const execution = parseExec(exe);
        this.pushExecution(execution);
      }
    }
  }

  private getBindTaskQueues() {
    return Object.keys(this.bindMap);
  }

  private async checkBindTasks() {
    while (this.status === Status.RUNNING) {
      const queues = this.getBindTaskQueues();
      if (queues.length === 0) {
        return;
      }
      const exe = await this.broker.rpop(queues);
      if (!exe) continue;
      const exec = parseExec(exe);
      this.doExec(exec);
    }
  }

  private async doExec(exec: Execution) {
    const handler = this.bindMap[exec.taskId];
    try {
      let success = handler(exec.data);
      if (success instanceof Promise) {
        success = await success;
      }
      if (!success) {
        throw new Error("task failed");
      }
      this.broker.clearTimeout(exec.execId);
    } catch (e) {}
  }

  private pushExecution(execution: Execution) {
    return this.broker.rpush(execution);
  }

  private pushDelayed(exec: Execution, delay: number) {
    const timeStamp = Date.now() + delay;
    this.broker.tpush(timeStamp, exec);
  }

  private async startSchedule(taskId: string, options: ScheduleOptions) {
    const cron = parseExpression(options.cronExpr);
    let nextTime = cron.next().getTime();
    while (this.status === Status.RUNNING && nextTime) {
      await sleep(nextTime - Date.now());
      const execId = `sched:${taskId}:${nextTime}`;
      const exec = {
        taskId,
        execId,
        retry: options.retry,
        retryTimeout: options.retryTimeout,
      };
      const success = await this.broker.lockAndAddTimeout(exec, 1000);
      if (success) {
        this.pushExecution(exec);
      }
      nextTime = cron.next().getTime();
    }
  }

  private startSchedules() {
    for (const taskId in this.registerMap) {
      this.startSchedule(taskId, this.registerMap[taskId]);
    }
  }
}

export function createScheduler(opts: SchedulerOptions): Scheduler {
  return new Scheduler(opts);
}
