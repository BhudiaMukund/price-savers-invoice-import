/**
 * Streaming helpers. Cloudflare's free plan allows ~10 ms of CPU per request, so file bodies are passed
 * through as streams (never decoded or copied into memory) on their way to Google or Shopify.
 */

/** Concatenate prefix + streamed body + suffix without buffering the middle. */
export function sandwich(prefix: Uint8Array, middle: ReadableStream<Uint8Array>, suffix: Uint8Array): ReadableStream<Uint8Array> {
  const reader = middle.getReader();
  let stage = 0;
  return new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      if (stage === 0) {
        stage = 1;
        ctrl.enqueue(prefix);
        return;
      }
      if (stage === 1) {
        const { done, value } = await reader.read();
        if (!done) {
          if (value && value.byteLength) ctrl.enqueue(value);
          return;
        }
        stage = 2;
      }
      ctrl.enqueue(suffix);
      ctrl.close();
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

declare const FixedLengthStream: undefined | (new (length: number) => TransformStream<Uint8Array, Uint8Array>);

/**
 * A request body made of prefix + stream + suffix with a known total length. On Workers it's wrapped in a
 * FixedLengthStream so the upstream gets a real Content-Length (some, like Google Cloud Storage, require it).
 */
export function streamedBody(
  prefix: Uint8Array,
  middle: ReadableStream<Uint8Array>,
  middleLength: number,
  suffix: Uint8Array,
): { body: ReadableStream<Uint8Array>; length: number; duplex?: "half" } {
  const body = sandwich(prefix, middle, suffix);
  const length = prefix.byteLength + middleLength + suffix.byteLength;
  if (typeof FixedLengthStream !== "undefined") {
    const fixed = new FixedLengthStream(length);
    body.pipeTo(fixed.writable).catch(() => {});
    return { body: fixed.readable, length };
  }
  return { body, length, duplex: "half" }; // Node (tests, demo)
}
