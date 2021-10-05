import {
  Context,
  Log,
  MaybePromise,
  TypedEventListener,
  ValueOf,
  typedEventTarget,
} from "@miniflare/shared";
import { Response as BaseResponse, fetch } from "undici";
import { DOMException } from "./domexception";
import { Request, Response, withWaitUntil } from "./http";

const kResponse = Symbol("kResponse");
const kPassThrough = Symbol("kPassThrough");
const kWaitUntil = Symbol("kWaitUntil");
const kSent = Symbol("kSent");

export class FetchEvent extends Event {
  [kResponse]?: Promise<Response | BaseResponse>;
  [kPassThrough] = false;
  readonly [kWaitUntil]: Promise<any>[] = [];
  [kSent] = false;

  constructor(public readonly request: Request) {
    super("fetch");
  }

  respondWith(response: MaybePromise<Response | BaseResponse>): void {
    if (this[kResponse]) {
      throw new DOMException(
        "FetchEvent.respondWith() has already been called; it can only be called once.",
        "InvalidStateError"
      );
    }
    if (this[kSent]) {
      throw new DOMException(
        "Too late to call FetchEvent.respondWith(). It must be called synchronously in the event handler.",
        "InvalidStateError"
      );
    }

    this.stopImmediatePropagation();
    this[kResponse] = Promise.resolve(response);
  }

  passThroughOnException(): void {
    this[kPassThrough] = true;
  }

  waitUntil(promise: Promise<any>): void {
    this[kWaitUntil].push(promise);
  }
}

export class ScheduledEvent extends Event {
  readonly [kWaitUntil]: Promise<any>[] = [];

  constructor(
    public readonly scheduledTime: number,
    public readonly cron: string
  ) {
    super("scheduled");
  }

  waitUntil(promise: Promise<any>): void {
    this[kWaitUntil].push(promise);
  }
}

export type ModuleFetchListener = (
  request: Request,
  env: Context,
  ctx: {
    passThroughOnException: () => void;
    waitUntil: (promise: Promise<any>) => void;
  }
) => Response | Promise<Response>;

export type ModuleScheduledListener = (
  controller: { scheduledTime: number; cron: string },
  env: Context,
  ctx: { waitUntil: (promise: Promise<any>) => void }
) => any;

export const kAddModuleFetchListener = Symbol("kAddModuleFetchListener");
export const kAddModuleScheduledListener = Symbol(
  "kAddModuleScheduledListener"
);
export const kDispatchFetch = Symbol("kDispatchFetch");
export const kDispatchScheduled = Symbol("kDispatchScheduled");

export type WorkerGlobalScopeEventMap = {
  fetch: FetchEvent;
  scheduled: ScheduledEvent;
};

export class WorkerGlobalScope extends typedEventTarget<WorkerGlobalScopeEventMap>() {}

export class ServiceWorkerGlobalScope extends WorkerGlobalScope {
  readonly #log: Log;
  readonly #bindings: Context;
  readonly #modules?: boolean;
  readonly #wrappedListeners = new WeakMap<
    TypedEventListener<ValueOf<WorkerGlobalScopeEventMap>>,
    TypedEventListener<ValueOf<WorkerGlobalScopeEventMap>>
  >();
  #wrappedError?: Error;

  // Global self-references
  // noinspection JSUnusedGlobalSymbols
  readonly global = this;
  // noinspection JSUnusedGlobalSymbols
  readonly globalThis = this;
  // noinspection JSUnusedGlobalSymbols
  readonly self = this;

  constructor(
    log: Log,
    globals: Context,
    bindings: Context,
    modules?: boolean
  ) {
    super();
    this.#log = log;
    this.#bindings = bindings;
    this.#modules = modules;

    // Only including bindings in global scope if not using modules
    Object.assign(this, globals);
    if (!modules) Object.assign(this, bindings);

    // Make sure this remains bound when creating VM context
    this.addEventListener = this.addEventListener.bind(this);
    this.removeEventListener = this.removeEventListener.bind(this);
    this.dispatchEvent = this.dispatchEvent.bind(this);
  }

