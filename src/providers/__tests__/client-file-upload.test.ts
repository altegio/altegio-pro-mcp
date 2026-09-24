import { AltegioClient } from '../altegio-client.js';
import {
  CLIENT_FILE_MAX_BYTES,
  prepareClientFile,
} from '../client-file-upload.js';
import {
  requestContextFromHeaders,
  runWithContext,
} from '../../request-context.js';

describe('client-file upload boundary', () => {
  it('accepts canonical bytes and rejects paths, extensions, malformed base64, and the exact size cap', () => {
    expect(prepareClientFile('signed.PDF', 'AAEC')).toMatchObject({
      bytes: Buffer.from([0, 1, 2]),
      mime: 'application/pdf',
    });
    for (const name of ['../x.pdf', 'a\\b.pdf', 'x.exe', 'x\n.pdf']) {
      expect(() => prepareClientFile(name, 'AAEC')).toThrow();
    }
    for (const value of ['AAE', 'data:application/pdf;base64,AAEC', '']) {
      expect(() => prepareClientFile('x.pdf', value)).toThrow();
    }
    expect(prepareClientFile('x.pdf', 'AAE=').bytes).toEqual(
      Buffer.from([0, 1])
    );
    expect(() =>
      prepareClientFile(
        'x.pdf',
        Buffer.alloc(CLIENT_FILE_MAX_BYTES).toString('base64')
      )
    ).toThrow();
    expect(
      prepareClientFile(
        'x.pdf',
        Buffer.alloc(CLIENT_FILE_MAX_BYTES - 1).toString('base64')
      ).bytes
    ).toHaveLength(CLIENT_FILE_MAX_BYTES - 1);
  });

  it('sends only authenticated multipart file bytes to the documented path', async () => {
    const originalFetch = global.fetch;
    const bytes = Buffer.from([0, 1, 2, 255]);
    const seen: Array<{ url: string; init: RequestInit }> = [];
    global.fetch = jest.fn(async (input, init) => {
      seen.push({ url: String(input), init: init! });
      return new Response(
        JSON.stringify({
          success: true,
          data: [{ id: 91, name: 'signed.pdf' }],
        }),
        {
          headers: { 'content-type': 'application/json' },
        }
      );
    }) as typeof fetch;
    try {
      const client = new AltegioClient({
        partnerToken: 'partner',
        userToken: 'user',
      });
      const result = await runWithContext(
        requestContextFromHeaders({ 'x-altegio-company-id': '7' }),
        () =>
          client.uploadClientFile(7, 8, 'signed.pdf', bytes.toString('base64'))
      );
      expect(result).toEqual([{ id: 91, name: 'signed.pdf' }]);
      expect(seen).toHaveLength(1);
      expect(seen[0]!.url).toBe(
        'https://api.alteg.io/api/v1/company/7/clients/files/8'
      );
      expect(seen[0]!.init.method).toBe('POST');
      expect(
        (seen[0]!.init.headers as Record<string, string>).Authorization
      ).toContain('User user');
      expect(
        (seen[0]!.init.headers as Record<string, string>)['Content-Type']
      ).toBeUndefined();
      const part = (seen[0]!.init.body as FormData).get('file') as File;
      expect(part.name).toBe('signed.pdf');
      expect(part.type).toBe('application/pdf');
      expect(Buffer.from(await part.arrayBuffer())).toEqual(bytes);
      await expect(
        runWithContext(
          requestContextFromHeaders({ 'x-altegio-company-id': '9' }),
          () =>
            client.uploadClientFile(
              7,
              8,
              'signed.pdf',
              bytes.toString('base64')
            )
        )
      ).rejects.toThrow();
      expect(seen).toHaveLength(1);
    } finally {
      global.fetch = originalFetch;
    }
  });
});
