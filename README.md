# bun-task-lambda-layer

An AWS Lambda Layer for running Bun tasks.

This is a derivation of
[Bun's official AWS Lambda layer](https://github.com/oven-sh/bun/tree/main/packages/bun-lambda),
but designed for non-HTTP workloads. In particular:

- The handler is not passed a Request object, but instead passed the Lambda
  (JSON) payload directly.
- The handler is not expected to return a Response object, but instead return
  the result directly.
- If the handler throws an error, such an error is reported to Lambda such that
  the invocation will be considered a failure. (The official Bun layer considers
  this invocation successful and leaves it to the response object to indicate
  failure.). This can be helpful for, for example, monitoring and alerting on
  Cloudwatch.

## Publishing this layer to your account

To make this layer available to a lambda function, you must publish it to AWS:

```sh
git clone https://github.com/t-mart/bun-task-lambda-layer.git
cd bun-task-lambda-layer
bun install
bun run publish-layer
```

This script has a variety of options. See `scripts/build-layer.ts` for more
information.

**This script can be safely run multiple times.** It will only create a new
version of the layer.

By default, this layer will be compatible with the `arm64` architecture. If you
need to publish a layer for `x64`, you can do so with the `--arch x64` flag:

```sh
bun run publish-layer --arch x64
```

## Adding to a Lambda Function

To use this layer, first locate/create a Lambda function that uses the "Amazon
Linux 2" runtime and uses the architecture for which this layer was
built/published (either `arm64` or `x64`).

Then, in the Lambda UI, add a layer to the function. It is called `bun-task` by
default.

### Handler Function

This layer can run bun code, with or without transpiling. Simply specify your
handler as `<fileName>.<methodName>`. For example, to set it to the default
export in the file `main.ts`, use `main.default`.

The handler function is provided one argument: the JSON-parsed payload object.
(Therefore, it is critical that invocations of this Lambda be done with valid
JSON, or else the layer will fail.)

The handler function will be awaited and can return anything back to the Lambda
invoker. If it is a null, nothing will be returned. If it is a string (such as
something that has been pre-JSON-serialized), it will be returned as a string.
If it is an object, it will be JSON-serialized and returned.

If you would like, you can use this type to define your handler function:

```typescript
type HandlerFunction = (payload: any) => any;
```

As an example, here's code that could run on with this layer:

For example:

```typescript
// main.ts
export default async function (payload: any) {
  const name = payload["name"] ?? "World";
  return `Hello ${name}`;
}
```
