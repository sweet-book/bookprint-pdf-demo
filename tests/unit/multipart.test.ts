import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildFileMultipart } from '../../src/bookprint/index.js';

async function collect(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const c of stream as unknown as AsyncIterable<Uint8Array>) parts.push(Buffer.from(c));
  return Buffer.concat(parts);
}

async function* bytes(...chunks: string[]): AsyncGenerator<Uint8Array> {
  for (const c of chunks) yield Buffer.from(c, 'utf8');
}

test('multipart 조립 — 머리·파일·꼬리 순서, Content-Length 가 실제 바이트 수와 같다', async () => {
  const content = '%PDF-1.4 fake';
  const mp = buildFileMultipart(
    {
      fieldName: 'file',
      filename: 'cover.pdf',
      contentType: 'application/pdf',
      size: Buffer.byteLength(content),
      open: () => bytes('%PDF-', '1.4 fake'),
    },
    { boundary: 'B' },
  );
  const body = await collect(mp.body);
  const expected =
    '--B\r\nContent-Disposition: form-data; name="file"; filename="cover.pdf"\r\nContent-Type: application/pdf\r\n\r\n' +
    content +
    '\r\n--B--\r\n';
  assert.equal(body.toString('utf8'), expected);
  assert.equal(mp.contentLength, body.byteLength);
  assert.equal(mp.contentType, 'multipart/form-data; boundary=B');
});

test('파일명의 따옴표·줄바꿈은 헤더를 깨뜨리지 못한다', async () => {
  const mp = buildFileMultipart(
    {
      fieldName: 'file',
      filename: 'a"b\r\nc.pdf',
      contentType: 'application/pdf',
      size: 0,
      open: () => bytes(),
    },
    { boundary: 'B' },
  );
  const body = (await collect(mp.body)).toString('utf8');
  assert.ok(body.includes('filename="a_b__c.pdf"'));
});

test('open() 은 호출마다 새 스트림을 연다 — 같은 정의로 두 번 조립할 수 있다', async () => {
  let opened = 0;
  const part = {
    fieldName: 'file',
    filename: 'x.pdf',
    contentType: 'application/pdf',
    size: 3,
    open: () => {
      opened += 1;
      return bytes('abc');
    },
  };
  await collect(buildFileMultipart(part, { boundary: 'B' }).body);
  await collect(buildFileMultipart(part, { boundary: 'B' }).body);
  assert.equal(opened, 2);
});