  #wrap<Type extends keyof WorkerGlobalScopeEventMap>(
    listener: TypedEventListener<WorkerGlobalScopeEventMap[Type]> | null
  ): TypedEventListener<WorkerGlobalScopeEventMap[Type]> | null {
    // When an event listener throws, we want dispatching to stop and the
    // error to be thrown so we can catch it and display a nice error page.
    if (!listener) return null;
    let wrappedListener = this.#wrappedListeners.get(listener as any);
    if (wrappedListener) return wrappedListener;
    wrappedListener = (event) => {
      try {
        if ("handleEvent" in listener) {
          listener.handleEvent(event as WorkerGlobalScopeEventMap[Type]);
        } else {
          listener(event as WorkerGlobalScopeEventMap[Type]);
        }
      } catch (error: any) {
        event.stopImmediatePropagation();
        this.#wrappedError = error;
      }
    };
    this.#wrappedListeners.set(listener as any, wrappedListener);
    return wrappedListener;
  }

  #addEventListener<Type extends keyof WorkerGlobalScopeEventMap>(
    type: Type,
    listener: TypedEventListener<WorkerGlobalScopeEventMap[Type]> | null,
    options?: AddEventListenerOptions | boolean
  ): void {
    super.addEventListener(type, this.#wrap(listener), options);
  }

  addEventListener<Type extends keyof WorkerGlobalScopeEventMap>(
    type: Type,
    listener: TypedEventListener<WorkerGlobalScopeEventMap[Type]> | null,
    options?: AddEventListenerOptions | boolean
  ): void {
    if (this.#modules) {
      throw new TypeError(
        "Global addEventListener() cannot be used in modules. Instead, event " +
          "handlers should be declared as exports on the root module."
      );
    }
    this.#addEventListener(type, listener, options);
  }

  removeEventListener<Type extends keyof WorkerGlobalScopeEventMap>(
    type: Type,
    listener: TypedEventListener<WorkerGlobalScopeEventMap[Type]> | null,
    options?: EventListenerOptions | boolean
  ): void {
    if (this.#modules) {
      throw new TypeError(
        "Global removeEventListener() cannot be used in modules. Instead, event " +
          "handlers should be declared as exports on the root module."
      );
    }
    // removeEventListener isn't called internally, so no need for a
    // #removeEventListener to bypass modules mode checking
    super.removeEventListener(type, this.#wrap(listener), options);
  }

  #dispatchEvent(event: ValueOf<WorkerGlobalScopeEventMap>): boolean {
    this.#wrappedError = undefined;
    const result = super.dispatchEvent(event);
    if (this.#wrappedError !== undefined) throw this.#wrappedError;
    return result;
  }

  dispatchEvent(event: ValueOf<WorkerGlobalScopeEventMap>): boolean {
    if (this.#modules) {
      throw new TypeError(
        "Global dispatchEvent() cannot be used in modules. Instead, event " +
          "handlers should be declared as exports on the root module."
      );
    }
    return this.#dispatchEvent(event);
  }

  [kAddModuleFetchListener](listener: ModuleFetchListener): void {
    this.#addEventListener("fetch", (e) => {
      const ctx = {
        passThroughOnException: e.passThroughOnException.bind(e),
        waitUntil: e.waitUntil.bind(e),
      };
      const res = listener(e.request, this.#bindings, ctx);
      e.respondWith(res);
    });
  }

  [kAddModuleScheduledListener](listener: ModuleScheduledListener): void {
    this.#addEventListener("scheduled", (e) => {
      const controller = { cron: e.cron, scheduledTime: e.scheduledTime };
      const ctx = { waitUntil: e.waitUntil.bind(e) };
      const res = listener(controller, this.#bindings, ctx);
      e.waitUntil(Promise.resolve(res));
    });
  }

  async [kDispatchFetch]<WaitUntil extends any[] = unknown[]>(
    request: Request,
    proxy = false
  ): Promise<Response<WaitUntil>> {
    // No need to clone request if not proxying, no chance we'll need to send
    // it somewhere else
    const event = new FetchEvent(proxy ? request.clone() : request);
    try {
      this.#dispatchEvent(event);
      // `event[kResponse]` may be `undefined`, but `await undefined` is still
      // `undefined`
      const response = await event[kResponse];
      if (response !== undefined) {
        // noinspection ES6MissingAwait
        const waitUntil = Promise.all(event[kWaitUntil]) as Promise<WaitUntil>;
        return withWaitUntil(response, waitUntil);
      }
    } catch (e: any) {
      if (event[kPassThrough]) {
        this.#log.warn(e.stack);
      } else {
        throw e;
      }
    } finally {
      event[kSent] = true;
    }

    if (!proxy) {
      // TODO: split this error up, add check for handlers, check type of returns
      throw new TypeError(
        "No fetch handler responded and no upstream to proxy to specified.\n" +
          "Have you added a fetch event listener that responds with a Response?"
      );
    }

    request.headers.delete("host");
    // noinspection ES6MissingAwait
    const waitUntil = Promise.all(event[kWaitUntil]) as Promise<WaitUntil>;
    return withWaitUntil(await fetch(request), waitUntil);
  }

  async [kDispatchScheduled]<WaitUntil extends any[] = any[]>(
    scheduledTime?: number,
    cron?: string
  ): Promise<WaitUntil> {
    const event = new ScheduledEvent(scheduledTime ?? Date.now(), cron ?? "");
    this.#dispatchEvent(event);
    return (await Promise.all(event[kWaitUntil])) as WaitUntil;
  }
}