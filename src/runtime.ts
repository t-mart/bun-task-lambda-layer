type HandlerFunction = (payload: unknown) => Promise<unknown>;

function exit(...cause: unknown[]): never {
  console.error(...cause);
  process.exit(1);
}

function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback ?? null;
  if (value === null) {
    exit(`Runtime failed to find the '${name}' environment variable`);
  }
  return value;
}

const runtimeUrl = new URL(
  `http://${env("AWS_LAMBDA_RUNTIME_API")}/2018-06-01/runtime/`
);

async function lambdaFetch(
  url: string,
  options?: RequestInit
): Promise<Response> {
  const { href } = new URL(url, runtimeUrl);
  const response = await fetch(href, options);
  if (!response.ok) {
    exit(
      `Runtime failed to send request to Lambda [status: ${response.status}]`
    );
  }
  return response;
}

type LambdaError = {
  readonly errorType: string;
  readonly errorMessage: string;
  readonly stackTrace?: string[];
};

type SerializableError = Error | { type: string; cause: unknown };

function isSerializableError(error: unknown): error is SerializableError {
  return (
    error instanceof Error ||
    (typeof error === "object" &&
      error !== null &&
      "type" in error &&
      "cause" in error)
  );
}

function formatError(error: SerializableError): LambdaError {
  if (error instanceof Error) {
    return {
      errorType: error.name,
      errorMessage: error.message,
      stackTrace: error.stack?.split("\n"),
    };
  }
  return {
    errorType: error.type,
    errorMessage: Bun.inspect(error.cause),
  };
}

/**
 * Fetches the next invocation event from AWS Lambda.
 * This request blocks until an event is available.
 */
async function fetchNextInvocation() {
  return await lambdaFetch(`invocation/next`);
}

/**
 * Sends the handler's response back to AWS Lambda.
 */
async function sendInvocationResponse(requestId: string, body: string | null) {
  return await lambdaFetch(`invocation/${requestId}/response`, {
    method: "POST",
    body,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

async function sendBaseError(url: string, error: SerializableError) {
  const formatted = formatError(error);
  return await lambdaFetch(url, {
    method: "POST",
    body: JSON.stringify(formatted),
    headers: {
      "Lambda-Runtime-Function-Error-Type": formatted.errorType,
      "Content-Type": "application/vnd.aws.lambda.error+json",
    },
  });
}

/**
 * Sends an initialization error to AWS Lambda if something goes wrong outside the handler
 */
async function sendInitError(error: SerializableError) {
  return await sendBaseError(`init/error`, error);
}

/**
 * Reports an error inside the handler to AWS Lambda.
 */
async function sendInvocationError(
  requestId: string,
  error: SerializableError
) {
  return await sendBaseError(`invocation/${requestId}/error`, error);
}

async function throwError(
  error: SerializableError,
  requestId?: string
): Promise<never> {
  console.error(error);
  await (requestId !== undefined
    ? sendInvocationError(requestId, error)
    : sendInitError(error));
  exit();
}

/**
 * Initializes the handler function from the file specified in the _HANDLER
 * environment variable.
 *
 * Given a _HANDLER value of "fileName.moduleName", this function will import
 * the file at `${LAMBDA_TASK_ROOT}/fileName` and return the default export or
 * the named export "moduleName".
 *
 * @returns The handler function to execute
 */
async function init(): Promise<HandlerFunction> {
  const handlerName = env("_HANDLER");
  const index = handlerName.lastIndexOf(".");
  const fileName = handlerName.substring(0, index);
  const filePath = `${env("LAMBDA_TASK_ROOT")}/${fileName}`;
  let file;
  try {
    file = await import(filePath);
  } catch (cause) {
    if (
      cause instanceof Error &&
      cause.message.startsWith("Cannot find module")
    ) {
      return throwError({
        type: "FileDoesNotExist",
        cause: `Did not find a file named '${fileName}'`,
      });
    }
    return throwError({ type: "InitError", cause });
  }
  const moduleName = handlerName.substring(index + 1);
  // prefer the default export if it exists
  const handler = file["default"] ?? file[moduleName];
  if (typeof handler !== "function") {
    return throwError({
      type:
        handler === undefined ? "MethodDoesNotExist" : "MethodIsNotAFunction",
      cause: `${fileName} does not an function export '${moduleName}' (handler is ${handler})`,
    });
  }
  return handler;
}

type LambdaRequest<E = unknown> = {
  readonly requestId: string;
  readonly traceId: string;
  readonly deadlineMs: number | null;
  readonly event: E;
};

function setTraceId(traceId: string) {
  process.env["_X_AMZN_TRACE_ID"] = traceId;
}

function resetTraceId() {
  delete process.env["_X_AMZN_TRACE_ID"];
}

async function receiveRequest(): Promise<LambdaRequest> {
  const response = await fetchNextInvocation();
  const requestId =
    response.headers.get("Lambda-Runtime-Aws-Request-Id") ?? undefined;
  if (requestId === undefined) {
    exit("Runtime received a request without a request ID");
  }
  const traceId = response.headers.get("Lambda-Runtime-Trace-Id") ?? undefined;
  if (traceId === undefined) {
    exit("Runtime received a request without a trace ID");
  }
  const deadlineMs =
    parseInt(response.headers.get("Lambda-Runtime-Deadline-Ms") ?? "0") || null;
  let event;
  try {
    event = await response.json();
  } catch (cause) {
    exit("Runtime received a request with invalid JSON", cause);
  }
  return {
    requestId,
    traceId,
    deadlineMs,
    event,
  };
}

const lambda = await init();
while (true) {
  const { requestId, event, traceId, deadlineMs } = await receiveRequest();

  const durationMs = Math.max(
    1,
    (deadlineMs === null ? Date.now() + 60_000 : deadlineMs) - Date.now()
  );

  setTraceId(traceId);

  let result:
    | { timeout: true; data: unknown }
    | { timeout: false; data: unknown };
  try {
    result = await Promise.race([
      lambda(event).then((data) => ({ data, timeout: false })),

      // the lambda service doesn't strictly need to be notified by us about
      // timeout (it will consider the function timed out if we don't respond in
      // time). but, if we do this here, we can accept other events more
      // quickly.
      new Promise<undefined>((resolve) => setTimeout(resolve, durationMs)).then(
        () => ({ data: null, timeout: true })
      ),
    ]);
  } catch (cause) {
    let se = cause;
    if (!isSerializableError(se)) {
      se = { type: "UnknownError", cause };
    }
    await sendInvocationError(requestId, se as SerializableError);
    continue;
  } finally {
    resetTraceId();
  }

  if (result.timeout) {
    await sendInvocationError(requestId, {
      type: "TimeoutError",
      cause: `Function timed out after ${durationMs}ms`,
    });
    continue;
  }

  const { data: data } = result;

  await sendInvocationResponse(
    requestId,
    data === null
      ? null
      : typeof data === "string"
      ? data
      : JSON.stringify(data)
  );
}
