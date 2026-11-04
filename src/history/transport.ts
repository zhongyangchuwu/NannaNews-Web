/** Fetch transparently decodes HTTP Content-Encoding; static hosts may instead serve raw .gz bytes. */
export async function historyText(response: Response): Promise<string> {
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const stream = new ReadableStream<BufferSource>({
      start(controller) { controller.enqueue(bytes); controller.close(); },
    });
    return new Response(stream.pipeThrough(new DecompressionStream('gzip'))).text();
  }
  if (!response.headers.get('content-encoding')?.split(',').some(value => value.trim().toLowerCase() === 'gzip')) {
    throw new Error('历史资源不是 gzip 数据。');
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}
